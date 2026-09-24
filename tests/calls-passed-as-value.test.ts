/**
 * A function handed on as a value may be run by whatever it is handed to (#359).
 *
 * `run(xs) { return xs.map(double); }` runs `double`, through `map`. The
 * check read every call `run` writes, found none reaching `double`'s file,
 * and called the correct arrow `run -> double` wrong. The same in Python
 * (`map(double, xs)`, `sorted(xs, key=double)`); #358 fixed the plainest
 * Rust spelling.
 *
 * Per language, each way a function is handed on: to a method, to a free
 * function, as a keyword argument, into an object or a field, returned, under
 * an import alias, through a module path, and in the same file as the head.
 * And the guard the other way: a body that hands on some *other* function
 * still has its wrong arrow called wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

/** The same check every other rust-analyzer test here makes: the live half needs the real binary. */
const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

async function checked(fromRef: string, toRef: string): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: fromRef },
      { id: "callee", label: "callee", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "calls-passed-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** One language's fixture: the files, the right arrows that must stay quiet, the wrong ones that must stay red. */
interface Shapes {
  files: Record<string, string>;
  right: Array<[string, string, string]>;
  wrong: Array<[string, string, string]>;
}

function shapes(language: string, fixture: Shapes, timeout: number, skip = false): void {
  describe.skipIf(skip)(language, () => {
    it.each(fixture.right)("stays quiet when %s", async (_shape, from, to) => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual([]);
    }, timeout);

    it.each(fixture.wrong)("still calls a wrong arrow wrong when %s", async (_shape, from, to) => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual(["calls-refuted"]);
    }, timeout);
  });
}

const TS_B = "export function double(x: number): number {\n  return x * 2;\n}\n\nexport type Pair = [number, number];\n";
const TS_C = "export function triple(x: number): number {\n  return x * 3;\n}\n";

shapes("TypeScript", {
  files: {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "b.ts": TS_B,
    "c.ts": TS_C,
    "a.ts": [
      "import { double, double as twice } from \"./b\";",
      "import * as B from \"./b\";",
      "import { triple } from \"./c\";",
      "",
      "export function local(x: number): number {\n  return x + 1;\n}",
      "export function apply(f: (x: number) => number, x: number): number {\n  return f(x);\n}",
      "export function toMethod(xs: number[]): number[] {\n  return xs.map(double);\n}",
      "export function toFree(x: number): number {\n  return apply(double, x);\n}",
      "export function inObject(): object {\n  const table = { d: double };\n  return table;\n}",
      "export function shorthand(): object {\n  return { double };\n}",
      "export class Holder {\n  fn?: (x: number) => number;\n\n  keep(): void {\n    this.fn = double;\n  }\n}",
      "export function returned(): (x: number) => number {\n  return double;\n}",
      "export function aliased(xs: number[]): number[] {\n  return xs.map(twice);\n}",
      "export function throughModule(xs: number[]): number[] {\n  return xs.map(B.double);\n}",
      "export function sameFile(xs: number[]): number[] {\n  return xs.map(local);\n}",
      "export function unrelated(xs: number[]): number[] {\n  return xs.map(triple);\n}",
      "import type { Pair } from \"./b\";",
      "export function pair<P extends Pair>(x: number): P {\n  return [x, x] as Pair as P;\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["handed to a method", "a.ts#toMethod", "b.ts#double"],
    ["handed to a free function", "a.ts#toFree", "b.ts#double"],
    ["stored in an object", "a.ts#inObject", "b.ts#double"],
    ["stored in an object by shorthand", "a.ts#shorthand", "b.ts#double"],
    ["stored in a field", "a.ts#keep", "b.ts#double"],
    ["returned", "a.ts#returned", "b.ts#double"],
    ["handed on under an import alias", "a.ts#aliased", "b.ts#double"],
    ["handed on through a namespace import", "a.ts#throughModule", "b.ts#double"],
    ["handed on in the same file", "a.ts#sameFile", "a.ts#local"],
  ],
  wrong: [
    ["the body hands on a function from another file", "a.ts#unrelated", "b.ts#double"],
    ["the body hands on a function, the head in the same file", "a.ts#unrelated", "a.ts#local"],
    // Found by bench:planted: a type's name written as a type is not a function handed on.
    ["the head is a type the body only writes as a type", "a.ts#pair", "b.ts#Pair"],
  ],
}, 120_000);

shapes("TSX", {
  files: {
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"jsx\": \"preserve\" } }\n",
    "b.ts": TS_B,
    "c.ts": TS_C,
    "view.tsx": [
      "import { double } from \"./b\";",
      "import { triple } from \"./c\";",
      "",
      "export function List({ xs }: { xs: number[] }) {\n  return <ul>{xs.map(double)}</ul>;\n}",
      "export function Button() {\n  return <button onClick={double}>go</button>;\n}",
      "export function Other({ xs }: { xs: number[] }) {\n  return <ul>{xs.map(triple)}</ul>;\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["handed to a method inside JSX", "view.tsx#List", "b.ts#double"],
    ["handed to an element as a handler", "view.tsx#Button", "b.ts#double"],
  ],
  wrong: [
    ["the body hands on a function from another file", "view.tsx#Other", "b.ts#double"],
  ],
}, 120_000);

shapes("Python", {
  files: {
    "b.py": "def double(x):\n    return x * 2\n",
    "c.py": "def triple(x):\n    return x * 3\n",
    "a.py": [
      "import b\nfrom b import double\nfrom b import double as twice\nfrom c import triple",
      "def local(x):\n    return x + 1",
      "class Pool:\n    def run(self, f, xs):\n        return [f(x) for x in xs]",
      "def to_method(xs):\n    return Pool().run(double, xs)",
      "def to_free(xs):\n    return list(map(double, xs))",
      "def keyword(xs):\n    return sorted(xs, key=double)",
      "def in_dict():\n    return {\"d\": double}",
      "class Holder:\n    def keep(self):\n        self.fn = double",
      "def returned():\n    return double",
      "def aliased(xs):\n    return list(map(twice, xs))",
      "def through_module(xs):\n    return list(map(b.double, xs))",
      "def same_file(xs):\n    return sorted(xs, key=local)",
      "def unrelated(xs):\n    return list(map(triple, xs))",
      "",
    ].join("\n\n\n"),
  },
  right: [
    ["handed to a method", "a.py#to_method", "b.py#double"],
    ["handed to a free function", "a.py#to_free", "b.py#double"],
    ["handed on as a keyword argument", "a.py#keyword", "b.py#double"],
    ["stored in a dict", "a.py#in_dict", "b.py#double"],
    ["stored in a field", "a.py#keep", "b.py#double"],
    ["returned", "a.py#returned", "b.py#double"],
    ["handed on under an import alias", "a.py#aliased", "b.py#double"],
    ["handed on through a module", "a.py#through_module", "b.py#double"],
    ["handed on in the same file", "a.py#same_file", "a.py#local"],
  ],
  wrong: [
    ["the body hands on a function from another file", "a.py#unrelated", "b.py#double"],
    ["the body hands on a function, the head in the same file", "a.py#unrelated", "a.py#local"],
  ],
}, 120_000);

shapes("Rust", {
  files: {
    "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
    "src/lib.rs": "pub mod a;\npub mod b;\npub mod c;\n",
    "src/b.rs": "pub fn double(x: u8) -> u8 {\n    x * 2\n}\n",
    "src/c.rs": "pub fn triple(x: u8) -> u8 {\n    x * 3\n}\n",
    "src/a.rs": [
      "use crate::b::double;\nuse crate::b::double as twice;\nuse crate::c::triple;",
      "pub struct Holder {\n    pub f: fn(u8) -> u8,\n}",
      "pub fn local(x: u8) -> u8 {\n    x + 1\n}",
      "pub fn apply(f: fn(u8) -> u8, x: u8) -> u8 {\n    f(x)\n}",
      "pub fn to_method(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(double).collect()\n}",
      "pub fn to_free(x: u8) -> u8 {\n    apply(double, x)\n}",
      "pub fn in_field() -> Holder {\n    Holder { f: double }\n}",
      "pub fn returned() -> fn(u8) -> u8 {\n    double\n}",
      "pub fn aliased(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(twice).collect()\n}",
      "pub fn through_path(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(crate::b::double).collect()\n}",
      "pub fn same_file(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(local).collect()\n}",
      "pub fn unrelated(v: &[u8]) -> Vec<u8> {\n    v.iter().copied().map(triple).collect()\n}",
      "",
    ].join("\n\n"),
  },
  right: [
    ["handed to a method", "src/a.rs#to_method", "src/b.rs#double"],
    ["handed to a free function", "src/a.rs#to_free", "src/b.rs#double"],
    ["stored in a field", "src/a.rs#in_field", "src/b.rs#double"],
    ["returned", "src/a.rs#returned", "src/b.rs#double"],
    ["handed on under an import alias", "src/a.rs#aliased", "src/b.rs#double"],
    ["handed on through a module path", "src/a.rs#through_path", "src/b.rs#double"],
    ["handed on in the same file", "src/a.rs#same_file", "src/a.rs#local"],
  ],
  wrong: [
    ["the body hands on a function from another file", "src/a.rs#unrelated", "src/b.rs#double"],
    ["the body hands on a function, the head in the same file", "src/a.rs#unrelated", "src/a.rs#local"],
  ],
}, 180_000, !hasRustAnalyzer);
