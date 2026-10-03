/**
 * A Rust "makes" arrow is answered from the compiler's build when the text
 * finds no construction (#396).
 *
 * The bad outcome: json's `parse_number` builds a `ParserNumber` on almost
 * every line, as `ParserNumber::F64(tri!(..))`, and an arrow saying so stayed
 * "not sure" forever. The text stops at the macro, and an enum variant reads
 * as a call. rustc's build writes both as a value built in place.
 *
 * The risk is a green that isn't so: a B handed back by `B::new()` is B's own
 * routine making one, and `Kind::ZERO` reads a constant. Neither confirms.
 *
 * One crate, one build for every board. Needs `cargo`.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

const LIB = [
  "pub mod json;\npub mod adhoc;\npub mod parse;\npub mod ids;",
  "",
].join("\n");

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "makes"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nstd = []\n',
  "src/lib.rs": LIB,
  // json's `de.rs`: the variant is built inside the macro's argument.
  "src/json.rs": [
    "macro_rules! tri {\n    ($e:expr) => {\n        match $e {\n            Ok(v) => v,\n            Err(e) => return Err(e),\n        }\n    };\n}",
    "pub enum ParserNumber {\n    F64(f64),\n    U64(u64),\n}",
    "pub fn parse_number(x: Result<f64, ()>) -> Result<ParserNumber, ()> {\n    Ok(ParserNumber::F64(tri!(x)))\n}",
    "",
  ].join("\n\n"),
  // anyhow's `error.rs`: the struct literal beside it carries a `#[cfg]` field.
  "src/adhoc.rs": [
    "pub struct MessageError(pub u8);",
    "pub struct ContextError {\n    pub context: u8,\n}",
    "pub struct VTable {\n    pub drop: u8,\n    #[cfg(feature = \"std\")]\n    pub backtrace: u8,\n}",
    "pub fn construct_from_adhoc(message: u8) -> (MessageError, VTable) {\n"
      + "    let vtable = VTable {\n        drop: 1,\n        #[cfg(feature = \"std\")]\n        backtrace: 2,\n    };\n"
      + "    (MessageError(message), vtable)\n}",
    "",
  ].join("\n\n"),
  // regex's `parser.rs`: an enum variant, and no macro at all.
  "src/parse.rs": [
    "pub enum Primitive {\n    Dot(u8),\n    Literal(char),\n}",
    "pub fn parse_primitive(c: char) -> Primitive {\n    if c == '.' {\n        Primitive::Dot(0)\n    } else {\n        Primitive::Literal(c)\n    }\n}",
    "",
  ].join("\n\n"),
  // regex's `StateID::ZERO`, and a B handed back by B's own routine.
  "src/ids.rs": [
    "#[derive(Clone, Copy)]\npub struct StateID(pub u32);",
    "impl StateID {\n    pub const ZERO: StateID = StateID(0);\n}",
    "pub fn start() -> u32 {\n    let id = StateID::ZERO;\n    id.0\n}",
    "pub struct Gear {\n    pub teeth: u8,\n}",
    "impl Gear {\n    pub fn new() -> Gear {\n        Gear { teeth: 3 }\n    }\n}",
    "pub fn teeth() -> u8 {\n    Gear::new().teeth\n}",
    // regex's `translate.rs`: the variant shares its name with the struct it wraps.
    "pub struct ClassBytes {\n    pub ranges: Vec<u8>,\n}",
    "pub enum Frame {\n    ClassBytes(ClassBytes),\n    Empty,\n}",
    "pub fn rewrap(frame: Frame) -> Frame {\n    match frame {\n        Frame::ClassBytes(cls) => Frame::ClassBytes(cls),\n        other => other,\n    }\n}",
    "",
  ].join("\n\n"),
};

let repo: string;
let broken: string;
let cache: string;
const previousCache = process.env.DIAGRAMOS_RUSTC_CACHE;

interface Answer {
  confirmed: number;
  red?: string;
}

async function boardFor(from: string, to: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "makes",
    nodes: [
      { id: "a", label: from.split("#")[1]!, ref: from },
      { id: "b", label: to.split("#")[1]!, ref: to },
    ],
    edges: [{ from: "a", to: "b", claim: "builds" }],
  });
  return board as BoardFile;
}

function answerOf(report: DriftReport): Answer {
  const red = report.edges.find((finding) => ACCUSES.has(finding.kind));
  return {
    confirmed: report.claims.buildsConfirmed,
    ...(red ? { red: `${red.kind}: ${red.detail}` } : {}),
  };
}

/** One `@builds` arrow, checked the way a live check does: rustc's bodies when the crate builds. */
async function check(root: string, from: string, to: string): Promise<Answer> {
  const board = await boardFor(from, to);
  const workspace = createWorkspace(root);
  const live = await refereedCheckLive(root, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return answerOf(live.report);
}

/** The same arrow with no compiler at all: what the check said before #396. */
async function textOnly(root: string, from: string, to: string): Promise<Answer> {
  return answerOf(checkDrift(await boardFor(from, to), createWorkspace(root), { edges: true }));
}

function write(root: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

beforeAll(async () => {
  await initEngine();
  cache = mkdtempSync(path.join(tmpdir(), "rustc-cache-"));
  process.env.DIAGRAMOS_RUSTC_CACHE = cache;
  repo = mkdtempSync(path.join(tmpdir(), "builds-compiled-"));
  write(repo, FILES);
  // The same code in a crate that does not compile: there is no build to ask.
  broken = mkdtempSync(path.join(tmpdir(), "builds-broken-"));
  write(broken, { ...FILES, "src/lib.rs": `${LIB}pub fn oops() -> u8 {\n    "not a number"\n}\n` });
}, 60_000);

afterAll(() => {
  if (previousCache === undefined) delete process.env.DIAGRAMOS_RUSTC_CACHE;
  else process.env.DIAGRAMOS_RUSTC_CACHE = previousCache;
  rmSync(cache, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
  rmSync(broken, { recursive: true, force: true });
});

describe.skipIf(!HAS_CARGO)("Rust: a construction the text cannot see is confirmed from the build", () => {
  it("confirms an enum variant built inside a macro (json's parse_number -> ParserNumber)", async () => {
    expect(await check(repo, "src/json.rs#parse_number", "src/json.rs#ParserNumber")).toEqual({ confirmed: 1 });
  }, 240_000);

  it("confirms a tuple struct built beside a struct literal with a #[cfg] field (anyhow's construct_from_adhoc)", async () => {
    expect(await check(repo, "src/adhoc.rs#construct_from_adhoc", "src/adhoc.rs#MessageError")).toEqual({ confirmed: 1 });
  }, 240_000);

  it("is red on a type that routine never builds (construct_from_adhoc -> ContextError)", async () => {
    const answer = await check(repo, "src/adhoc.rs#construct_from_adhoc", "src/adhoc.rs#ContextError");
    expect(answer.confirmed).toBe(0);
    expect(answer.red).toMatch(/^builds-refuted: .*never creates one/);
  }, 240_000);

  it("confirms an enum variant with no macro (regex's parse_primitive -> Primitive)", async () => {
    expect(await check(repo, "src/parse.rs#parse_primitive", "src/parse.rs#Primitive")).toEqual({ confirmed: 1 });
  }, 240_000);
});

describe.skipIf(!HAS_CARGO)("Rust: what the build shows that is not a construction", () => {
  it("does not confirm a routine that only reads a constant (StateID::ZERO)", async () => {
    expect((await check(repo, "src/ids.rs#start", "src/ids.rs#StateID")).confirmed).toBe(0);
  }, 240_000);

  it("does not confirm a struct an enum variant of the same name only wraps (regex's HirFrame::ClassBytes)", async () => {
    expect((await check(repo, "src/ids.rs#rewrap", "src/ids.rs#ClassBytes")).confirmed).toBe(0);
    expect((await check(repo, "src/ids.rs#rewrap", "src/ids.rs#Frame")).confirmed).toBe(1);
  }, 240_000);

  it("does not confirm a routine that only gets one back from B::new()", async () => {
    expect((await check(repo, "src/ids.rs#teeth", "src/ids.rs#Gear")).confirmed).toBe(0);
  }, 240_000);
});

describe.skipIf(!HAS_CARGO)("Rust: with no build, the answer is what it was", () => {
  const ARROWS: Array<[string, string]> = [
    ["src/json.rs#parse_number", "src/json.rs#ParserNumber"],
    ["src/adhoc.rs#construct_from_adhoc", "src/adhoc.rs#MessageError"],
    ["src/adhoc.rs#construct_from_adhoc", "src/adhoc.rs#ContextError"],
    ["src/parse.rs#parse_primitive", "src/parse.rs#Primitive"],
  ];

  it("answers a crate that does not compile exactly as the text alone does", async () => {
    for (const [from, to] of ARROWS) {
      const text = await textOnly(broken, from, to);
      expect(text).toEqual({ confirmed: 0 });
      expect(await check(broken, from, to)).toEqual(text);
    }
  }, 480_000);
});
