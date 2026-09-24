/**
 * A Rust arrow is checked against the compiler's own call list (#357).
 *
 * The bad outcome: a wrong `@calls` arrow on a Rust board passed without a
 * word whenever the routine it starts at made its calls inside a macro --
 * `ok!(helper())` -- because the text cannot see into one. rustc's MIR can.
 *
 * The risk is the opposite outcome, a correct arrow called wrong, and each
 * `it` under "stays quiet" is one way the compiler's list could miss a call
 * that happens: through a trait, an operator, `?`, a drop, formatting, a
 * closure, an async body, a function handed on by name, a function pointer,
 * code a build setting switches, a binary target. The shapes come from the
 * review on #357 and from reading what rustc 1.93 prints for each.
 *
 * Four of those -- `a + b`, a drop, `?` and `map(double)` -- were already
 * red on main with no macro anywhere, once rust-analyzer placed every other
 * call. They are here too, in the `2` routines.
 *
 * One crate, one board, one build for the lot. Needs `cargo`; rust-analyzer
 * is used when present and not needed.
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
  "Cargo.toml": '[package]\nname = "shapes"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nextra = []\n',
  "src/lib.rs":
    "macro_rules! ok {\n    ($e:expr) => {\n        $e\n    };\n}\n\n"
    + "pub mod callers;\npub mod helpers;\npub mod transport;\npub mod values;\n",
  "src/helpers.rs":
    "pub fn helper() -> u8 {\n    1\n}\n\npub fn unrelated() -> u8 {\n    2\n}\n\n"
    + "pub fn double(x: u8) -> u8 {\n    x * 2\n}\n\n"
    + "pub fn ping(n: u8) -> u8 {\n    if n == 0 {\n        return 0;\n    }\n    ok!(pong(n - 1))\n}\n\n"
    + "pub fn pong(n: u8) -> u8 {\n    ping(n)\n}\n",
  "src/transport.rs":
    "pub trait Transport {\n    fn handle(&self) -> u8;\n}\n\npub struct Http;\n\n"
    + "impl Transport for Http {\n    fn handle(&self) -> u8 {\n        1\n    }\n}\n\n"
    + "pub trait Runner {\n    fn run(&self) -> u8 {\n        ok!(crate::helpers::helper())\n    }\n}\n\n"
    + "pub trait Sender {\n    fn deliver(&self) -> u8;\n\n    fn send_all(&self) -> u8 {\n        ok!(self.deliver())\n    }\n}\n\n"
    + "impl Sender for Http {\n    fn deliver(&self) -> u8 {\n        2\n    }\n}\n",
  "src/values.rs":
    "use std::ops::Add;\n\n#[derive(Clone, Copy)]\npub struct V(pub i32);\n\n"
    + "impl Add for V {\n    type Output = V;\n    fn add(self, other: V) -> V {\n        V(self.0 + other.0)\n    }\n}\n\n"
    + "pub struct E;\n\nimpl From<std::num::ParseIntError> for E {\n    fn from(_: std::num::ParseIntError) -> E {\n        E\n    }\n}\n\n"
    + "pub struct Guard;\n\nimpl Drop for Guard {\n    fn drop(&mut self) {}\n}\n\n"
    + "pub struct Report;\n\nimpl std::fmt::Display for Report {\n"
    + "    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {\n        f.write_str(\"report\")\n    }\n}\n",
  "src/callers.rs": [
    "use crate::helpers::{double, helper};",
    "use crate::transport::Transport;",
    "use crate::values::{Guard, Report, E, V};",
    "",
    "pub fn wrapped() -> u8 {\n    ok!(helper())\n}",
    "pub fn send<T: Transport>(t: &T) -> u8 {\n    ok!(t.handle())\n}",
    "pub fn send_dyn(t: &dyn Transport) -> u8 {\n    ok!(t.handle())\n}",
    "pub fn sum(a: V, b: V) -> V {\n    ok!(a + b)\n}",
    "pub fn sum2(a: V, b: V) -> V {\n    a + b\n}",
    "pub fn parse(s: &str) -> Result<i32, E> {\n    Ok(ok!(s.parse::<i32>())?)\n}",
    "pub fn parse2(s: &str) -> Result<i32, E> {\n    Ok(s.parse::<i32>()?)\n}",
    "pub fn scope() -> u8 {\n    let _g = Guard;\n    ok!(1)\n}",
    "pub fn scope2() -> u8 {\n    let _g = Guard;\n    1\n}",
    "pub fn render(r: &Report) -> String {\n    format!(\"{}\", r)\n}",
    "pub async fn later() -> u8 {\n    ok!(helper())\n}",
    "pub fn with_closure() -> u8 {\n    let f = || ok!(helper());\n    f()\n}",
    "pub fn mapped(v: &[u8]) -> Vec<u8> {\n    ok!(v.iter().copied().map(double).collect())\n}",
    "pub fn mapped2(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(double).collect()\n}",
    "pub fn pointer(f: fn() -> u8) -> u8 {\n    ok!(f())\n}",
    "pub fn switched() -> u8 {\n    #[cfg(feature = \"extra\")]\n    {\n        return helper();\n    }\n    ok!(2)\n}",
    "#[cfg(not(feature = \"extra\"))]\npub fn gated() -> u8 {\n    ok!(2)\n}",
    "#[cfg(feature = \"extra\")]\npub fn gated() -> u8 {\n    ok!(helper())\n}",
    "",
  ].join("\n\n"),
  "src/main.rs":
    "macro_rules! ok {\n    ($e:expr) => {\n        $e\n    };\n}\n\n"
    + "fn run() -> u8 {\n    ok!(shapes::helpers::helper())\n}\n\nfn main() {\n    println!(\"{}\", run());\n}\n",
};

const C = "src/callers.rs#";
const H = "src/helpers.rs#";
const T = "src/transport.rs#";
const VAL = "src/values.rs#";

/** Arrows the code does not bear out. Each tail makes its calls inside a macro. */
const WRONG: Array<[string, string]> = [
  [`${C}wrapped`, `${H}unrelated`],
  [`${C}sum`, `${H}unrelated`],
  [`${C}later`, `${H}unrelated`],
  [`${C}with_closure`, `${H}unrelated`],
  [`${T}run`, `${H}unrelated`],
];

/** Arrows that are right, each a way the call happens without the list naming the head plainly. */
const RIGHT: Array<[string, string, string]> = [
  ["the call is inside a macro", `${C}wrapped`, `${H}helper`],
  ["a call through a generic trait bound", `${C}send`, `${T}handle`],
  ["a call through `dyn Trait`", `${C}send_dyn`, `${T}handle`],
  ["a call through a generic trait bound, the arrow at the implementing type", `${C}send`, `${T}Http`],
  ["a call through `dyn Trait`, the arrow at the implementing type", `${C}send_dyn`, `${T}Http`],
  ["a trait's default method calling `self`, the arrow at the implementing type", `${T}send_all`, `${T}Http`],
  /*
   * Not a correct arrow, and still quiet: `send` calls whichever `handle` its
   * `T` has, and one of those could be what calls `unrelated`. That makes
   * the arrow one level up, not wrong, and nothing can follow a call to an
   * implementation nobody named to tell the two apart.
   */
  ["a call through a trait, the arrow at something an implementation might call", `${C}send`, `${H}unrelated`],
  ["an operator, inside a macro", `${C}sum`, `${VAL}add`],
  ["an operator, no macro anywhere", `${C}sum2`, `${VAL}add`],
  ["`?` converting an error, inside a macro", `${C}parse`, `${VAL}from`],
  ["`?` converting an error, no macro", `${C}parse2`, `${VAL}from`],
  ["a value dropped at the end of a scope", `${C}scope`, `${VAL}drop`],
  ["a value dropped, no macro", `${C}scope2`, `${VAL}drop`],
  ["formatting a value", `${C}render`, `${VAL}fmt`],
  ["a call in an async fn's body", `${C}later`, `${H}helper`],
  ["a call in a closure the routine writes", `${C}with_closure`, `${H}helper`],
  ["a function handed to `map` by name, inside a macro", `${C}mapped`, `${H}double`],
  ["a function handed to `map` by name, no macro", `${C}mapped2`, `${H}double`],
  ["a call through a function pointer", `${C}pointer`, `${H}helper`],
  ["a call inside a block a feature switches on", `${C}switched`, `${H}helper`],
  ["a function a feature swaps for another", `${C}gated`, `${H}helper`],
  ["a trait's default method", `${T}run`, `${H}helper`],
  // The text sees `pong` call `ping` and not the call back, which is inside a macro: not "backwards".
  ["a call inside a macro to a routine that calls back", `${H}ping`, `${H}pong`],
];

/** In the binary target, which `cargo rustc --lib` never compiles. */
const IN_A_BINARY: [string, string] = ["src/main.rs#run", `${H}unrelated`];

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

describe.skipIf(!HAS_CARGO)("Rust @calls, read through the compiler's own call list", () => {
  let withCompiler: LiveCheck;
  let textOnly: LiveCheck;

  beforeAll(async () => {
    // Outside the worktree: a scratch source file inside one is read by the
    // dependency tests as though it belonged to this repository.
    repo = mkdtempSync(path.join(tmpdir(), "calls-compiled-"));
    write(FILES);
    const everything: Array<[string, string]> = [
      ...WRONG, ...RIGHT.map(([, from, to]) => [from, to] as [string, string]), IN_A_BINARY,
    ];
    textOnly = await check(everything, { compiler: false });
    withCompiler = await check(everything);
  }, 180_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("says the Rust compiler checked the board", () => {
    expect(withCompiler.checkedWith.answered).toContain("rustc");
  });

  describe("goes red where a wrong arrow's calls are all inside a macro", () => {
    for (const [from, to] of WRONG) {
      it(`${from} -> ${to}`, () => {
        expect(redOf(withCompiler)).toContain(`${from} -> ${to}`);
        // And it is the compiler that caught it: the text alone stops at the macro.
        expect(redOf(textOnly)).not.toContain(`${from} -> ${to}`);
      });
    }
  });

  describe("stays quiet where the arrow's end can be reached without a call to it written", () => {
    for (const [shape, from, to] of RIGHT) {
      it(shape, () => {
        expect(redOf(withCompiler)).not.toContain(`${from} -> ${to}`);
        expect(redOf(textOnly)).not.toContain(`${from} -> ${to}`);
      });
    }
  });

  it("stays quiet on a routine in a binary target, which the library build never compiles", () => {
    expect(redOf(withCompiler)).not.toContain(`${IN_A_BINARY[0]} -> ${IN_A_BINARY[1]}`);
  });

  it("goes red on nothing else", () => {
    const expected = new Set(WRONG.map(([from, to]) => `${from} -> ${to}`));
    expect([...redOf(withCompiler)].filter((one) => !expected.has(one))).toEqual([]);
  });
});

describe.skipIf(!HAS_CARGO)("the compiler's list is never read stale or waited on past the budget", () => {
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "calls-compiled-fresh-"));
    write(FILES);
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const arrow: [string, string] = [`${C}wrapped`, `${H}unrelated`];

  it("answers from the text while a build is still running, and from the build once it lands", async () => {
    const early = await check([arrow], { budgetMs: 1 });
    expect(early.checkedWith.answered).not.toContain("rustc");
    expect(redOf(early)).not.toContain(`${arrow[0]} -> ${arrow[1]}`);

    /*
     * The build started above keeps going, and a later check reads it. Each
     * check waits out its own budget at most, and a cold build under a full
     * test run can take longer than one budget -- so ask again, a few times.
     */
    let later = await check([arrow]);
    for (let tries = 0; tries < 8 && !later.checkedWith.answered.includes("rustc"); tries += 1) {
      later = await check([arrow]);
    }
    expect(later.checkedWith.answered).toContain("rustc");
    expect(redOf(later)).toContain(`${arrow[0]} -> ${arrow[1]}`);
  }, 240_000);

  it("rebuilds after an edit, rather than accuse from the old list", async () => {
    expect(redOf(await check([arrow]))).toContain(`${arrow[0]} -> ${arrow[1]}`);
    // Now `wrapped` does call `unrelated` -- inside the macro, where only the build can see it.
    write({
      "src/callers.rs": FILES["src/callers.rs"]!.replace(
        "use crate::helpers::{double, helper};",
        "use crate::helpers::{double, helper, unrelated};",
      ).replace("pub fn wrapped() -> u8 {\n    ok!(helper())\n}", "pub fn wrapped() -> u8 {\n    ok!(unrelated())\n}"),
    });
    expect(redOf(await check([arrow]))).not.toContain(`${arrow[0]} -> ${arrow[1]}`);
  }, 180_000);
});
