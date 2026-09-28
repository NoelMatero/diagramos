/**
 * The compiler's call list is kept when build settings switch off code that
 * cannot call the head, and a function named as a value is not a call (#366,
 * section 5).
 *
 * anyhow's `construct_from_std` builds a vtable literal with one
 * `#[cfg(..)]` field and several `object_drop::<E>` function pointers. Any
 * `cfg` in the body threw rustc's list away, and the text reading counted
 * each `name::<T>` as a call rustc rightly does not list -- so the list was
 * "untrusted" twice over, and 7 wrong arrows (anyhow 5, clap 2) stayed quiet
 * although rustc says the head is never called.
 *
 * A switched-off region now blocks only when it names the head or holds a
 * macro. `cfg` on the routine, on what holds it, `cfg!()` and `cfg_attr` still
 * block the whole list.
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
import { refereedCheckLive, type LiveCheck, type LiveOptions } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "gates"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nextra = []\n',
  "src/lib.rs":
    "macro_rules! ok {\n    ($e:expr) => {\n        $e\n    };\n}\n\npub mod callers;\npub mod helpers;\n",
  "src/helpers.rs":
    "pub fn helper() -> u8 {\n    1\n}\n\npub fn unrelated() -> u8 {\n    2\n}\n\n"
    + "pub fn drop_it<T>() -> u8 {\n    3\n}\n\npub fn keep<T>() -> u8 {\n    4\n}\n",
  "src/callers.rs": [
    "use crate::helpers::{drop_it, helper, keep, unrelated};",
    "",
    "pub struct Table {\n    pub run: fn() -> u8,\n    #[cfg(feature = \"extra\")]\n    pub extra: u8,\n}",
    "pub struct Flags {\n    pub on: bool,\n    #[cfg(feature = \"extra\")]\n    pub extra: u8,\n}",
    "pub struct Ops {\n    pub run: fn() -> u8,\n}",
    // anyhow's shape: a literal with a switched-off field and a function pointer.
    "#[cfg(not(feature = \"extra\"))]\npub fn vtable<E>() -> Table {\n    let _n = ok!(helper());\n    Table {\n        run: drop_it::<E>,\n"
      + "        #[cfg(feature = \"extra\")]\n        extra: 1,\n    }\n}",
    "pub fn statement() -> u8 {\n    #[cfg(feature = \"extra\")]\n    let _x = 1;\n    ok!(helper())\n}",
    "pub fn field() -> Flags {\n    let _n = ok!(helper());\n    Flags {\n        on: true,\n"
      + "        #[cfg(feature = \"extra\")]\n        extra: 1,\n    }\n}",
    // `&Ops { .. }` is promoted to a constant of its own, so the pointer is in no body rustc lists.
    "pub fn pointer<E>() -> u8 {\n    let _ops = &Ops { run: keep::<E> };\n    ok!(helper())\n}",
    "#[cfg(not(feature = \"extra\"))]\npub fn only_here() -> u8 {\n    ok!(helper())\n}",
    "pub fn names_head() -> u8 {\n    #[cfg(feature = \"extra\")]\n    let _x = unrelated();\n    ok!(helper())\n}",
    "pub fn holds_macro() -> u8 {\n    #[cfg(feature = \"extra\")]\n    let _x = ok!(3);\n    ok!(helper())\n}",
    "pub fn asks_cfg() -> u8 {\n    if cfg!(feature = \"extra\") {\n        return 5;\n    }\n    ok!(helper())\n}",
    "#[cfg(not(feature = \"extra\"))]\npub fn gated() -> u8 {\n    ok!(helper())\n}",
    "#[cfg(feature = \"extra\")]\npub fn gated() -> u8 {\n    ok!(unrelated())\n}",
    "pub fn attr() -> u8 {\n    #[cfg_attr(feature = \"extra\", allow(unused))]\n    let _x = 1;\n    ok!(helper())\n}",
    "",
  ].join("\n\n"),
};

const C = "src/callers.rs#";
const H = "src/helpers.rs#";

/** Wrong arrows whose tail's own calls are inside a macro, so only rustc's list can say so. */
const WRONG: Array<[string, string, string]> = [
  ["anyhow's shape: a gated routine, a switched-off field, a generic function pointer", `${C}vtable`, `${H}unrelated`],
  ["cfg on a routine with no twin", `${C}only_here`, `${H}unrelated`],
  ["a switched-off statement that names nothing", `${C}statement`, `${H}unrelated`],
  ["a switched-off field in a literal", `${C}field`, `${H}unrelated`],
  ["a generic function stored in a borrowed literal", `${C}pointer`, `${H}unrelated`],
];

/** Arrows that must stay quiet: the switched-off code could be the call, or rustc's list is one setting's. */
const QUIET: Array<[string, string, string]> = [
  ["a switched-off statement that calls the head", `${C}names_head`, `${H}unrelated`],
  ["a switched-off statement holding a macro", `${C}holds_macro`, `${H}unrelated`],
  ["cfg!() in the body", `${C}asks_cfg`, `${H}unrelated`],
  ["cfg on a routine a setting swaps for a twin", `${C}gated`, `${H}unrelated`],
  ["cfg_attr in the body", `${C}attr`, `${H}unrelated`],
  ["the function stored as a value is the head", `${C}vtable`, `${H}drop_it`],
];

let repo: string;
let cache: string;
const previousCache = process.env.DIAGRAMOS_RUSTC_CACHE;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function check(arrows: Array<[string, string]>, options: LiveOptions = {}): Promise<LiveCheck> {
  const ids = new Map<string, string>();
  const id = (ref: string) => {
    if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
    return ids.get(ref)!;
  };
  const edges = arrows.map(([from, to]) => ({ from: id(from), to: id(to), claim: "calls" as const }));
  const { board } = await createDiagram(emptyBoard(), {
    name: "shapes",
    nodes: [...ids].map(([ref, one]) => ({ id: one, label: `${ref.split("#")[1]} ${one}`, ref })),
    edges,
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }), options);
  // Name each red by its refs, so an assertion reads as the arrow it is about.
  const byId = new Map([...ids].map(([ref, one]) => [one, ref]));
  (live as LiveCheck & { red: Set<string> }).red = new Set(live.report.edges
    .filter((finding) => ACCUSES.has(finding.kind))
    .map((finding) => {
      const [from, to] = (finding as { node: string }).node.split(" -> ");
      return `${byId.get(from!)} -> ${byId.get(to!)}`;
    }));
  return live;
}

const redOf = (live: LiveCheck): Set<string> => (live as LiveCheck & { red: Set<string> }).red;

beforeAll(async () => {
  await initEngine();
  cache = mkdtempSync(path.join(tmpdir(), "rustc-cache-"));
  process.env.DIAGRAMOS_RUSTC_CACHE = cache;
}, 60_000);

afterAll(() => {
  if (previousCache === undefined) delete process.env.DIAGRAMOS_RUSTC_CACHE;
  else process.env.DIAGRAMOS_RUSTC_CACHE = previousCache;
  rmSync(cache, { recursive: true, force: true });
});

describe.skipIf(!HAS_CARGO)("Rust @calls: build settings and function values", () => {
  let live: LiveCheck;

  beforeAll(async () => {
    repo = mkdtempSync(path.join(tmpdir(), "calls-compiled-cfg-"));
    write(FILES);
    live = await check([...WRONG, ...QUIET].map(([, from, to]) => [from, to] as [string, string]));
  }, 180_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("says the Rust compiler checked the board", () => {
    expect(live.checkedWith.answered).toContain("rustc");
  });

  describe("goes red", () => {
    for (const [shape, from, to] of WRONG) {
      it(shape, () => {
        expect(redOf(live)).toContain(`${from} -> ${to}`);
      });
    }
  });

  describe("stays quiet", () => {
    for (const [shape, from, to] of QUIET) {
      it(shape, () => {
        expect(redOf(live)).not.toContain(`${from} -> ${to}`);
      });
    }
  });
});
