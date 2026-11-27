/**
 * rustc's own list of a Rust body decides arrows at a type (batch 7, step 3).
 *
 * The bad outcomes, all on the planted bench: a wrong "`f` calls `Widget`"
 * stayed "not sure" when `f` only *named* Widget -- the type of a local, of
 * what it returns -- although rustc's list shows no call of anything Widget
 * has. A struct drawn as the caller ("`Printer` calls `unrelated`") could
 * never be called wrong when its methods made their calls inside a macro.
 * And four gaps kept the list away altogether: a program (a binary target)
 * was never built, so fd had no list at all; a `#[test]` function named like
 * the routine it tests was read as part of it; `Some(..)` written as a
 * constant was looked for in the list and not found; and the list could not
 * be told apart from a list rustc might one day print in another shape.
 *
 * The rule, as a fact about Rust: everything a body runs of a type's own
 * code is on a line rustc writes as a call -- `Widget::run(..)`,
 * `<Widget as ToString>::to_string(..)`, `<Pair as PartialEq>::eq(..)` -- or
 * a `drop` of a value whose type writes `Drop`. A type named only off those
 * lines is not called. The name alone is never enough: `w.to_string()` runs
 * code written for Widget although Widget declares no `to_string`.
 *
 * Each "stays quiet" case is a way a type's code runs that the rule must
 * see. Each is checked with the compiler and with none.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { readCompiledCrate, type CompiledCrate } from "../src/engine/compiled-calls";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive, type LiveCheck, type LiveOptions } from "../src/engine/referee-live";
import { compileCrates } from "../src/engine/referee-rustc";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

const HAS_CARGO = spawnSync("cargo", ["--version"]).status === 0;
const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

const OK_MACRO = "macro_rules! ok {\n    (=> $e:expr) => {\n        $e\n    };\n}\n\n";

/*
 * `ok!(=> x)` is a macro whose tokens are not an expression, so the text
 * reader cannot see the calls inside it (#471 reads `ok!(x)`): only rustc's
 * list can.
 */
const FILES: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "fx"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": `${OK_MACRO}pub mod callers;\npub mod helpers;\npub mod printer;\npub mod shapes;\n`,
  "src/helpers.rs":
    "pub fn helper() -> u32 {\n    1\n}\n\npub fn unrelated() -> u32 {\n    2\n}\n\npub fn other(n: u32) -> u32 {\n    n + 1\n}\n",
  "src/shapes.rs": [
    "use std::fmt;",
    "pub struct Widget {\n    pub n: u32,\n}",
    "impl Widget {\n    pub fn run(&self) -> u32 {\n        self.n\n    }\n}",
    "impl fmt::Display for Widget {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {\n        write!(f, \"{}\", self.n)\n    }\n}",
    "#[derive(PartialEq)]\npub struct Pair {\n    pub n: u32,\n}",
    "pub struct Guard {\n    pub n: u32,\n}",
    "impl Drop for Guard {\n    fn drop(&mut self) {}\n}",
    "pub trait Walks {\n    fn walk(&self) -> u32;\n}",
    "pub trait Runs {\n    fn run_it(&self) -> u32;\n}",
    "impl Walks for Widget {\n    fn walk(&self) -> u32 {\n        self.n\n    }\n}",
    "pub struct Holder {\n    pub w: Widget,\n    pub a: Pair,\n    pub b: Pair,\n}",
    "#[derive(PartialEq, Clone, Copy)]\npub struct Kind(pub u8);",
    "impl Kind {\n    pub const A: Kind = Kind(1);\n}",
    "",
  ].join("\n\n"),
  "src/callers.rs": [
    "use crate::helpers::{helper, other};",
    "use crate::shapes::{Guard, Holder, Kind, Runs, Walks, Widget};",
    // Widget is the type of a local, and nothing of Widget's runs.
    "pub fn only_names(h: &Holder) -> u32 {\n    let w: &Widget = &h.w;\n    ok!(=> other(w.n))\n}",
    "pub fn hands_back(h: &Holder) -> &Widget {\n    let n = ok!(=> other(h.a.n));\n    if n > 0 { &h.w } else { &h.w }\n}",
    "pub fn runs_it(h: &Holder) -> u32 {\n    let w: &Widget = &h.w;\n    ok!(=> w.run())\n}",
    "pub fn shows_it(h: &Holder) -> usize {\n    ok!(=> h.w.to_string().len())\n}",
    "pub fn compares(h: &Holder) -> bool {\n    ok!(=> h.a == h.b)\n}",
    "pub fn drops_it(g: Guard) -> u32 {\n    ok!(=> other(g.n))\n}",
    "pub fn walks<T: Walks>(x: &T) -> u32 {\n    ok!(=> x.walk())\n}",
    "pub fn runs_other<T: Runs>(x: &T) -> u32 {\n    ok!(=> x.run_it())\n}",
    // `Some(Kind::A)` compared against is promoted to a constant: not in the body rustc prints.
    "pub fn with_some(c: Option<Kind>) -> u32 {\n    if c == Some(Kind::A) {\n        return ok!(=> helper());\n    }\n    0\n}",
    "pub fn parse_set() -> u32 {\n    ok!(=> helper())\n}",
    "#[cfg(test)]\nmod tests {\n    use crate::helpers::unrelated;\n\n    #[test]\n    fn parse_set() {\n        assert_eq!(unrelated(), 2);\n    }\n}",
    "",
  ].join("\n\n"),
  "src/printer.rs": [
    "use crate::helpers::helper;",
    "pub struct Printer {\n    pub n: u32,\n}",
    "impl Printer {\n    pub fn print(&self) -> u32 {\n        ok!(=> helper()) + self.n\n    }\n}",
    // An `impl` of it in another file, which calls `unrelated`.
    "pub struct Split {\n    pub n: u32,\n}",
    "impl Split {\n    pub fn first(&self) -> u32 {\n        ok!(=> helper()) + self.n\n    }\n}",
    "",
  ].join("\n\n"),
  "src/main.rs": `${OK_MACRO}fn run() -> u32 {\n    ok!(=> fx::helpers::helper())\n}\n\nfn main() {\n    println!("{}", run());\n}\n`,
};

/** A second module holding the other `impl Split`. Added to lib.rs below. */
FILES["src/split_more.rs"] = "use crate::helpers::unrelated;\nuse crate::printer::Split;\n\nimpl Split {\n    pub fn second(&self) -> u32 {\n        ok!(=> unrelated()) + self.n\n    }\n}\n";
FILES["src/lib.rs"] += "pub mod split_more;\n";

/** A package with no library at all: a program, as fd is. */
const PROGRAM: Record<string, string> = {
  "Cargo.toml": '[package]\nname = "tool"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/main.rs": `${OK_MACRO}mod work;\n\nfn main() {\n    println!("{}", work::go());\n}\n`,
  "src/work.rs":
    "pub fn helper() -> u32 {\n    1\n}\n\npub fn unrelated() -> u32 {\n    2\n}\n\npub fn go() -> u32 {\n    ok!(=> helper())\n}\n",
};

const C = "src/callers.rs#";
const H = "src/helpers.rs#";
const S = "src/shapes.rs#";
const P = "src/printer.rs#";

/** Arrows the code does not bear out, each settled only by rustc's list. */
const WRONG: Array<[string, string, string]> = [
  ["a type named only as a local's type", `${C}only_names`, `${S}Widget`],
  ["a type named only as what the routine hands back", `${C}hands_back`, `${S}Widget`],
  ["a call through a type parameter by a name the type never declares", `${C}runs_other`, `${S}Widget`],
  ["a struct at the near end, its method's calls inside a macro", `${P}Printer`, `${H}unrelated`],
  ["a routine comparing against a constant `Some(..)`", `${C}with_some`, `${H}unrelated`],
  ["a routine with a `#[test]` namesake that calls the far end", `${C}parse_set`, `${H}unrelated`],
  ["a routine in the program, not the library", "src/main.rs#run", `${H}unrelated`],
];

/** Arrows that are right: each a way a type's own code runs. */
const RIGHT: Array<[string, string, string]> = [
  ["a method the type declares, called inside a macro", `${C}runs_it`, `${S}Widget`],
  ["`to_string`, which runs the type's `Display`", `${C}shows_it`, `${S}Widget`],
  ["`==`, which runs the type's derived `PartialEq`", `${C}compares`, `${S}Pair`],
  ["a value dropped at the end of the routine, whose type writes `Drop`", `${C}drops_it`, `${S}Guard`],
  ["a call through a type parameter by a name the type declares", `${C}walks`, `${S}Widget`],
  ["a struct at the near end calling it", `${P}Printer`, `${H}helper`],
  ["a struct with another `impl` in another file that calls it", `${P}Split`, `${H}unrelated`],
  ["a routine comparing against a constant `Some(..)`, calling it", `${C}with_some`, `${H}helper`],
  ["a routine with a `#[test]` namesake, calling it", `${C}parse_set`, `${H}helper`],
  ["a routine in the program, calling it", "src/main.rs#run", `${H}helper`],
];

let repo: string;
let program: string;
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
    name: "fx",
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

describe.skipIf(!HAS_CARGO)("rustc's list decides an arrow at a Rust type", () => {
  let withCompiler: LiveCheck & { red: Set<string> };
  let textOnly: LiveCheck & { red: Set<string> };

  beforeAll(async () => {
    // Outside the worktree: a scratch source file inside one is read by the dependency tests as this repository's.
    repo = mkdtempSync(path.join(tmpdir(), "list-decides-"));
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

  describe("goes red where rustc's list shows nothing of the far end runs", () => {
    for (const [shape, from, to] of WRONG) {
      it(shape, () => {
        expect(withCompiler.red).toContain(`${from} -> ${to}`);
        // The compiler's doing: the text alone stops at the macro.
        expect(textOnly.red).not.toContain(`${from} -> ${to}`);
      });
    }
  });

  describe("stays quiet where the far end's code runs", () => {
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

describe.skipIf(!HAS_CARGO)("a package that is only a program", () => {
  beforeAll(() => {
    program = mkdtempSync(path.join(tmpdir(), "list-program-"));
    write(program, PROGRAM);
  });

  afterAll(() => {
    rmSync(program, { recursive: true, force: true });
  });

  it("is built, and its list judges its routines both ways", async () => {
    const live = await check(program, [["src/work.rs#go", "src/work.rs#unrelated"], ["src/work.rs#go", "src/work.rs#helper"]]);
    expect(live.checkedWith.answered).toContain("rustc");
    expect(live.red).toEqual(new Set(["src/work.rs#go -> src/work.rs#unrelated"]));
    expect(live.report.claims.callsConfirmed).toBe(1);
  }, 240_000);
});

describe.skipIf(!HAS_CARGO)("a list printed in a shape this reader does not know", () => {
  /*
   * The rule reads rustc's printed list by its text, and rustc says the format
   * may change. If a later rustc writes its calls so that none is recognised,
   * a body that makes calls would read as one that makes none -- and every
   * type it names only as a type would be "never called". So a body whose
   * blocks end in anything unrecognised is not read by this rule, and the
   * arrow is what it was before the rule existed: quiet.
   */
  let dir: string;
  let real: CompiledCrate;
  let reworded: CompiledCrate;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "list-reworded-"));
    write(dir, FILES);
    const built = await compileCrates(dir, ["src/callers.rs"], { until: Date.now() + 200_000 });
    expect(built.answered).toBe(true);
    const dump = built.dumpOf("src/callers.rs")!;
    const mir = readFileSync(dump, "utf8");
    // A hypothetical rustc that prints `call f(..) => bb1;` where 1.99 prints `f(..) -> [return: bb1, ..];`.
    const rewritten = mir.replace(/^(\s+)(_\d+ = )?([^\n]*\(.*\)) -> \[return: (bb\d+)[^\]]*\];$/gm, (whole, indent, into, call, next) =>
      (/^(?:switchInt|assert|drop|falseEdge|falseUnwind)\(/.test(call) ? whole : `${indent}${into ?? ""}call ${call} => ${next};`));
    expect(rewritten).not.toEqual(mir);
    const depInfo = readFileSync(dump.replace(/calls\.mir$/, "calls.d"), "utf8");
    const places = { workspace: dir, repo: dir, root: path.join(dir, "src/lib.rs") };
    const read = (file: string) => readFileSync(path.join(dir, file), "utf8");
    real = readCompiledCrate(mir, depInfo, places, read);
    reworded = readCompiledCrate(rewritten, depInfo, places, read);
  }, 240_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const judge = async (crate: CompiledCrate, arrows: Array<[string, string]>): Promise<Set<string>> => {
    const { board, byId } = await boardOf(arrows);
    const report = checkDrift(board, createWorkspace(dir), {
      edges: true,
      closedBodyReferee: { resolveReceiver: () => undefined, compiledCrateOf: () => crate },
    });
    return redsOf(report, byId);
  };

  it("goes red from the list as rustc prints it today", async () => {
    expect(await judge(real, [[`${C}only_names`, `${S}Widget`]])).toEqual(new Set([`${C}only_names -> ${S}Widget`]));
  });

  it("goes quiet when no call line is recognised in a body that makes calls", async () => {
    expect(await judge(reworded, [[`${C}only_names`, `${S}Widget`], [`${P}Printer`, `${H}unrelated`]])).toEqual(new Set());
  });
});
