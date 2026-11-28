/**
 * Rust arrows where rustc built the crate and its list still did not settle
 * the arrow (batch 8). Each gap kept a wrong arrow "not sure":
 *
 *   - a name was read as a build switch: a local called `cfg`, or `!x` (not)
 *     read as a macro inside a `#[cfg]` region, threw the whole list away;
 *   - a call through a trait on a type parameter kept every head a doubt,
 *     though in Rust such a call runs a method of the name it calls;
 *   - a function declared inside another was never matched to its body;
 *   - `cfg!(..)` in an `if` threw the list away, where only the `if` is in
 *     doubt;
 *   - an enum variant at the head was never "made none", because it is not
 *     a struct;
 *   - std's `thread_local!` naming a struct was read as a macro that might
 *     write an `impl` of it.
 *
 * And one safety gap, found while reading these: a `#[cfg]` region the build
 * left out may run a type's own code without naming the type (`w.run()`),
 * so rule 7 must not read the list past one.
 *
 * Every WRONG arrow goes red with rustc and stays quiet without it; every
 * RIGHT arrow stays not red both ways.
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

/* `ok!(=> x)`'s tokens are not an expression, so only rustc's list can see the calls inside it. */
const MACROS = [
  "macro_rules! ok {\n    (=> $e:expr) => {\n        $e\n    };\n}",
  "macro_rules! hide {\n    () => {\n        crate::helpers::unrelated()\n    };\n}",
  "",
].join("\n\n");

const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "gx"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nnope = []\n',
  "src/lib.rs": `${MACROS}pub mod gaps;\npub mod helpers;\npub mod shapes;\npub mod worker;\n`,
  "src/helpers.rs":
    "pub fn helper() -> u32 {\n    1\n}\n\npub fn unrelated() -> u32 {\n    2\n}\n\npub fn other(n: u32) -> u32 {\n    n + 1\n}\n",
  "src/shapes.rs": [
    "pub struct Widget {\n    pub n: u32,\n}",
    "impl Widget {\n    pub fn run(&self) -> u32 {\n        self.n\n    }\n}",
    "pub trait Walks {\n    fn walk(&self) -> u32;\n}",
    "impl Walks for Widget {\n    fn walk(&self) -> u32 {\n        crate::helpers::helper()\n    }\n}",
    "pub enum Pattern {\n    Fixed(u32),\n    Dynamic(u32),\n}",
    "pub fn dynamic_one() -> Pattern {\n    Pattern::Dynamic(1)\n}",
    "pub struct Counter {\n    pub n: u32,\n}",
    "impl Iterator for Counter {\n    type Item = u32;\n    fn next(&mut self) -> Option<u32> {\n        None\n    }\n}",
    "",
  ].join("\n\n"),
  "src/worker.rs": [
    "use std::cell::RefCell;",
    "pub struct Worker {\n    pub n: u32,\n}",
    "thread_local! {\n    static SLOT: RefCell<Option<Worker>> = RefCell::new(None);\n}",
    "impl Worker {\n    pub fn go(&self) -> u32 {\n        ok!(=> crate::helpers::helper()) + self.n\n    }\n}",
    "pub fn slot_is_empty() -> bool {\n    SLOT.with(|slot| slot.borrow().is_none())\n}",
    "",
  ].join("\n\n"),
  "src/gaps.rs": [
    "use crate::helpers::{helper, other};",
    "use crate::shapes::{Pattern, Walks, Widget};",
    // A local and a parameter called `cfg`: names, not build switches.
    "pub fn configure(cfg: u32) -> u32 {\n    let cfg = cfg + 1;\n    ok!(=> other(cfg))\n}",
    // `!flag` inside a region the build leaves out: `not`, not a macro.
    "pub fn negates(flag: bool) -> u32 {\n    #[cfg(feature = \"nope\")]\n    {\n        if !flag {\n            return 0;\n        }\n    }\n    ok!(=> helper())\n}",
    // A real macro inside such a region: what it expands to was never compiled.
    "pub fn region_macro() -> u32 {\n    #[cfg(feature = \"nope\")]\n    {\n        hide!();\n    }\n    ok!(=> helper())\n}",
    // A call through a trait on a type parameter.
    "pub fn walks_any<T: Walks>(x: &T) -> u32 {\n    ok!(=> x.walk())\n}",
    "pub fn sums<I: Iterator<Item = u32>>(i: I) -> u32 {\n    ok!(=> i.sum())\n}",
    // Functions declared inside others: one unique, two sharing a name.
    "pub fn outer_fn() -> u32 {\n    fn nested_one() -> u32 {\n        ok!(=> helper())\n    }\n    nested_one()\n}",
    "pub fn outer_a() -> u32 {\n    fn inner() -> u32 {\n        ok!(=> helper())\n    }\n    inner()\n}",
    "pub fn outer_b() -> u32 {\n    fn inner() -> u32 {\n        ok!(=> crate::helpers::unrelated())\n    }\n    inner()\n}",
    // `cfg!(..)` in an `if`: a constant, and the branch it rules out is not in rustc's list.
    "pub fn with_cfg_macro(flag: bool) -> u32 {\n    if cfg!(feature = \"nope\") && flag {\n        return other(2);\n    }\n    ok!(=> helper())\n}",
    // Variants at the head.
    "pub fn makes_fixed() -> Pattern {\n    ok!(=> Pattern::Fixed(helper()))\n}",
    "pub fn makes_dynamic() -> Pattern {\n    ok!(=> Pattern::Dynamic(helper()))\n}",
    "pub fn maps_dynamic(xs: Vec<u32>) -> Vec<Pattern> {\n    ok!(=> xs.into_iter().map(Pattern::Dynamic).collect())\n}",
    "pub fn gets_pattern() -> Pattern {\n    ok!(=> crate::shapes::dynamic_one())\n}",
    // A region the build left out runs Widget's own code without naming Widget.
    "pub fn region_runs(w: &Widget) -> u32 {\n    #[cfg(feature = \"nope\")]\n    {\n        w.run();\n    }\n    ok!(=> other(w.n))\n}",
    "",
  ].join("\n\n"),
};

const G = "src/gaps.rs#";
const H = "src/helpers.rs#";
const S = "src/shapes.rs#";
const W = "src/worker.rs#";

/** Arrows the code does not bear out: rustc's list settles each, and the text alone cannot. */
const WRONG: Array<[string, string, string]> = [
  ["a routine with a local called `cfg`", `${G}configure`, `${H}unrelated`],
  ["a routine with `!flag` inside a `#[cfg]` region", `${G}negates`, `${H}unrelated`],
  ["a call through a trait on a type parameter, by a name the head does not have", `${G}walks_any`, `${H}unrelated`],
  ["a function declared inside another", `${G}nested_one`, `${H}unrelated`],
  ["two functions of one name declared inside two others, neither calling it", `${G}inner`, `${H}other`],
  ["a routine with `cfg!(..)` in an `if`", `${G}with_cfg_macro`, `${H}unrelated`],
  ["an enum variant the routine never makes", `${G}makes_fixed`, `${S}Dynamic`],
  ["a struct a std `thread_local!` names", `${W}Worker`, `${H}unrelated`],
];

/** Arrows that are right, or that nothing here may call wrong. */
const RIGHT: Array<[string, string, string]> = [
  ["a routine with a local called `cfg`, calling it", `${G}configure`, `${H}other`],
  ["a routine with `!flag` inside a `#[cfg]` region, calling it", `${G}negates`, `${H}helper`],
  ["a macro inside a `#[cfg]` region the build left out", `${G}region_macro`, `${H}unrelated`],
  ["a call through a trait on a type parameter, by the head's own name", `${G}walks_any`, `${S}walk`],
  ["a library routine on a type parameter, which runs the head for it", `${G}sums`, `${S}next`],
  ["a function declared inside another, calling it", `${G}nested_one`, `${H}helper`],
  ["two functions of one name inside two others, one calling it", `${G}inner`, `${H}unrelated`],
  ["the branch `cfg!(..)` rules out, calling it", `${G}with_cfg_macro`, `${H}other`],
  ["an enum variant the routine makes", `${G}makes_dynamic`, `${S}Dynamic`],
  ["an enum variant handed to `map` as its constructor", `${G}maps_dynamic`, `${S}Dynamic`],
  ["an enum variant a call hands back", `${G}gets_pattern`, `${S}Dynamic`],
  ["a struct a std `thread_local!` names, calling it", `${W}Worker`, `${H}helper`],
  ["a type whose code a left-out `#[cfg]` region runs", `${G}region_runs`, `${S}Widget`],
];

let repo: string;
let cache: string;
const previousCache = process.env.DIAGRAMOS_RUSTC_CACHE;

function write(root: string, files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function boardOf(arrows: Array<[string, string]>): Promise<{ board: BoardFile; byId: Map<string, string> }> {
  const ids = new Map<string, string>();
  const id = (ref: string) => {
    if (!ids.has(ref)) ids.set(ref, `n${ids.size}`);
    return ids.get(ref)!;
  };
  const edges = arrows.map(([from, to]) => ({ from: id(from), to: id(to), claim: "calls" as const }));
  const { board } = await createDiagram(emptyBoard(), {
    name: "gx",
    nodes: [...ids].map(([ref, one]) => ({ id: one, label: `${ref.split("#")[1]} ${one}`, ref })),
    edges,
  });
  return { board: board as BoardFile, byId: new Map([...ids].map(([ref, one]) => [one, ref])) };
}

function redsOf(report: DriftReport, byId: Map<string, string>): Set<string> {
  return new Set(report.edges
    .filter((finding) => ACCUSES.has(finding.kind))
    .map((finding) => {
      const [from, to] = (finding as { node: string }).node.split(" -> ");
      return `${byId.get(from!)} -> ${byId.get(to!)}`;
    }));
}

async function check(root: string, arrows: Array<[string, string]>, options: LiveOptions = {}): Promise<LiveCheck & { red: Set<string> }> {
  const { board, byId } = await boardOf(arrows);
  const workspace = createWorkspace(root);
  const live = await refereedCheckLive(root, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }), options);
  return { ...live, red: redsOf(live.report, byId) };
}

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

describe.skipIf(!HAS_CARGO)("gaps in rustc's list of a Rust body (batch 8)", () => {
  let withCompiler: LiveCheck & { red: Set<string> };
  let textOnly: LiveCheck & { red: Set<string> };

  beforeAll(async () => {
    // Outside the worktree: a scratch source file inside one is read by the dependency tests as this repository's.
    repo = mkdtempSync(path.join(tmpdir(), "list-gaps-"));
    write(repo, FILES);
    const everything = [...WRONG, ...RIGHT].map(([, from, to]) => [from, to] as [string, string]);
    textOnly = await check(repo, everything, { compiler: false });
    withCompiler = await check(repo, everything);
  }, 240_000);

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("says the Rust compiler checked the board", () => {
    expect(withCompiler.checkedWith.answered).toContain("rustc");
  });

  describe("goes red where rustc's list settles it", () => {
    for (const [shape, from, to] of WRONG) {
      it(shape, () => {
        expect(withCompiler.red).toContain(`${from} -> ${to}`);
        expect(textOnly.red).not.toContain(`${from} -> ${to}`);
      });
    }
  });

  describe("stays quiet where the head may run", () => {
    for (const [shape, from, to] of RIGHT) {
      it(shape, () => {
        expect(withCompiler.red).not.toContain(`${from} -> ${to}`);
        expect(textOnly.red).not.toContain(`${from} -> ${to}`);
      });
    }
  });

  it("goes red on nothing else", () => {
    const expected = new Set(WRONG.map(([, from, to]) => `${from} -> ${to}`));
    expect([...withCompiler.red].filter((one) => !expected.has(one))).toEqual([]);
  });
});
