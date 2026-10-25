/**
 * A call written in a valid but unusual shape is read as the call it is (#470).
 *
 * The callee comes from the call node itself, in every grammar: type
 * arguments, a misread `await` and parentheses are taken off, and
 * `super(...)` is read as the class it extends. `.call` and `.apply` are
 * JavaScript's way of running a function value, so they are special only
 * there, and only when what they are called on is a function. A Python
 * `vd.call(...)` or a Rust `service.call(req)` is a method named `call`,
 * and a function the repository names `apply` is a function.
 *
 * The refusals come first, because they are what makes the rule safe:
 *
 *   - `handler.call(ctx, x)` on a parameter runs whatever the caller passed,
 *     which may be the head. The built-in `Function.prototype.call` is what
 *     "go to definition" names there, and it must not be taken as an answer.
 *   - `this.instruments.call("x")` runs the method `call` of a class, not
 *     the field `instruments`.
 *   - Rust's `(self.f)(x)` runs the function stored in a field, not a method
 *     named `f`, and TypeScript's `this.cb!(x)` an optional field's function.
 *   - `eval`, `getattr` and the others that really can run anything still
 *     can.
 *
 * Then the wrong arrows the change exists for, and #447's six: a built-in on
 * the left of `+` (#468 fixed those; they are kept here so they stay fixed).
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

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

async function checked(fromRef: string, toRef: string, live: boolean): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "caller", label: "caller", ref: fromRef },
      { id: "callee", label: "callee", ref: toRef },
    ],
    edges: [{ from: "caller", to: "callee", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  if (!live) return checkDrift(board as BoardFile, workspace, { edges: true });
  const result = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return result.report;
}

const accusations = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);
const confirmed = (report: DriftReport) => (report.claims.callsConfirmed ?? 0) > 0;

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "call-shapes-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

interface Shapes {
  files: Record<string, string>;
  /** Right arrows, or arrows nobody can call wrong: must stay quiet. */
  right?: Array<[string, string, string]>;
  /** Right arrows the call is written for in plain sight: must confirm. */
  confirms?: Array<[string, string, string]>;
  /** Wrong arrows: the red expected, `calls-refuted` when left out. */
  wrong?: Array<[string, string, string] | [string, string, string, string]>;
  /**
   * Only with the compilers live: the text alone cannot say what the receiver
   * is -- that `/a+/` is a regular expression, that `Object.prototype` is the
   * language's.
   */
  wrongLive?: Array<[string, string, string] | [string, string, string, string]>;
}

function shapes(language: string, fixture: Shapes): void {
  const rust = Object.keys(fixture.files).some((file) => file.endsWith(".rs"));
  for (const live of [false, true]) {
    describe.skipIf(live && rust && !hasRustAnalyzer)(`${language}, ${live ? "compilers live" : "text alone"}`, () => {
      if (fixture.right?.length) {
        it.each(fixture.right)("stays quiet when %s", async (_shape, from, to) => {
          write(fixture.files);
          expect(accusations(await checked(from, to, live))).toEqual([]);
        }, 180_000);
      }
      if (fixture.confirms?.length) {
        it.each(fixture.confirms)("confirms when %s", async (_shape, from, to) => {
          write(fixture.files);
          const report = await checked(from, to, live);
          expect(accusations(report)).toEqual([]);
          expect(confirmed(report)).toBe(true);
        }, 180_000);
      }
      const wrong = [...(fixture.wrong ?? []), ...(live ? fixture.wrongLive ?? [] : [])];
      if (wrong.length > 0) {
        it.each(wrong)("calls a wrong arrow wrong when %s", async (_shape, from, to, kind = "calls-refuted") => {
          write(fixture.files);
          expect(accusations(await checked(from, to, live))).toEqual([kind]);
        }, 180_000);
      }
    });
  }
}

const TSCONFIG = "{ \"compilerOptions\": { \"strict\": true } }\n";
const CARGO = "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n";

describe("refusals: what runs is not in the text, so the arrow stays unjudged", () => {
  shapes("TypeScript", {
    files: {
      "tsconfig.json": TSCONFIG,
      "target.ts": [
        "export function b(x: number): number {\n  return x;\n}",
        "export class Instruments {\n  call(name: string): number {\n    return b(name.length);\n  }\n}",
        "export const registry = {\n  call(x: number): number {\n    return b(x);\n  },\n};",
        "",
      ].join("\n\n"),
      "work.ts": [
        "import { b, Instruments, registry } from \"./target\";",
        "export function handed(handler: (x: number) => number): number {\n  return handler.call(null, 1);\n}",
        "export function spread(handler: (x: number) => number, args: [number]): number {\n  return handler.apply(null, args);\n}",
        "export class Holder {\n  instruments = new Instruments();\n\n  run(): number {\n    return this.instruments.call(\"x\");\n  }\n}",
        "export function viaObject(): number {\n  return registry.call(1);\n}",
        "export function evil(code: string): unknown {\n  return eval(code);\n}",
        "export class Computed {\n  derivation: (x: number) => number = (x) => x;\n\n  run(): number {\n    return this.derivation.call(this, 1);\n  }\n}",
        "export function aliased(logger: { warn: (x: number) => number }): number {\n  const warn = logger.warn;\n  return warn.call(logger, 1);\n}",
        "export function stored(this: { cb?: (x: number) => number }): number {\n  return this.cb!(1);\n}",
        "export class Panel {\n  cb?: (x: number) => number;\n\n  bang(): number {\n    return this.cb!(1);\n  }\n\n  viaCall(): number {\n    return this.cb!.call(this, 1);\n  }\n}",
        "",
      ].join("\n\n"),
    },
    right: [
      ["a parameter's .call runs whatever was passed", "work.ts#handed", "target.ts#b"],
      ["a parameter's .apply runs whatever was passed", "work.ts#spread", "target.ts#b"],
      ["a field's .call is a method of the field's class", "work.ts#Holder.run", "target.ts#Instruments.call"],
      ["an object's own method named call reaches the head", "work.ts#viaObject", "target.ts#b"],
      ["eval can run anything", "work.ts#evil", "target.ts#b"],
      ["a class field holding a function, run through .call (mobx's derivation)", "work.ts#Computed.run", "target.ts#b"],
      ["a local holding another object's function, run through .call (vite's warn)", "work.ts#aliased", "target.ts#b"],
      ["a field holding a function, called with !", "work.ts#stored", "target.ts#b"],
      ["a class field holding a function, called with !", "work.ts#Panel.bang", "target.ts#b"],
      ["a class field holding a function, called through .call", "work.ts#Panel.viaCall", "target.ts#b"],
    ],
  });

  shapes("Python", {
    files: {
      "target.py": "def b(x):\n    return x\n\n\nclass Instruments:\n    def call(self, name):\n        return b(name)\n",
      "own.py": "from target import b\n\n\ndef getattr(obj, name):\n    return b(name)\n",
      "work.py": [
        "from target import b, Instruments\nimport own",
        "def handed(vd):\n    return vd.call(1)",
        "class Holder:\n    def __init__(self):\n        self.instruments = Instruments()\n\n    def run(self):\n        return self.instruments.call(\"x\")",
        "def by_name(obj, name):\n    return getattr(obj, name)()",
        "class Dependant:\n    def __init__(self, call):\n        self.call = call",
        "def run_endpoint(dependant: Dependant):\n    return dependant.call(1)",
        "def own_getattr(obj, name):\n    return own.getattr(obj, name)",
        "",
      ].join("\n\n\n"),
    },
    right: [
      ["a parameter's method named call may be the head's class's", "work.py#handed", "target.py#Instruments.call"],
      ["a field's method named call is the field's class's", "work.py#Holder.run", "target.py#Instruments.call"],
      ["getattr can run anything", "work.py#by_name", "target.py#b"],
      ["a field named call holds the function that runs (FastAPI's dependant.call)", "work.py#run_endpoint", "target.py#b"],
      ["the repository's own getattr reaches the head", "work.py#own_getattr", "target.py#b"],
    ],
  });

  shapes("Rust", {
    files: {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod target;\npub mod work;\n",
      "src/target.rs": [
        "pub fn b(x: i32) -> i32 {\n    x\n}",
        "pub trait Service {\n    fn call(&mut self, x: i32) -> i32;\n}",
        "pub struct Mine;",
        "impl Service for Mine {\n    fn call(&mut self, x: i32) -> i32 {\n        b(x)\n    }\n}",
        "",
      ].join("\n\n"),
      "src/work.rs": [
        "use crate::target::Service;",
        "pub struct Holder {\n    pub f: fn(i32) -> i32,\n}",
        "pub fn generic<S: Service>(s: &mut S) -> i32 {\n    s.call(1)\n}",
        "pub fn field(h: &Holder) -> i32 {\n    (h.f)(1)\n}",
        "",
      ].join("\n\n"),
    },
    right: [
      ["a trait's method named call runs whatever implements it", "src/work.rs#generic", "src/target.rs#call"],
      ["a function stored in a field, called through parentheses", "src/work.rs#field", "src/target.rs#b"],
    ],
  });
});

describe("the call is read off the call node", () => {
  shapes("TypeScript", {
    files: {
      "tsconfig.json": TSCONFIG,
      "target.ts": [
        "export function b(x: number): number {\n  return x;\n}",
        "export async function load<T>(x: T): Promise<T> {\n  return x;\n}",
        "export function apply(x: number): number {\n  return x;\n}",
        "",
      ].join("\n\n"),
      "other.ts": "export function other(x: number): number {\n  return x;\n}\n",
      "base.ts": "export class Base {\n  constructor(public x: number) {}\n}\n",
      "work.ts": [
        "import { b, load, apply } from \"./target\";\nimport { Base } from \"./base\";",
        "export function plain(): number {\n  return b(1);\n}",
        "export function viaCall(): number {\n  return b.call(null, 1);\n}",
        "export function viaApply(): number {\n  return b.apply(null, [1]);\n}",
        "export async function awaited(): Promise<number> {\n  return await load<number>(1);\n}",
        "export function parens(): number {\n  return (b)(1);\n}",
        "export function bareApply(): number {\n  return apply(1);\n}",
        "export function own(o: object, k: string): boolean {\n  return Object.prototype.hasOwnProperty.call(o, k);\n}",
        "export function match(s: string): RegExpExecArray | null {\n  return /a+/.exec(s);\n}",
        "export class Child extends Base {\n  constructor() {\n    super(1);\n  }\n}",
        "",
      ].join("\n\n"),
    },
    confirms: [
      ["a plain call calls it (the control)", "work.ts#plain", "target.ts#b"],
      ["fn.call(thisArg, x) on a function calls it", "work.ts#viaCall", "target.ts#b"],
      ["fn.apply(thisArg, xs) on a function calls it", "work.ts#viaApply", "target.ts#b"],
      ["await g<T>() calls g", "work.ts#awaited", "target.ts#load"],
      ["(f)(x) calls f", "work.ts#parens", "target.ts#b"],
      ["a function the repository names apply is a function", "work.ts#bareApply", "target.ts#apply"],
    ],
    right: [
      ["super(...) runs the class it extends", "work.ts#Child.constructor", "base.ts#Base"],
    ],
    wrong: [
      ["the function .call runs is not the head", "work.ts#viaCall", "other.ts#other"],
      ["the function .apply runs is not the head", "work.ts#viaApply", "other.ts#other"],
      ["await g<T>() is the only call", "work.ts#awaited", "other.ts#other"],
      ["(f)(x) is the only call", "work.ts#parens", "other.ts#other"],
      ["a function named apply is the only call", "work.ts#bareApply", "other.ts#other"],
      ["super(...) is the only call", "work.ts#Child.constructor", "other.ts#other"],
    ],
    wrongLive: [
      ["Object.prototype.hasOwnProperty.call is a library's", "work.ts#own", "other.ts#other"],
      ["a regular expression's exec is a library's", "work.ts#match", "other.ts#other"],
    ],
  });

  shapes("Python", {
    files: {
      "target.py": "def b(x):\n    return x\n\n\ndef call(x):\n    return x\n",
      "ins.py": "class Instruments:\n    def call(self, name):\n        return name\n",
      "other.py": "def other(x):\n    return x\n",
      "work.py": [
        "from target import b, call\nfrom ins import Instruments",
        "def parens():\n    return (b)(1)",
        "def bare_call():\n    return call(1)",
        "def method_call():\n    ins = Instruments()\n    return ins.call(\"x\")",
        "",
      ].join("\n\n\n"),
    },
    confirms: [
      ["(f)(x) calls f", "work.py#parens", "target.py#b"],
      ["a function the repository names call is a function", "work.py#bare_call", "target.py#call"],
    ],
    wrong: [
      ["(f)(x) is the only call", "work.py#parens", "other.py#other"],
      ["a function named call is the only call", "work.py#bare_call", "other.py#other"],
    ],
    wrongLive: [
      ["a method named call is an ordinary method", "work.py#method_call", "other.py#other"],
    ],
  });

  shapes("Rust", {
    files: {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod target;\npub mod other;\npub mod work;\n",
      "src/target.rs": "pub fn b(x: i32) -> i32 {\n    x\n}\n\npub fn call(x: i32) -> i32 {\n    x\n}\n",
      "src/other.rs": "pub fn other(x: i32) -> i32 {\n    x\n}\n",
      "src/work.rs": [
        "use crate::target::{b, call};",
        "pub fn parens() -> i32 {\n    (b)(1)\n}",
        "pub fn bare_call() -> i32 {\n    call(1)\n}",
        "",
      ].join("\n\n"),
    },
    confirms: [
      ["(f)(x) calls f", "src/work.rs#parens", "src/target.rs#b"],
      ["a function the crate names call is a function", "src/work.rs#bare_call", "src/target.rs#call"],
    ],
    wrong: [
      ["(f)(x) is the only call", "src/work.rs#parens", "src/other.rs#other"],
      ["a function named call is the only call", "src/work.rs#bare_call", "src/other.rs#other"],
    ],
  });
});

describe("#447: a built-in on either side of an operator", () => {
  shapes("Python", {
    files: {
      "target.py": "def render(x):\n    return x\n",
      "work.py": [
        "def left_plus(x):\n    return len(x) + 1",
        "def right_plus(x):\n    return 1 + len(x)",
        "def left_and(x):\n    return isinstance(x, int) and x > 0",
        "def right_and(x):\n    return x > 0 and isinstance(x, int)",
        "",
      ].join("\n\n\n"),
    },
    wrong: [
      ["len(x) + 1", "work.py#left_plus", "target.py#render"],
      ["1 + len(x)", "work.py#right_plus", "target.py#render"],
      ["isinstance(x, int) and x > 0", "work.py#left_and", "target.py#render"],
      ["x > 0 and isinstance(x, int)", "work.py#right_and", "target.py#render"],
    ],
  });

  shapes("TypeScript", {
    files: {
      "tsconfig.json": TSCONFIG,
      "target.ts": "export function render(x: number): number {\n  return x;\n}\n",
      "work.ts": "export function leftPlus(x: string): number {\n  return Number(x) + 1;\n}\n\nexport function rightPlus(x: string): number {\n  return 1 + Number(x);\n}\n",
    },
    wrong: [
      ["Number(x) + 1", "work.ts#leftPlus", "target.ts#render"],
      ["1 + Number(x)", "work.ts#rightPlus", "target.ts#render"],
    ],
  });
});
