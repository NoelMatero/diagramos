/**
 * "Could this call run the far end?" -- the question a wrong `calls` arrow
 * needs answered about a call nobody can place (calls research, 2026-11).
 *
 * Before, one call the checker could not follow kept the whole arrow "not
 * sure": a callback (`handler(req)`), a method on an untyped value, a macro.
 * 166 of the 263 wrong `calls` arrows missed on the study sets stopped there.
 * Where such a call goes is often unknowable; whether it can be the far end
 * is not. Four tests, each a fact about the language:
 *
 *   shape   Python, Rust: a call passing arguments the far end cannot take
 *   name    Rust: `x.search()` runs a method declared `search`
 *   made    TypeScript, Python: `new Session()` runs the constructor
 *   macro   Rust: a `macro_rules!` of the repository runs what its template names
 *
 * The risk is a correct arrow called wrong, so every way each test must stay
 * quiet comes first, per language, and each is one change away from a case
 * that goes red -- a refusal that passes because nothing could have gone red
 * tests nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type ClosedBodyReferee } from "../src/engine/drift";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { wouldHelp } from "../src/engine/referee";
import { storedIn } from "../src/engine/stored";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);

type Files = Record<string, string>;
type Arrow = { from: [string, string]; to: [string, ...string[]] };

/** The arrow over `files` with no compiler, the repository's index of stored routines handed in as `drift.ts` hands it. */
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
const why = (one: CallsVerdict) => one.verdict === "absent" ? one.notClosed : one.verdict === "withheld" ? one.why : one.verdict;

/** The accusing findings of one `calls` arrow through the whole check, and the report. */
async function checked(files: Files, from: string, to: string, referee?: ClosedBodyReferee) {
  const repo = mkdtempSync(path.join(tmpdir(), "calls-could-run-"));
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
    const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) });
    return { report, reds: report.edges.filter((one) => ACCUSING.has(one.kind)) };
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ shape */

/**
 * `run` calls a function it was handed with two arguments. `connect` takes
 * three and is handed around elsewhere, as a real handler is: the name rule
 * (#351) cannot rule it out, and the call cannot be placed.
 */
const PY_RUN = "def run(handler):\n    return handler(\"x\", 1)\n";
const PY_HEAD = "def connect(req, traces, timeout):\n    return req\n";
const PY_KEPT = "from net import connect\n\nHANDLERS = [connect]\n";
const PY: Files = { "run.py": PY_RUN, "net.py": PY_HEAD, "wire.py": PY_KEPT };
const PY_ARROW: Arrow = { from: ["run.py", "run"], to: ["net.py", "connect"] };

const RS_RUN = "pub fn run<F: Fn(u32) -> u32>(f: F, x: u32) -> u32 {\n    f(x)\n}\n";
const RS_HEAD = "pub fn two(x: u32, y: u32) -> u32 {\n    x * y\n}\n";
const RS_KEPT = "use crate::net::two;\n\npub fn keep() -> fn(u32, u32) -> u32 {\n    two\n}\n";
const RS: Files = { "src/run.rs": RS_RUN, "src/net.rs": RS_HEAD, "src/wire.rs": RS_KEPT };
const RS_ARROW: Arrow = { from: ["src/run.rs", "run"], to: ["src/net.rs", "two"] };

describe("shape: a call passing arguments the far end cannot take is not a call of it", () => {
  it("before the rule, a function value's call is a doubt in every language (no index, nothing to ask)", () => {
    expect(why(verdict(PY, PY_ARROW, false))).toBe("local-callee");
    expect(why(verdict(RS, RS_ARROW, false))).toBe("local-callee");
  });

  it("Python: two arguments are not a call of a function that needs three", () => {
    const one = verdict(PY, PY_ARROW);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && one.evidence.misfit).toBe(1);
  });

  it("Rust: one argument is not a call of a function that takes two", () => {
    const one = verdict(RS, RS_ARROW);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && one.evidence.misfit).toBe(1);
  });

  it("the red waits for the compilers: it carries the call it ruled out", () => {
    const one = verdict(PY, PY_ARROW);
    expect(one.verdict === "refuted" && one.evidence.ruledOutAt).toEqual([{ start: PY_RUN.indexOf("handler(\""), end: PY_RUN.indexOf("handler(\"") + "handler".length }]);
  });

  it("an adapter built somewhere else is not a direct call (owner decision 1): partial, in another function", () => {
    const files = { ...PY, "wire.py": "from functools import partial\nfrom net import connect\n\n\ndef make():\n    return partial(connect, traces=[])\n" };
    expect(verdict(files, PY_ARROW).verdict).toBe("refuted");
  });

  describe("Python: what keeps the arrow a doubt", () => {
    const quiet: Record<string, Files> = {
      "the call fits the far end": { ...PY, "net.py": "def connect(req, traces):\n    return req\n" },
      "the far end has a default for what the call leaves out": { ...PY, "net.py": "def connect(req, traces, timeout=3):\n    return req\n" },
      "the far end takes any number (*args)": { ...PY, "net.py": "def connect(*args):\n    return args\n" },
      "the call spreads a list (*args)": { ...PY, "run.py": "def run(handler, args):\n    return handler(*args)\n" },
      "the call spreads keywords (**kw)": { ...PY, "run.py": "def run(handler, kw):\n    return handler(\"x\", **kw)\n" },
      "the far end is decorated, and the decorator may answer with any shape": {
        ...PY, "net.py": "from deco import traced\n\n\n@traced\ndef connect(req, traces, timeout):\n    return req\n",
      },
      "the far end is a method, handed on unbound: the value is its first argument": {
        ...PY, "net.py": "class Net:\n    def connect(self, req):\n        return req\n", "wire.py": "from net import Net\n\nHANDLERS = [Net.connect]\n",
      },
      "the far end is a method, handed on bound": {
        ...PY, "net.py": "class Net:\n    def connect(self, req, n):\n        return req\n", "wire.py": "from net import Net\n\nHANDLERS = [Net().connect]\n",
      },
      "the far end's first parameter is named self, wherever it is written": {
        ...PY, "net.py": "def connect(self, req, n):\n    return req\n",
      },
      "the far end is put on a class, which fills its first parameter": {
        ...PY, "wire.py": "from net import connect\n\n\nclass Client:\n    send = connect\n",
      },
      "the far end is set on a class from outside": {
        ...PY, "wire.py": "from net import connect\nfrom client import Client\n\nClient.send = connect\n",
      },
      "one of two declarations of the far end fits": {
        ...PY, "net.py": "import sys\n\nif sys.version_info > (3, 12):\n    def connect(req, traces, timeout):\n        return req\nelse:\n    def connect(req, n):\n        return req\n",
      },
      "the name is also a value in that file, which has no parameters to hold a call to": {
        ...PY, "net.py": `${PY_HEAD}\n\nconnect = wrap(connect)\n`,
      },
      "a function with no name that calls the far end fits the call": {
        ...PY, "wire.py": "from net import connect\n\nHANDLERS = [lambda req, n: connect(req, [], n)]\n",
      },
      "a function with no name that calls the far end takes any number": {
        ...PY, "wire.py": "from net import connect\n\nHANDLERS = [lambda *a: connect(*a)]\n",
      },
      "the adapter is built in the same function: the body names the far end": {
        ...PY, "run.py": "from functools import partial\nfrom net import connect\n\n\ndef run():\n    handler = partial(connect, traces=[])\n    return handler(\"x\", 1)\n",
      },
      "the call is handed a function of this repository, which it may run": {
        ...PY,
        "run.py": "from net import helper\n\n\ndef run(pool):\n    return pool.submit(helper, 1)\n",
        "net.py": `${PY_HEAD}\n\ndef helper(x):\n    return x\n`,
      },
    };
    for (const [shape, files] of Object.entries(quiet)) {
      it(`stays quiet when ${shape}`, () => {
        expect(red(verdict(files, PY_ARROW))).toBe(false);
      });
    }

    it("stays quiet about a routine the language calls with arguments of its own (a dunder), except __call__", () => {
      const files = {
        "run.py": PY_RUN,
        "net.py": "class Net:\n    def __init__(self, a, b, c):\n        self.a = a\n\n    def __call__(self, a, b, c):\n        return a\n",
        "wire.py": "from net import Net\n\nHANDLERS = [Net]\n",
      };
      expect(red(verdict(files, { from: ["run.py", "run"], to: ["net.py", "__init__"] }))).toBe(false);
      // `handler("x", 1)` on an instance runs `__call__(self, "x", 1)`: three wanted, two given.
      expect(verdict(files, { from: ["run.py", "run"], to: ["net.py", "__call__"] }).verdict).toBe("refuted");
    });

    it("reads keywords: a keyword the far end has no parameter for rules it out, one it has does not", () => {
      const run = "def run(fn, box):\n    return fn(box, key=1)\n";
      const head = (list: string) => `def keyed(${list}):\n    return other\n`;
      const kept = "from net import keyed\n\nHANDLERS = [keyed]\n";
      const arrow: Arrow = { from: ["run.py", "run"], to: ["net.py", "keyed"] };
      expect(red(verdict({ "run.py": run, "net.py": head("other, *, key"), "wire.py": kept }, arrow))).toBe(false);
      expect(red(verdict({ "run.py": run, "net.py": head("other, **options"), "wire.py": kept }, arrow))).toBe(false);
      expect(verdict({ "run.py": run, "net.py": head("other"), "wire.py": kept }, arrow).verdict).toBe("refuted");
      expect(verdict({ "run.py": run, "net.py": head("other, *, key, must"), "wire.py": kept }, arrow).verdict).toBe("refuted");
    });

    it("rules out a function with no name that does not fit either", () => {
      const files = { ...PY, "wire.py": "from net import connect\n\nHANDLERS = [lambda req: connect(req, [], 3)]\n" };
      expect(verdict(files, PY_ARROW).verdict).toBe("refuted");
    });
  });

  describe("Rust: what keeps the arrow a doubt", () => {
    const quiet: Record<string, Files> = {
      "the call fits the far end": { ...RS, "src/net.rs": "pub fn two(x: u32) -> u32 {\n    x\n}\n" },
      "an attribute macro may have rewritten the far end": { ...RS, "src/net.rs": `#[instrument]\n${RS_HEAD}` },
      "the far end is a method handed on by its path: the value is one more argument": {
        ...RS,
        "src/net.rs": "pub struct Net;\n\nimpl Net {\n    pub fn two(self) -> u32 {\n        1\n    }\n}\n",
        "src/wire.rs": "use crate::net::Net;\n\npub fn keep() -> fn(Net) -> u32 {\n    Net::two\n}\n",
      },
      "a closure that calls the far end fits the call": {
        ...RS, "src/wire.rs": "use crate::net::two;\n\npub fn keep() -> Box<dyn Fn(u32) -> u32> {\n    Box::new(move |j| two(j, 1))\n}\n",
      },
      "a closure that calls the far end takes its one argument as `_`": {
        ...RS, "src/wire.rs": "use crate::net::two;\n\npub fn keep() -> Box<dyn Fn(u32) -> u32> {\n    Box::new(|_| two(1, 1))\n}\n",
      },
      "the value is run through `.call`, whose arguments are a tuple": {
        ...RS, "src/run.rs": "pub fn run<F: Fn(u32) -> u32>(f: F, x: u32) -> u32 {\n    f.call((x,))\n}\n",
      },
      "the name is also a constant in that file": { ...RS, "src/net.rs": `${RS_HEAD}\npub const two: u32 = 2;\n` },
    };
    for (const [shape, files] of Object.entries(quiet)) {
      it(`stays quiet when ${shape}`, () => {
        expect(red(verdict(files, RS_ARROW))).toBe(false);
      });
    }

    it("rules out a closure that does not fit either", () => {
      const files = { ...RS, "src/wire.rs": "use crate::net::two;\n\npub fn keep() -> Box<dyn Fn() -> u32> {\n    Box::new(|| two(1, 1))\n}\n" };
      expect(verdict(files, RS_ARROW).verdict).toBe("refuted");
    });
  });

  it("TypeScript and JavaScript take any number of arguments: the count rules nothing out", () => {
    const files = {
      "run.ts": "export function run(handler: any) {\n  return handler(\"x\", 1);\n}\n",
      "net.ts": "export function connect(req: string, traces: string[], timeout: number) {\n  return req;\n}\n",
      "wire.ts": "import { connect } from \"./net\";\nexport const HANDLERS = [connect];\n",
    };
    expect(why(verdict(files, { from: ["run.ts", "run"], to: ["net.ts", "connect"] }))).toBe("local-callee");
  });

  it("with no index of where the far end is kept, nothing is ruled out", () => {
    expect(red(verdict(PY, PY_ARROW, false))).toBe(false);
    expect(red(verdict(RS, RS_ARROW, false))).toBe(false);
  });

  describe("the forward reading asks the same question", () => {
    // `environ["hook"](ctx)` could be anything, so it was a doubt about every arrow out of `serve`.
    const files = {
      "app.py":
        "class App:\n"
        + "    def __call__(self, environ, start_response):\n        return self.serve(environ, start_response)\n\n"
        + "    def serve(self, environ, start_response):\n        ctx = make(environ)\n        environ[\"hook\"](ctx)\n        return ctx\n\n\n"
        + "def make(environ):\n    return environ\n",
    };
    const arrow: Arrow = { from: ["app.py", "serve"], to: ["app.py", "__call__"] };

    it("a computed call that cannot be the far end no longer hides that the call runs the other way", () => {
      const one = verdict(files, arrow);
      expect(one.verdict).toBe("backwards");
      // No name is written at a computed call, and the red still asks the compilers.
      expect(one.verdict === "backwards" && one.ruledOutAt).toEqual([]);
    });

    it("and one that fits still does", () => {
      const fits = { "app.py": files["app.py"].replace("environ[\"hook\"](ctx)", "environ[\"hook\"](ctx, None)") };
      expect(why(verdict(fits, arrow))).toBe("computed");
    });
  });
});

/* ------------------------------------------------------- Rust method names */

describe("Rust: a method call runs a method of the name it calls, wherever the far end is kept", () => {
  const files: Files = {
    "src/run.rs": "pub trait Strat {\n    fn search(&self, x: u32) -> u32;\n}\n\npub fn run(s: &dyn Strat, x: u32) -> u32 {\n    s.search(x)\n}\n",
    "src/net.rs": "pub fn other(x: u32) -> u32 {\n    x * 2\n}\n",
    // `other` is named as a value: before, that kept every method call in the tail a doubt.
    "src/wire.rs": "use crate::net::other;\n\npub fn keep() -> u32 {\n    let h = other;\n    h(3)\n}\n",
  };
  const arrow: Arrow = { from: ["src/run.rs", "run"], to: ["src/net.rs", "other"] };

  it("`s.search(x)` is not `other`, though `other` is handed around", () => {
    const one = verdict(files, arrow);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && one.evidence.untyped).toBe(1);
  });

  it("the same in a path call, `T::search(s, x)`", () => {
    const path_ = { ...files, "src/run.rs": files["src/run.rs"]!.replace("s.search(x)", "Strat::search(s, x)") };
    expect(verdict(path_, arrow).verdict).toBe("refuted");
  });

  const quiet: Record<string, Files> = {
    "the call has the far end's own name": { ...files, "src/run.rs": files["src/run.rs"]!.replace("s.search(x)", "s.other(x)") },
    "the call runs whatever the value holds (`call`)": { ...files, "src/run.rs": files["src/run.rs"]!.replace("s.search(x)", "s.call(x)") },
    "a path call, and the far end is renamed on import somewhere": {
      ...files,
      "src/run.rs": files["src/run.rs"]!.replace("s.search(x)", "T::search(x)"),
      "src/wire.rs": "pub use crate::net::other as search;\n",
    },
    "a path call written like a constant, which may hold any function": {
      ...files, "src/run.rs": files["src/run.rs"]!.replace("s.search(x)", "Table::SEARCH(x)"),
    },
  };
  for (const [shape, changed] of Object.entries(quiet)) {
    it(`stays quiet when ${shape}`, () => {
      expect(red(verdict(changed, arrow))).toBe(false);
    });
  }

  it("TypeScript and Python keep the old question: a function can be stored under a method's name", () => {
    const ts = {
      "run.ts": "export function run(s: any, x: number) {\n  return s.search(x);\n}\n",
      "net.ts": "export function other(x: number) {\n  return x * 2;\n}\n",
      "wire.ts": "import { other } from \"./net\";\nexport const strat = { search: other };\n",
    };
    expect(red(verdict(ts, { from: ["run.ts", "run"], to: ["net.ts", "other"] }))).toBe(false);
    const py = {
      "run.py": "def run(s, x):\n    return s.search(x)\n",
      "net.py": "def other(x):\n    return x * 2\n",
      "wire.py": "from net import other\n\n\nclass Strat:\n    search = other\n",
    };
    expect(red(verdict(py, { from: ["run.py", "run"], to: ["net.py", "other"] }))).toBe(false);
  });
});

/* ------------------------------------------------------------------- made */

describe("made: creating an object runs its constructor, not a plain method of it", () => {
  const TS_SESS = (body: string) => `export class Sess {\n${body}\n  count(sql: string) {\n    return sql.length;\n  }\n}\n`;
  const ts = (sess: string, run = "import { Sess } from \"./sess\";\nexport function mk() {\n  return new Sess(1);\n}\n"): Files =>
    ({ "run.ts": run, "sess.ts": sess });
  const TS_ARROW: Arrow = { from: ["run.ts", "mk"], to: ["sess.ts", "count"] };

  const PY_SESS = (body: string) => `class Sess:\n${body}\n    def count(self, sql):\n        return len(sql)\n`;
  const py = (sess: string, run = "from sess import Sess\n\n\ndef mk():\n    return Sess(1)\n"): Files => ({ "run.py": run, "sess.py": sess });
  const PY_ARROW: Arrow = { from: ["run.py", "mk"], to: ["sess.py", "count"] };

  it("TypeScript: `new Sess(1)` is not a call of `Sess.count`", () => {
    const one = verdict(ts(TS_SESS("  constructor(private c: number) {}")), TS_ARROW);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && one.evidence.elsewhere).toEqual([{ name: "Sess", line: 3 }]);
  });

  it("Python: `Sess(1)` is not a call of `Sess.count`", () => {
    const one = verdict(py(PY_SESS("    def __init__(self, c):\n        self.c = c\n")), PY_ARROW);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && one.evidence.elsewhere).toEqual([{ name: "Sess", line: 5 }]);
  });

  it("still not when the constructor calls it: that is a step, and the red says where the call landed", async () => {
    const files = ts(TS_SESS("  constructor(private c: number) {\n    this.count(\"x\");\n  }"));
    expect(verdict(files, TS_ARROW).verdict).toBe("refuted");
    const { reds } = await checked(files, "run.ts#mk", "sess.ts#count");
    expect(reds.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(reds[0]!.detail).toContain("the one reaching sess.ts lands on `Sess`, which is not count");
  }, 60_000);

  it("the red waits for the compilers", () => {
    const one = verdict(ts(TS_SESS("  constructor(private c: number) {}")), TS_ARROW);
    expect(one.verdict === "refuted" && one.evidence.ruledOutAt?.length).toBe(1);
  });

  describe("TypeScript: what keeps the arrow a doubt", () => {
    const quiet: Record<string, [Files, string]> = {
      "the far end is the constructor": [ts(TS_SESS("  constructor(private c: number) {}")), "constructor"],
      "the far end is decorated, and a framework may run it then": [ts(TS_SESS("  constructor(private c: number) {}").replace("  count(", "  @OnInit()\n  count(")), "count"],
      "a field's initializer names the far end": [ts(TS_SESS("  total = this.count(\"x\");")), "count"],
      "the far end is one the language runs on a value (toString)": [
        ts("export class Sess {\n  toString() {\n    return \"s\";\n  }\n}\n"), "toString",
      ],
      "the object is handed straight to a call, which may run anything on it": [
        ts(TS_SESS("  constructor(private c: number) {}"), "import { Sess } from \"./sess\";\nimport { serve } from \"lib\";\nexport function mk() {\n  return serve(new Sess(1));\n}\n"), "count",
      ],
      "the far end is the class under another name": [
        ts(`${TS_SESS("  constructor(private c: number) {}")}export const count2 = Sess;\n`), "count2",
      ],
    };
    for (const [shape, [files, head]] of Object.entries(quiet)) {
      it(`stays quiet when ${shape}`, () => {
        expect(red(verdict(files, { from: ["run.ts", "mk"], to: ["sess.ts", head] }))).toBe(false);
      });
    }

    it("stays quiet when a component is rendered, which the framework makes and runs", () => {
      const files = {
        "run.tsx": "import { Sess } from \"./sess\";\nexport function mk() {\n  return <Sess />;\n}\n",
        "sess.tsx": "export class Sess {\n  render() {\n    return null;\n  }\n}\n",
      };
      expect(red(verdict(files, { from: ["run.tsx", "mk"], to: ["sess.tsx", "render"] }))).toBe(false);
    });
  });

  describe("Python: what keeps the arrow a doubt", () => {
    const quiet: Record<string, [Files, string]> = {
      "the far end is __init__": [py(PY_SESS("    def __init__(self, c):\n        self.c = c\n")), "__init__"],
      "the far end is __post_init__": [py(PY_SESS("    def __post_init__(self):\n        self.c = 1\n")), "__post_init__"],
      "the far end is decorated (a validator, a hook)": [
        py(PY_SESS("    def __init__(self, c):\n        self.c = c\n").replace("    def count(", "    @validator(\"c\")\n    def count(")), "count",
      ],
      "the class's own code names the far end outside its routines (a default factory)": [
        py("def make():\n    return []\n\n\nclass Sess:\n    items = field(default_factory=make)\n\n    def __init__(self, c):\n        self.c = c\n"), "make",
      ],
      "the object is handed straight to a call": [
        py(PY_SESS("    def __init__(self, c):\n        self.c = c\n"), "from sess import Sess\nfrom lib import serve\n\n\ndef mk():\n    return serve(Sess(1))\n"), "count",
      ],
    };
    for (const [shape, [files, head]] of Object.entries(quiet)) {
      it(`stays quiet when ${shape}`, () => {
        expect(red(verdict(files, { from: ["run.py", "mk"], to: ["sess.py", head] }))).toBe(false);
      });
    }

    it("a property, a classmethod and a staticmethod are still plain methods of the class", () => {
      for (const decorator of ["@property", "@classmethod", "@staticmethod"]) {
        const sess = PY_SESS("    def __init__(self, c):\n        self.c = c\n").replace("    def count(", `    ${decorator}\n    def count(`);
        expect(verdict(py(sess), PY_ARROW).verdict).toBe("refuted");
      }
    });
  });

  it("Rust has no constructors: `Sess::new()` is a function like any other, and nothing changes", () => {
    const files = {
      "src/run.rs": "use crate::sess::Sess;\n\npub fn mk() -> Sess {\n    Sess { c: 1 }\n}\n",
      "src/sess.rs": "pub struct Sess {\n    pub c: u32,\n}\n\nimpl Sess {\n    pub fn count(&self) -> u32 {\n        self.c\n    }\n}\n",
    };
    const before = verdict(files, { from: ["src/run.rs", "mk"], to: ["src/sess.rs", "count"] }, false);
    expect(verdict(files, { from: ["src/run.rs", "mk"], to: ["src/sess.rs", "count"] })).toEqual(before);
  });
});

/* ------------------------------------------------------------------ macro */

describe("macro: a macro_rules! of the repository runs what its template and its arguments write (Rust)", () => {
  const LIB = (template: string) =>
    `macro_rules! debug {\n    ($($arg:tt)*) => ({\n${template}\n    })\n}\n\npub mod job;\npub mod sink;\npub mod util;\n`;
  const PRINTS = "        let s = format!($($arg)*);\n        crate::sink::emit(&s);";
  const files = (template = PRINTS, job = "pub fn run(x: i32) -> i32 {\n    debug!(\"x = {}\", x);\n    x + 1\n}\n"): Files => ({
    "src/lib.rs": LIB(template),
    "src/job.rs": job,
    "src/sink.rs": "pub fn emit(s: &str) {\n    let _ = s;\n}\n",
    "src/util.rs": "pub fn other(x: i32) -> i32 {\n    x * 2\n}\n\npub fn helper(x: i32) -> i32 {\n    x + 1\n}\n",
  });
  const arrow: Arrow = { from: ["src/job.rs", "run"], to: ["src/util.rs", "other"] };

  it("before the rule, a macro whose expansion calls something is a doubt about every arrow", () => {
    expect(why(verdict(files(), arrow, false))).toBe("macro");
  });

  it("`debug!(..)` prints: it is not a call of `other`", () => {
    const one = verdict(files(), arrow);
    expect(one.verdict).toBe("refuted");
    expect(one.verdict === "refuted" && [one.evidence.inMacros, one.evidence.ruledOutAt]).toEqual([1, []]);
  });

  it("reads a macro the template calls, all the way down", () => {
    const nested = files("        emit_line!($($arg)*);").valueOf() as Files;
    nested["src/lib.rs"] = `macro_rules! emit_line {\n    ($($arg:tt)*) => ({\n${PRINTS}\n    })\n}\n\n${nested["src/lib.rs"]}`;
    expect(verdict(nested, arrow).verdict).toBe("refuted");
    nested["src/lib.rs"] = nested["src/lib.rs"]!.replace("crate::sink::emit(&s);", "crate::util::other(1);");
    expect(red(verdict(nested, arrow))).toBe(false);
  });

  const quiet: Record<string, Files> = {
    "the template calls the far end": files("        crate::util::other(1);"),
    "the template names the far end without calling it": files("        let f = crate::util::other;\n        run_it(f);"),
    "the template calls an argument, which may be a value holding any function": {
      ...files(),
      "src/lib.rs": "macro_rules! debug {\n    ($f:expr) => ({\n        $f(1);\n    })\n}\n\npub mod job;\npub mod sink;\npub mod util;\n",
      "src/job.rs": "pub fn run(f: fn(i32) -> i32) -> i32 {\n    debug!(f);\n    1\n}\n",
    },
    "the template calls what its arguments expand to": {
      ...files("        $($arg)*(1);"), "src/job.rs": "pub fn run(f: fn(i32) -> i32) -> i32 {\n    debug!(f);\n    1\n}\n",
    },
    "the template calls an argument inside a repetition": {
      ...files(),
      "src/lib.rs": "macro_rules! debug {\n    ($($f:expr),*) => ({\n        $( $f(1); )*\n    })\n}\n\npub mod job;\npub mod sink;\npub mod util;\n",
      "src/job.rs": "pub fn run(f: fn(i32) -> i32) -> i32 {\n    debug!(f);\n    1\n}\n",
    },
    "the template calls whatever a bracket holds": files("        let s = format!($($arg)*);\n        (TABLE[0])(&s);"),
    "the template calls a bare name nothing declares, which may be a local it bound": files("        let f = pick();\n        go(1);"),
    "the template calls a constant by its path, which may hold any function": files("        crate::sink::EMIT(1);"),
    "the template pastes a name together": files("        paste! { [<emit_ $($arg)*>](); }"),
    "the far end is renamed on import somewhere": {
      ...files(), "src/sink.rs": "pub use crate::util::other as emit;\n",
    },
    "the macro is a library's": { ...files(), "src/lib.rs": "pub mod job;\npub mod sink;\npub mod util;\n", "src/job.rs": "use log::debug;\n\npub fn run(x: i32) -> i32 {\n    debug!(\"x = {}\", x);\n    x + 1\n}\n" },
    "the macro takes its arguments apart, so they were not read as code": {
      ...files(),
      "src/lib.rs": "macro_rules! debug {\n    ($a:ident => $b:expr) => ({\n        crate::sink::emit(\"x\");\n    })\n}\n\npub mod job;\npub mod sink;\npub mod util;\n",
      "src/job.rs": "pub fn run(x: i32) -> i32 {\n    debug!(x => x + 1);\n    x + 1\n}\n",
    },
  };
  for (const [shape, changed] of Object.entries(quiet)) {
    it(`stays quiet when ${shape}`, () => {
      expect(red(verdict(changed, arrow))).toBe(false);
    });
  }

  it("a library's macro in the template reaches its own crate and what it is handed (#471): no doubt, as before", () => {
    const logs = files("        log::debug!($($arg)*);\n        crate::sink::emit(\"x\");");
    expect(verdict(logs, arrow).verdict).toBe("refuted");
  });

  it("a call written in the macro's arguments is still read as a call", () => {
    const job = "use crate::util::other;\n\npub fn run(x: i32) -> i32 {\n    debug!(\"x = {}\", other(x));\n    x + 1\n}\n";
    expect(verdict(files(PRINTS, job), arrow).verdict).toBe("confirmed");
  });
});

/* -------------------------------------------------- through the whole check */

describe("through the whole check", () => {
  const PY_FILES = { "run.py": PY_RUN, "net.py": PY_HEAD, "wire.py": PY_KEPT };

  it("says what was ruled out, in words", async () => {
    const { reds } = await checked(PY_FILES, "run.py#run", "net.py#connect");
    expect(reds.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(reds[0]!.detail).toContain("every call run makes was checked -- 1 of them (one passing arguments it does not take), none reaching net.py");
  }, 60_000);

  it("asks the compilers, so a live check starts them before the red is shown", async () => {
    const { report } = await checked(PY_FILES, "run.py#run", "net.py#connect");
    expect(report.gated.map((one) => [one.kind, one.outcome, one.asked, one.referee])).toEqual([["calls-refuted", "stands", true, false]]);
    expect(wouldHelp(report)).toBe(true);
  }, 60_000);

  it("and a compiler that places the ruled-out call on the far end takes the red away", async () => {
    const referee: ClosedBodyReferee = {
      resolveReceiver: () => undefined,
      // "Go to definition" at `handler` in `handler("x", 1)` answers `connect`, net.py line 1.
      declarationAt: (file, at) => file === "run.py" && PY_RUN.slice(at.start, at.end) === "handler" ? { file: "net.py", line: 1 } : undefined,
    };
    const { reds } = await checked(PY_FILES, "run.py#run", "net.py#connect", referee);
    expect(reds).toEqual([]);
  }, 60_000);

  it("a macro's red asks too", async () => {
    const files = {
      "Cargo.toml": "[package]\nname = \"m\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": "macro_rules! debug {\n    ($($arg:tt)*) => ({\n        let s = format!($($arg)*);\n        crate::sink::emit(&s);\n    })\n}\n\npub mod job;\npub mod sink;\npub mod util;\n",
      "src/job.rs": "pub fn run(x: i32) -> i32 {\n    debug!(\"x = {}\", x);\n    x + 1\n}\n",
      "src/sink.rs": "pub fn emit(s: &str) {\n    let _ = s;\n}\n",
      "src/util.rs": "pub fn other(x: i32) -> i32 {\n    x * 2\n}\n",
    };
    const { report, reds } = await checked(files, "src/job.rs#run", "src/util.rs#other");
    expect(reds.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(reds[0]!.detail).toContain("one in a macro whose template never names it");
    expect(report.gated.map((one) => [one.outcome, one.asked])).toEqual([["stands", true]]);
  }, 60_000);

  it("a backwards red that passed a ruled-out call asks too", async () => {
    const files = {
      "app.py":
        "class App:\n"
        + "    def __call__(self, environ, start_response):\n        return self.serve(environ, start_response)\n\n"
        + "    def serve(self, environ, start_response):\n        ctx = make(environ)\n        environ[\"hook\"](ctx)\n        return ctx\n\n\n"
        + "def make(environ):\n    return environ\n",
    };
    const { report, reds } = await checked(files, "app.py#serve", "app.py#__call__");
    expect(reds.map((one) => one.kind)).toEqual(["calls-backwards"]);
    expect(report.gated.map((one) => [one.outcome, one.asked])).toEqual([["stands", true]]);
  }, 60_000);
});
