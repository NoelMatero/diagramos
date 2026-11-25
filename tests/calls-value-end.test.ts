/**
 * A value is called by its name (owner decision, 2026-11-25).
 *
 * "`execute` calls `failureReason`", where `failureReason` is a field. To
 * call what a field, a variable or a key holds, code has to read it, and
 * reading it writes its name. A routine that never writes the name does not
 * call the value -- whatever calls it does make that nobody can place. 53 of
 * the 263 wrong `calls` arrows missed on the study sets point at a value,
 * and one unplaced call anywhere in the tail kept each of them "not sure".
 *
 * A routine handed the function a field once held calls its parameter, and
 * the arrow belongs at whoever read the field. What must stay a doubt is a
 * read that does not write the name: a computed key, `getattr`,
 * `Object.values`, an import that renames. Those come first, per language.
 *
 * And tests are left out of "is it handed around" (owner decision 2): what a
 * test hands in is not what the product calls.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { wouldHelp } from "../src/engine/referee";
import { storedIn } from "../src/engine/stored";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);

type Files = Record<string, string>;
type Arrow = { from: [string, string]; to: [string, ...string[]] };

function verdict(files: Files, arrow: Arrow, index = true): CallsVerdict {
  const sources = Object.entries(files).map(([file, source]) => ({ file, source, language: languageOf(file)! }));
  const stored = storedIn(() => sources);
  const product = (name: string, member: boolean, language: Language) =>
    stored.findings(name, member, language).filter((one) => !(one as { test?: true }).test);
  const sideOf = (file: string): CallSide => ({
    file,
    source: files[file]!,
    language: languageOf(file) as Language,
    imports: importsOf(files, file),
    open: (wanted) => files[wanted] === undefined ? undefined : { source: files[wanted]!, language: languageOf(wanted)!, imports: [] },
    ...(index ? {
      runsUnderAnotherName: (name: string, member: boolean, language: Language) => product(name, member, language).length > 0,
      storedFindings: product,
    } : {}),
  } as CallSide);
  const [fromFile, routine] = arrow.from;
  const [toFile, ...names] = arrow.to;
  return callsBetween({ ...sideOf(fromFile), routine }, { ...sideOf(toFile), names });
}

const byName = (one: CallsVerdict) => one.verdict === "refuted" && one.evidence.valueNeverNamed === true;
/** A file's imports as each language's dependency reader hands them over: `./b`, `pkg.b`, `crate::b::name`. */
function importsOf(files: Files, file: string): CallSide["imports"] {
  const out: CallSide["imports"] = [];
  const source = files[file]!;
  for (const other of Object.keys(files)) {
    if (other === file) continue;
    const stem = other.replace(/\.\w+$/, "");
    if (other.endsWith(".py")) out.push({ specifier: stem.split("/").join("."), file: other });
    else if (other.endsWith(".rs")) {
      const module = stem.replace(/^src\//, "").replace(/^lib$/, "").split("/").join("::");
      for (const use of source.matchAll(new RegExp(`\\bcrate::${module ? `${module}::` : ""}(\\w+)`, "g"))) out.push({ specifier: use[0], file: other });
    } else out.push({ specifier: `./${stem}`, file: other });
  }
  return out;
}

const red = (one: CallsVerdict) => one.verdict === "refuted" || one.verdict === "wrong-routine" || one.verdict === "backwards";

async function checked(files: Files, from: string, to: string) {
  const repo = mkdtempSync(path.join(tmpdir(), "calls-value-end-"));
  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), source);
    }
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "a", label: "from", ref: from }, { id: "b", label: "to", ref: to }],
      edges: [{ from: "a", to: "b", claim: "calls" }],
    });
    const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
    return { report, reds: report.edges.filter((one) => ACCUSING.has(one.kind)) };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------- TypeScript */

describe("TypeScript: a value the tail never names", () => {
  // `execute` calls a callback nobody can place, and never writes `failureReason` or `retry`.
  const STATE = "export class Mutation {\n  failureReason: Error | null = null;\n  retry: (n: number) => void;\n  options = { unit: \"ms\", onError: undefined as any };\n\n"
    + "  execute(cb: () => void) {\n    cb();\n    return 1;\n  }\n\n"
    + "  fail(cb: () => void) {\n    cb();\n    this.retry(1);\n  }\n}\n";
  const files: Files = { "mutation.ts": STATE };
  const arrow = (head: string, tail = "execute"): Arrow => ({ from: ["mutation.ts", tail], to: ["mutation.ts", head] });

  it("before the rule, the callback keeps the arrow a doubt (no index)", () => {
    expect(red(verdict(files, arrow("retry"), false))).toBe(false);
  });

  it("a field that may hold a function, never written in the tail", () => {
    expect(byName(verdict(files, arrow("retry")))).toBe(true);
  });

  it("a field holding data", () => {
    expect(byName(verdict(files, arrow("failureReason")))).toBe(true);
  });

  it("a key of an object literal", () => {
    expect(byName(verdict(files, arrow("onError")))).toBe(true);
    expect(byName(verdict(files, arrow("unit")))).toBe(true);
  });

  it("a local of another function", () => {
    const local = { "a.ts": "export function load() {\n  const hook = pick();\n  return hook;\n}\n\nexport function run(cb: () => void) {\n  cb();\n}\n" };
    expect(byName(verdict(local, { from: ["a.ts", "run"], to: ["a.ts", "hook"] }))).toBe(true);
  });

  it("the tail that does write it is not accused by this rule", () => {
    expect(byName(verdict(files, arrow("retry", "fail")))).toBe(false);
  });

  it("what a catch or a loop binds is a value too", () => {
    const bound = {
      "load.ts": "export function load(xs: any[]) {\n  try {\n    go();\n  } catch (e) {\n    report(e);\n  }\n  for (const item of xs) report(item);\n}\n\n"
        + "export function run(cb: () => void) {\n  cb();\n}\n",
    };
    expect(byName(verdict(bound, { from: ["load.ts", "run"], to: ["load.ts", "e"] }))).toBe(true);
    expect(byName(verdict(bound, { from: ["load.ts", "run"], to: ["load.ts", "item"] }))).toBe(true);
  });

  it("a tail whose every call was read keeps the red it already had, and its sentence", () => {
    // Nothing here is a doubt: the closed reading refutes on its own, as it did before the rule.
    const closed = { "mutation.ts": STATE.replace("  execute(cb: () => void) {\n    cb();", "  execute(cb: () => void) {\n    helper();") + "\nfunction helper() {}\n" };
    const one = verdict(closed, arrow("retry"));
    expect(one.verdict).toBe("refuted");
    expect(byName(one)).toBe(false);
  });

  const quiet: Record<string, [Files, Arrow]> = {
    "the tail reads it by destructuring": [
      { "mutation.ts": STATE.replace("    cb();\n    return 1;", "    const { retry } = this;\n    cb();\n    return 1;") }, arrow("retry"),
    ],
    "the tail reads it by its name in a string": [
      { "mutation.ts": STATE.replace("    cb();\n    return 1;", "    cb();\n    return (this as any)[\"retry\"];") }, arrow("retry"),
    ],
    "the tail reads a member by a computed key": [
      { "mutation.ts": STATE.replace("execute(cb: () => void) {\n    cb();", "execute(cb: () => void, key: string) {\n    (this as any)[key](1);") }, arrow("retry"),
    ],
    "the tail reads every member (Object.values)": [
      { "mutation.ts": STATE.replace("    cb();\n    return 1;", "    for (const f of Object.values(this)) f();\n    return 1;") }, arrow("retry"),
    ],
    "the tail imports it under another name": [
      {
        "table.ts": "export const handlers = makeHandlers();\n",
        "run.ts": "import { handlers as h } from \"./table\";\nexport function run(cb: () => void) {\n  cb();\n  h();\n}\n",
      },
      { from: ["run.ts", "run"], to: ["table.ts", "handlers"] },
    ],
    "the tail imports the far end's file by default": [
      {
        "table.ts": "const handlers = makeHandlers();\nexport default handlers;\n",
        "run.ts": "import h from \"./table\";\nexport function run(cb: () => void) {\n  cb();\n  h();\n}\n",
      },
      { from: ["run.ts", "run"], to: ["table.ts", "handlers"] },
    ],
    "another file renames it on the way out, and the tail may import that name": [
      {
        "table.ts": "export const handlers = makeHandlers();\n",
        "barrel.ts": "export { handlers as hooks } from \"./table\";\n",
        "run.ts": "import { hooks } from \"./barrel\";\nexport function run(cb: () => void) {\n  cb();\n  hooks();\n}\n",
      },
      { from: ["run.ts", "run"], to: ["table.ts", "handlers"] },
    ],
    "the far end stands for another name, and the tail writes that one": [
      {
        "api.ts": "export function get() {}\nexport const fetch = get;\n",
        "run.ts": "import { get } from \"./api\";\nexport function run(cb: () => void) {\n  cb();\n  get();\n}\n",
      },
      { from: ["run.ts", "run"], to: ["api.ts", "fetch"] },
    ],
    "the far end is a name given on the way out (export { get as fetch })": [
      {
        "api.ts": "function get() {}\nexport { get as fetch };\n",
        "run.ts": "export function run(cb: () => void) {\n  cb();\n}\n",
      },
      { from: ["run.ts", "run"], to: ["api.ts", "fetch"] },
    ],
    "the far end is a function written into the field": [
      { "mutation.ts": STATE.replace("retry: (n: number) => void;", "retry = (n: number) => {};") }, arrow("retry"),
    ],
    "the far end is given a function somewhere in its file": [
      { "mutation.ts": `${STATE}\nexport function wire(m: Mutation) {\n  m.retry = function (n: number) {};\n}\n` }, arrow("retry"),
    ],
    "the far end is a method": [{ "mutation.ts": STATE }, arrow("fail")],
    "the far end is a class": [{ "mutation.ts": STATE }, arrow("Mutation")],
    "the far end is a type alias": [{ "mutation.ts": `export type Retry = (n: number) => void;\n${STATE}` }, arrow("Retry")],
    "the far end is brought in from another file, where it may be a routine": [
      { "mutation.ts": `import { retryNow } from "./retry";\n${STATE}`, "retry.ts": "export function retryNow() {}\n" }, arrow("retryNow"),
    ],
    "the tail is a class with a base in another file, whose code is not read": [
      {
        "mutation.ts": "export const hook = pick();\n",
        "worker.ts": "import { Base } from \"./base\";\nexport class Worker extends Base {\n  run(cb: () => void) {\n    cb();\n  }\n}\n",
        "base.ts": "export class Base {}\n",
      },
      { from: ["worker.ts", "Worker"], to: ["mutation.ts", "hook"] },
    ],
  };
  for (const [shape, [changed, which]] of Object.entries(quiet)) {
    it(`stays quiet when ${shape}`, () => {
      expect(byName(verdict(changed, which))).toBe(false);
    });
  }

  it("plain data cannot be called whatever reads it: a computed key does not keep it a doubt", () => {
    const data = { "mutation.ts": STATE.replace("execute(cb: () => void) {\n    cb();", "execute(cb: () => void, key: string) {\n    (this as any)[key](1);") };
    expect(byName(verdict(data, arrow("unit")))).toBe(true);
    expect(byName(verdict(data, arrow("retry")))).toBe(false);
  });

  it("a member of an enum is a number or a string: a computed key in the tail does not keep it a doubt", () => {
    const files = {
      "ast.ts": "export enum NodeTypes {\n  ROOT,\n  VNODE_CALL,\n  TEXT = 9,\n}\n",
      "run.ts": "export function run(cb: () => void, props: any[], i: number) {\n  cb();\n  return props[i];\n}\n",
    };
    expect(byName(verdict(files, { from: ["run.ts", "run"], to: ["ast.ts", "VNODE_CALL"] }))).toBe(true);
    expect(byName(verdict(files, { from: ["run.ts", "run"], to: ["ast.ts", "TEXT"] }))).toBe(true);
  });

  it("with no index of renames, nothing is said", () => {
    expect(byName(verdict(files, arrow("retry"), false))).toBe(false);
  });
});

/* ----------------------------------------------------------------- Python */

describe("Python: a value the tail never names", () => {
  const SCHEMA = "LIMIT = load_limit()\n\n\nclass Schema:\n    opts = make_opts()\n\n"
    + "    def __init__(self, many):\n        self.many = many\n        self.dump_fields = build()\n\n"
    + "    def load(self, data, hook):\n        hook(data)\n        return data\n\n"
    + "    def dump(self, data, hook):\n        hook(data)\n        return self.dump_fields(data)\n";
  const files: Files = { "schema.py": SCHEMA };
  const arrow = (head: string, tail = "load"): Arrow => ({ from: ["schema.py", tail], to: ["schema.py", head] });

  it("an attribute set in a method", () => {
    expect(byName(verdict(files, arrow("dump_fields")))).toBe(true);
  });

  it("a class attribute, a module variable, a parameter of another routine", () => {
    expect(byName(verdict(files, arrow("opts")))).toBe(true);
    expect(byName(verdict(files, arrow("LIMIT")))).toBe(true);
    expect(byName(verdict(files, arrow("many")))).toBe(true);
  });

  it("the tail that does write it is not accused by this rule", () => {
    expect(byName(verdict(files, arrow("dump_fields", "dump")))).toBe(false);
  });

  const quiet: Record<string, [Files, Arrow]> = {
    "the tail reads an attribute by a computed name (getattr)": [
      { "schema.py": SCHEMA.replace("        hook(data)\n        return data", "        getattr(self, hook)(data)\n        return data") }, arrow("dump_fields"),
    ],
    "the tail reads a key that is not written out": [
      { "schema.py": SCHEMA.replace("        hook(data)\n        return data", "        self.table[hook](data)\n        return data") }, arrow("dump_fields"),
    ],
    "the value is kept under a key, and the tail walks every value of a dictionary (.items())": [
      { "schema.py": `HOOKS = {"after": build()}\n\n${SCHEMA.replace("        hook(data)\n        return data", "        for _, f in hook.items():\n            f(data)\n        return data")}` }, arrow("after"),
    ],
    "the value is kept under a key, and the tail reads a key it does not write (.get(k))": [
      { "schema.py": `HOOKS = {"after": build()}\n\n${SCHEMA.replace("        hook(data)\n        return data", "        hook.get(data)(data)\n        return data")}` }, arrow("after"),
    ],
    "the tail reads the object's dictionary": [
      { "schema.py": SCHEMA.replace("        hook(data)\n        return data", "        self.__dict__[hook](data)\n        return data") }, arrow("dump_fields"),
    ],
    "the tail imports it under another name": [
      { "limits.py": "LIMIT = load_limit()\n", "run.py": "from limits import LIMIT as cap\n\n\ndef run(hook):\n    hook()\n    return cap()\n" },
      { from: ["run.py", "run"], to: ["limits.py", "LIMIT"] },
    ],
    "the far end stands for another name, and the tail writes that one": [
      { "schema.py": SCHEMA.replace("        self.many = many\n", "        self.many = many\n        self.after = hook\n") }, arrow("after"),
    ],
    "the far end is a lambda": [{ "schema.py": SCHEMA.replace("LIMIT = load_limit()", "LIMIT = lambda: 3") }, arrow("LIMIT")],
    "the far end is a function": [{ "schema.py": SCHEMA }, arrow("dump")],
    "the far end is a class": [{ "schema.py": SCHEMA }, arrow("Schema")],
    "the far end is a dunder": [{ "schema.py": SCHEMA }, arrow("__init__")],
    "the far end is an alias the file says is a type": [
      { "schema.py": `from typing import Callable, TypeAlias\n\nHook: TypeAlias = Callable[[dict], None]\n${SCHEMA}` }, arrow("Hook"),
    ],
    "the far end is brought in from another file": [
      { "schema.py": `from hooks import after\n${SCHEMA}`, "hooks.py": "def after():\n    pass\n" }, arrow("after"),
    ],
    "the tail is a class with a base in another file": [
      { "limits.py": "LIMIT = load_limit()\n", "worker.py": "from base import Base\n\n\nclass Worker(Base):\n    def run(self, hook):\n        hook()\n", "base.py": "class Base:\n    pass\n" },
      { from: ["worker.py", "Worker"], to: ["limits.py", "LIMIT"] },
    ],
  };
  for (const [shape, [changed, which]] of Object.entries(quiet)) {
    it(`stays quiet when ${shape}`, () => {
      expect(byName(verdict(changed, which))).toBe(false);
    });
  }

  it("a key is a value too, and a dictionary method on something else does not keep an attribute a doubt", () => {
    expect(byName(verdict({ "schema.py": `HOOKS = {"after": build()}\n\n${SCHEMA}` }, arrow("after")))).toBe(true);
    // flask's `wsgi_app` calls `ctx.pop(error)`: `.pop` reads a dictionary's key, never an attribute or a parameter.
    const pops = { "schema.py": SCHEMA.replace("        hook(data)\n        return data", "        hook(data)\n        return data.pop(hook)") };
    expect(byName(verdict(pops, arrow("dump_fields")))).toBe(true);
    expect(byName(verdict(pops, arrow("many")))).toBe(true);
  });

  it("the name in a comment or a docstring is not the name written", () => {
    const talked = { "schema.py": SCHEMA.replace("        hook(data)\n        return data", "        \"\"\"Runs before dump_fields is built.\"\"\"\n        hook(data)  # not dump_fields\n        return data") };
    expect(byName(verdict(talked, arrow("dump_fields")))).toBe(true);
  });
});

/* ------------------------------------------------------------------- Rust */

describe("Rust: a value the tail never names", () => {
  const LIB = "pub static HOOK: fn(u32) -> u32 = pick();\n\npub struct Job {\n    pub done: fn(u32),\n    pub id: u32,\n}\n\n"
    + "pub fn run<F: Fn(u32)>(f: F, job: &Job) {\n    f(job.id);\n}\n\n"
    + "pub fn finish(job: &Job) {\n    (job.done)(job.id);\n}\n";
  const files: Files = { "src/lib.rs": LIB };
  const arrow = (head: string, tail = "run"): Arrow => ({ from: ["src/lib.rs", tail], to: ["src/lib.rs", head] });

  it("a field holding a function, and a static", () => {
    expect(byName(verdict(files, arrow("done")))).toBe(true);
    expect(byName(verdict(files, arrow("HOOK")))).toBe(true);
  });

  it("the tail that does write it is not accused by this rule", () => {
    expect(byName(verdict(files, arrow("done", "finish")))).toBe(false);
  });

  const quiet: Record<string, [Files, Arrow]> = {
    "the tail imports it under another name": [
      { "src/lib.rs": "pub static HOOK: fn(u32) -> u32 = pick();\n", "src/run.rs": "use crate::HOOK as H;\n\npub fn run<F: Fn(u32)>(f: F) {\n    f(1);\n    H(2);\n}\n" },
      { from: ["src/run.rs", "run"], to: ["src/lib.rs", "HOOK"] },
    ],
    "the far end is an enum's variant, which is called to build a value": [
      { "src/lib.rs": `pub enum Kind {\n    Done(u32),\n}\n\n${LIB}` }, arrow("Done"),
    ],
    "the far end is a function": [{ "src/lib.rs": LIB }, arrow("finish")],
    "the far end is a struct": [{ "src/lib.rs": LIB }, arrow("Job")],
    "the far end is a name the file writes and does not declare, which a macro may have made a function": [
      { "src/lib.rs": `make_hook!(after);\n\n${LIB}` }, arrow("after"),
    ],
    "the far end is a closure kept in a static": [
      { "src/lib.rs": LIB.replace("pub static HOOK: fn(u32) -> u32 = pick();", "pub static HOOK: fn(u32) -> u32 = |x| x;") }, arrow("HOOK"),
    ],
  };
  for (const [shape, [changed, which]] of Object.entries(quiet)) {
    it(`stays quiet when ${shape}`, () => {
      expect(byName(verdict(changed, which))).toBe(false);
    });
  }
});

/* -------------------------------------------------- through the whole check */

describe("through the whole check", () => {
  const TS = "export class Mutation {\n  retry: (n: number) => void;\n  limit = 5;\n\n"
    + "  execute(cb: () => void) {\n    cb();\n    return 1;\n  }\n}\n";

  it("says the far end is a value, and that the tail never writes its name", async () => {
    const { reds } = await checked({ "mutation.ts": TS }, "mutation.ts#execute", "mutation.ts#retry");
    expect(reds.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(reds[0]!.detail).toContain("`retry` in mutation.ts is a value, not a routine");
    expect(reds[0]!.detail).toContain("nothing in execute writes `retry`");
  }, 60_000);

  it("the wrong-kind check keeps the first word where it can say the value cannot be called", async () => {
    const { reds } = await checked({ "mutation.ts": TS }, "mutation.ts#execute", "mutation.ts#limit");
    expect(reds.map((one) => one.kind)).toEqual(["end-lacks-part"]);
    expect(reds[0]!.detail).toContain("holds data, and cannot be called");
  }, 60_000);

  it("waits for the compilers like any other new red", async () => {
    const { report } = await checked({ "mutation.ts": TS }, "mutation.ts#execute", "mutation.ts#retry");
    expect(report.gated.map((one) => [one.kind, one.outcome, one.asked])).toEqual([["calls-refuted", "stands", true]]);
    expect(wouldHelp(report)).toBe(true);
  }, 60_000);

  it("leaves a tail that calls the value alone", async () => {
    const calls = TS.replace("    cb();\n    return 1;", "    cb();\n    return this.retry(1);");
    const { reds } = await checked({ "mutation.ts": calls }, "mutation.ts#execute", "mutation.ts#retry");
    expect(reds).toEqual([]);
  }, 60_000);
});

/* -------------------------------- tests left out of "is it handed around" */

describe("what a test hands in is not what the product calls (owner decision 2)", () => {
  const found = (files: Files, name: string, member: boolean, language: Language) => {
    const sources = Object.entries(files).map(([file, source]) => ({ file, source, language: languageOf(file)! }));
    return storedIn(() => sources).findings(name, member, language).map((one) => [one.how, (one as { test?: true }).test === true]);
  };

  it("marks what a test file writes, in each language's own conventions", () => {
    const wrapped = "import { promote } from \"../src/job\";\nit(\"promotes\", () => promote());\n";
    for (const file of ["tests/job.ts", "src/__tests__/job.ts", "src/job.test.ts", "src/job.spec.tsx", "e2e/job.ts", "src/job.bench.ts"]) {
      expect(found({ [file]: wrapped }, "promote", false, "ts")).toEqual([["wrapped", true]]);
    }
    const handed = "from job import promote\n\nHOOKS = [promote]\n";
    for (const file of ["tests/hooks.py", "pkg/test_hooks.py", "pkg/hooks_test.py", "conftest.py"]) {
      expect(found({ [file]: handed }, "promote", false, "python")).toEqual([["value", true]]);
    }
    const rust = "use m::promote;\n\npub fn keep() -> fn() {\n    promote\n}\n";
    for (const file of ["tests/hooks.rs", "benches/hooks.rs"]) {
      expect(found({ [file]: rust }, "promote", false, "rust")).toEqual([["value", true]]);
    }
  });

  it("does not mark the product, its examples or its own testing helpers", () => {
    const handed = "from job import promote\n\nHOOKS = [promote]\n";
    for (const file of ["pkg/hooks.py", "examples/hooks.py", "docs_src/hooks.py", "pkg/testing/hooks.py", "pkg/contest.py", "pkg/latest.py"]) {
      expect(found({ [file]: handed }, "promote", false, "python")).toEqual([["value", false]]);
    }
  });

  it("Rust: marks a #[cfg(test)] module and a #[test] function written beside the product", () => {
    const source = "use crate::job::promote;\n\npub fn keep() -> fn() {\n    promote\n}\n\n"
      + "#[cfg(test)]\nmod tests {\n    use super::*;\n\n    #[test]\n    fn runs() {\n        let f = promote;\n        f();\n    }\n}\n\n"
      + "#[tokio::test]\nasync fn alone() {\n    let g = promote;\n    g();\n}\n";
    expect(found({ "src/wire.rs": source }, "promote", false, "rust")).toEqual([["value", false], ["value", true], ["value", true]]);
  });

  it("a test's nameless function no longer keeps a wrong arrow quiet", () => {
    const files: Files = {
      "run.ts": "export function run(h: any, e: Error) {\n  h.onError(e);\n}\n",
      "worker.ts": "export function handleFailed(e: Error) {\n  return e;\n}\n",
      "worker.test.ts": "import { handleFailed } from \"./worker\";\nit(\"fails\", () => handleFailed(new Error(\"x\")));\n",
    };
    const arrow: Arrow = { from: ["run.ts", "run"], to: ["worker.ts", "handleFailed"] };
    expect(verdict(files, arrow).verdict).toBe("refuted");
    // The same function written in the product is what a call of another name may run.
    const product = { ...files, "wire.ts": "import { handleFailed } from \"./worker\";\nexport const h = { onError: (e: Error) => handleFailed(e) };\n" };
    expect(red(verdict(product, arrow))).toBe(false);
  });

  it("through the whole check: an arrow drawn from a test still counts what tests hand around", async () => {
    const files: Files = {
      "tests/test_openapi.py":
        "from tests.helpers import get_fields\n\nHOOKS = {\"setdefault\": get_fields}\n\n\n"
        + "def test_path(operation):\n    operation.setdefault(1)\n",
      "tests/helpers.py": "def get_fields(routes):\n    return routes\n",
    };
    expect((await checked(files, "tests/test_openapi.py#test_path", "tests/helpers.py#get_fields")).reds).toEqual([]);
  }, 60_000);

  it("through the whole check: a Python test that stores the routine is not counted, the product is", async () => {
    const files: Files = {
      "openapi.py": "def get_openapi_path(route, operation):\n    operation.setdefault(route)\n    return operation\n\n\ndef get_fields(routes):\n    return routes\n",
      "tests/test_openapi.py": "from openapi import get_fields\n\nHOOKS = {\"setdefault\": get_fields}\n",
    };
    expect((await checked(files, "openapi.py#get_openapi_path", "openapi.py#get_fields")).reds.map((one) => one.kind)).toEqual(["calls-refuted"]);
    const product = { ...files, "hooks.py": "from openapi import get_fields\n\nHOOKS = {\"setdefault\": get_fields}\n" };
    expect((await checked(product, "openapi.py#get_openapi_path", "openapi.py#get_fields")).reds).toEqual([]);
  }, 60_000);
});
