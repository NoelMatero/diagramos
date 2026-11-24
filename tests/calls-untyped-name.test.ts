/**
 * A method called on a value nothing could type still runs a routine of the
 * name it calls -- #351's rule, for every value and not only an interface.
 *
 * fastapi's `get_openapi_path` calls `operation.setdefault(..)`,
 * `parameters.extend(..)` and more on values pyright cannot type. None of
 * them is named `get_fields_from_routes`, and nothing in fastapi keeps that
 * function under another name, so the wrong arrow `get_openapi_path ->
 * get_fields_from_routes` can be called wrong. Before, one such call kept the
 * whole routine a doubt.
 *
 * The risk is the same as #351's: a function put on a value under another
 * name. Every way of doing that keeps the arrow a doubt -- named as a value,
 * read by a name in a string, renamed, wrapped in a function with no name --
 * and two more this adds: a decorator, which is handed the routine itself, and
 * a call named like the language's own plumbing (`__wrapped__`, `default`).
 * Those refusals come first, in each language; the accusations after.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace } from "../src/engine/drift";
import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { initEngine, languageOf, type Language } from "../src/engine/parse";
import { wouldHelp } from "../src/engine/referee";
import { storedIn } from "../src/engine/stored";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);

/** How each finding was written, for `name` read as a method (`member`) or a free function, asked as `language`'s. */
function found(files: Record<string, string>, name: string, member: boolean, language?: Language): string[] {
  const sources = Object.entries(files).map(([file, source]) => ({ file, source, language: languageOf(file)! }));
  return storedIn(() => sources).findings(name, member, language).map((one) => one.how);
}

/** The arrow `from -> to` over `files`, with no compiler: a call on a value stays unplaced (`receiver`). */
function verdict(
  files: Record<string, string>,
  from: { file: string; routine: string },
  to: { file: string; names: string[] },
  stored = true,
): CallsVerdict {
  const sources = Object.entries(files).map(([file, source]) => ({ file, source, language: languageOf(file)! }));
  const index = storedIn(() => sources);
  const sideOf = (file: string): CallSide => ({
    file,
    source: files[file]!,
    language: languageOf(file) as Language,
    imports: [],
    open: (wanted) => files[wanted] === undefined ? undefined : { source: files[wanted]!, language: languageOf(wanted)!, imports: [] },
    ...(stored ? { runsUnderAnotherName: (name: string, member: boolean, language: Language) => index.findings(name, member, language).length > 0 } : {}),
  });
  return callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
}

const refuted = (one: CallsVerdict) => one.verdict === "refuted";
const notClosed = (one: CallsVerdict) => one.verdict === "absent" ? one.notClosed : undefined;

const TS = {
  "run.ts": "export function run(h: any, e: Error) {\n  h.onError(e);\n}\n",
  "worker.ts":
    "export function handleFailed(e: Error) {\n  return e;\n}\n\n"
    + "export class Worker {\n  handleCompleted(e: Error) {\n    return e;\n  }\n}\n",
};
const TS_FREE = { from: { file: "run.ts", routine: "run" }, to: { file: "worker.ts", names: ["handleFailed"] } };
const TS_METHOD = { from: { file: "run.ts", routine: "run" }, to: { file: "worker.ts", names: ["handleCompleted"] } };

const PY = {
  "run.py": "def run(h, e):\n    h.on_error(e)\n",
  "worker.py":
    "def handle_failed(e):\n    return e\n\n\n"
    + "class Worker:\n    def handle_completed(self, e):\n        return e\n",
};
const PY_FREE = { from: { file: "run.py", routine: "run" }, to: { file: "worker.py", names: ["handle_failed"] } };
const PY_METHOD = { from: { file: "run.py", routine: "run" }, to: { file: "worker.py", names: ["handle_completed"] } };

const RS = {
  "src/run.rs": "pub fn run(h: &Thing, e: u32) {\n    h.on_error(e);\n}\n",
  "src/worker.rs":
    "pub fn handle_failed(e: u32) -> u32 {\n    e\n}\n\n"
    + "pub struct Worker;\n\nimpl Worker {\n    pub fn handle_completed(&self, e: u32) -> u32 {\n        e\n    }\n}\n",
};
const RS_FREE = { from: { file: "src/run.rs", routine: "run" }, to: { file: "src/worker.rs", names: ["handle_failed"] } };
const RS_METHOD = { from: { file: "src/run.rs", routine: "run" }, to: { file: "src/worker.rs", names: ["handle_completed"] } };

describe("before the rule: a call on a value nothing could type is a doubt", () => {
  it("in each language, with no index", () => {
    for (const [files, arrow] of [[TS, TS_FREE], [PY, PY_FREE], [RS, RS_FREE]] as const) {
      const one = verdict(files, arrow.from, arrow.to, false);
      expect(refuted(one)).toBe(false);
      expect(notClosed(one)).toBe("receiver");
    }
  });
});

describe("the head kept where a call of another name finds it stays a doubt: TypeScript", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "named in an object literal": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport const h = { onError: handleFailed };\n" }, "free", "value"],
    "assigned to a field": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport function wire(x: any) {\n  x.onError = handleFailed;\n}\n" }, "free", "value"],
    "called from an arrow stored under the name": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport const h = { onError: (e: Error) => handleFailed(e) };\n" }, "free", "wrapped"],
    "renamed by an import": [{ "wire.ts": "import { handleFailed as onError } from \"./worker\";\nexport const h = { onError };\n" }, "free", "renamed"],
    "read by its name in a string": [{ "wire.ts": "export function wire(w: any) {\n  return { onError: w[\"handleCompleted\"] };\n}\n" }, "method", "by-name"],
    "decorated, so the decorator holds it": [{
      "worker.ts":
        "export function handleFailed(e: Error) {\n  return e;\n}\n\n"
        + "export class Worker {\n  @On(\"error\")\n  handleCompleted(e: Error) {\n    return e;\n  }\n}\n",
    }, "method", "decorated"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...TS, ...extra };
      const arrow = kind === "free" ? TS_FREE : TS_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method", "ts")).toContain(how);
      const one = verdict(files, arrow.from, arrow.to);
      expect(refuted(one)).toBe(false);
      expect(notClosed(one)).toBe("receiver");
    });
  }

  it("withholds when the call has the head's own name", () => {
    const files = { ...TS, "run.ts": "export function run(h: any, e: Error) {\n  h.handleFailed(e);\n}\n" };
    expect(refuted(verdict(files, TS_FREE.from, TS_FREE.to))).toBe(false);
  });

  it("withholds when the call runs whatever the value holds (`call`, `apply`, `bind`)", () => {
    for (const name of ["call", "apply", "bind"]) {
      const files = { ...TS, "run.ts": `export function run(h: any, e: Error) {\n  h.${name}(null, e);\n}\n` };
      expect(refuted(verdict(files, TS_FREE.from, TS_FREE.to))).toBe(false);
    }
  });

  it("withholds when the call is a module's `default`, which runs whatever it exports under any name", () => {
    const files = {
      ...TS,
      "run.ts": "export async function run(e: Error) {\n  const m = await import(\"./worker\");\n  m.default(e);\n}\n",
      "worker.ts": "export default function handleFailed(e: Error) {\n  return e;\n}\n",
    };
    expect(refuted(verdict(files, TS_FREE.from, TS_FREE.to))).toBe(false);
  });

  it("withholds at a constructor, which runs when its class is made", () => {
    const files = { ...TS, "worker.ts": "export class Worker {\n  constructor(e: Error) {\n    void e;\n  }\n}\n" };
    expect(refuted(verdict(files, TS_FREE.from, { file: "worker.ts", names: ["constructor"] }))).toBe(false);
  });

  it("withholds when the head is a class, which runs its methods under their own names", () => {
    expect(refuted(verdict(TS, TS_FREE.from, { file: "worker.ts", names: ["Worker"] }))).toBe(false);
  });
});

describe("the head kept where a call of another name finds it stays a doubt: Python", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "assigned to an attribute": [{ "wire.py": "from worker import handle_failed\n\n\nclass Box:\n    def __init__(self):\n        self.on_error = handle_failed\n" }, "free", "value"],
    "handed to a constructor as a keyword": [{ "wire.py": "from worker import handle_failed\n\nBOX = Box(on_error=handle_failed)\n" }, "free", "value"],
    "a method aliased in its class body": [{ "worker.py": "class Worker:\n    def handle_completed(self, e):\n        return e\n\n    on_error = handle_completed\n" }, "method", "value"],
    "called from a lambda stored in a dict": [{ "wire.py": "from worker import handle_failed\n\nHANDLERS = {\"error\": lambda e: handle_failed(e)}\n" }, "free", "wrapped"],
    "read with getattr": [{ "wire.py": "def wire(w):\n    return getattr(w, \"handle_completed\")\n" }, "method", "by-name"],
    "renamed by an import": [{ "wire.py": "from worker import handle_failed as on_error\n" }, "free", "renamed"],
    "registered by a decorator": [{ "worker.py": "@app.route(\"/\")\ndef handle_failed(e):\n    return e\n" }, "free", "decorated"],
    "registered by a bare decorator on a method": [{ "worker.py": "class Worker:\n    @hook\n    def handle_completed(self, e):\n        return e\n" }, "method", "decorated"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...PY, ...extra };
      const arrow = kind === "free" ? PY_FREE : PY_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method", "python")).toContain(how);
      const one = verdict(files, arrow.from, arrow.to);
      expect(refuted(one)).toBe(false);
      expect(notClosed(one)).toBe("receiver");
    });
  }

  it("withholds when the call is named like the language's plumbing (`__call__`, `__wrapped__`, `__get__`)", () => {
    for (const name of ["__call__", "__wrapped__", "__get__"]) {
      const files = { ...PY, "run.py": `def run(h, e):\n    h.${name}(e)\n` };
      expect(refuted(verdict(files, PY_FREE.from, PY_FREE.to))).toBe(false);
    }
  });

  it("withholds at a dunder, which the language calls by a name nobody writes", () => {
    const files = { ...PY, "worker.py": "class Worker:\n    def __getattr__(self, name):\n        return name\n" };
    expect(refuted(verdict(files, PY_FREE.from, { file: "worker.py", names: ["__getattr__"] }))).toBe(false);
  });

  it("withholds on `self.x()` the class does not declare, when the head is kept on it", () => {
    const files = {
      ...PY,
      "run.py": "from worker import handle_failed\n\n\nclass Run:\n    def __init__(self):\n        self.on_error = handle_failed\n\n    def run(self, e):\n        self.on_error(e)\n",
    };
    expect(refuted(verdict(files, { file: "run.py", routine: "run" }, PY_FREE.to))).toBe(false);
  });
});

describe("a call on a value nothing could type, handed a function of the repository's, stays a doubt", () => {
  /*
   * `xs.map(helper)`: whatever `map` is, it may run `helper`, and `helper`
   * may reach the head. The name `map` settles nothing about that.
   */
  it("in TypeScript: xs.map(helper)", () => {
    const files = { ...TS, "run.ts": "function helper(e: Error) {\n  return e;\n}\n\nexport function run(xs: any, e: Error) {\n  return xs.map(helper);\n}\n" };
    const one = verdict(files, TS_FREE.from, TS_FREE.to);
    expect(refuted(one)).toBe(false);
    expect(notClosed(one)).toBe("receiver");
  });

  it("in Python: pool.submit(self.work)", () => {
    const files = {
      ...PY,
      "run.py": "class Run:\n    def work(self, e):\n        return e\n\n    def run(self, pool, e):\n        pool.submit(self.work)\n",
    };
    const one = verdict(files, { file: "run.py", routine: "run" }, PY_FREE.to);
    expect(refuted(one)).toBe(false);
  });

  it("in Rust: xs.for_each(helper)", () => {
    const files = { ...RS, "src/run.rs": "fn helper(e: u32) {}\n\npub fn run(xs: &Thing, e: u32) {\n    xs.for_each(helper);\n}\n" };
    expect(refuted(verdict(files, RS_FREE.from, RS_FREE.to))).toBe(false);
  });

  it("but not when what it is handed is plain data", () => {
    const files = { ...TS, "run.ts": "export function run(xs: any, e: Error) {\n  return xs.push(e, 1, \"x\");\n}\n" };
    expect(verdict(files, TS_FREE.from, TS_FREE.to).verdict).toBe("refuted");
  });
});

describe("the head kept where a call of another name finds it stays a doubt: Rust", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "a method handed by its path": [{ "src/wire.rs": "use crate::worker::Worker;\n\npub fn wire() {\n    register(Worker::handle_completed);\n}\n" }, "method", "value"],
    "called from a closure that is kept": [{ "src/wire.rs": "pub fn wire() -> Box<dyn Fn(u32) -> u32> {\n    Box::new(move |e| handle_failed(e))\n}\n" }, "free", "wrapped"],
    "renamed by a use": [{ "src/wire.rs": "pub use crate::worker::handle_failed as on_error;\n" }, "free", "renamed"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...RS, ...extra };
      const arrow = kind === "free" ? RS_FREE : RS_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method", "rust")).toContain(how);
      const one = verdict(files, arrow.from, arrow.to);
      expect(refuted(one)).toBe(false);
      expect(notClosed(one)).toBe("receiver");
    });
  }

  it("withholds when the call is an `Fn` trait's", () => {
    const files = { ...RS, "src/run.rs": "pub fn run(h: &Thing, e: u32) {\n    h.call_once((e,));\n}\n" };
    expect(refuted(verdict(files, RS_FREE.from, RS_FREE.to))).toBe(false);
  });
});

describe("a wrong arrow through a call on a value nothing could type is called wrong", () => {
  it("in TypeScript, for a free function and for a method", () => {
    for (const arrow of [TS_FREE, TS_METHOD]) {
      const one = verdict(TS, arrow.from, arrow.to);
      expect(one.verdict).toBe("refuted");
      if (one.verdict === "refuted") expect(one.evidence.untyped).toBe(1);
    }
  });

  it("in Python, for a free function and for a method", () => {
    for (const arrow of [PY_FREE, PY_METHOD]) {
      const one = verdict(PY, arrow.from, arrow.to);
      expect(one.verdict).toBe("refuted");
      if (one.verdict === "refuted") expect(one.evidence.untyped).toBe(1);
    }
  });

  it("in Rust, for a free function and for a method", () => {
    for (const arrow of [RS_FREE, RS_METHOD]) expect(verdict(RS, arrow.from, arrow.to).verdict).toBe("refuted");
  });

  it("in Python, through chained calls on what a call returns (fastapi's `setdefault(..).setdefault(..)`)", () => {
    const files = { ...PY, "run.py": "def run(operation, e):\n    operation.setdefault(\"responses\", {}).setdefault(e, {})\n    operation.get(\"x\").extend([e])\n" };
    expect(verdict(files, PY_FREE.from, PY_FREE.to).verdict).toBe("refuted");
  });

  it("when the head's decorator is one the language gives, which keeps it under its own name", () => {
    for (const decorator of ["staticmethod", "classmethod", "property", "abc.abstractmethod", "x.setter"]) {
      const files = { ...PY, "worker.py": `class Worker:\n    @${decorator}\n    def handle_completed(self, e):\n        return e\n` };
      expect(found(files, "handle_completed", true, "python")).toEqual([]);
      expect(verdict(files, PY_METHOD.from, PY_METHOD.to).verdict).toBe("refuted");
    }
  });

  it("when only a file of another language names the head (bat's benchmark jQuery naming `run`)", () => {
    const files = { ...RS, "tests/bench/jquery.js": "jQuery.fn.extend({ handle_failed: function () { return handle_failed(); } });\n" };
    expect(found(files, "handle_failed", false)).not.toEqual([]);
    expect(found(files, "handle_failed", false, "rust")).toEqual([]);
    expect(verdict(files, RS_FREE.from, RS_FREE.to).verdict).toBe("refuted");
  });

  it("while a TypeScript head is still kept by a JavaScript file", () => {
    const files = { ...TS, "wire.js": "import { handleFailed } from \"./worker\";\nexport const h = { onError: handleFailed };\n" };
    expect(found(files, "handleFailed", false, "ts")).toContain("value");
    expect(refuted(verdict(files, TS_FREE.from, TS_FREE.to))).toBe(false);
  });
});

describe("through the whole check, with no compiler", () => {
  const FILES = {
    "openapi.py":
      "def get_openapi_path(route, operation):\n"
      + "    operation.setdefault(\"responses\", {}).setdefault(route, {})\n"
      + "    return operation\n\n\n"
      + "def get_fields_from_routes(routes):\n    return routes\n",
  };

  async function reds(files: Record<string, string>): Promise<Array<{ kind: string; detail: string }>> {
    const repo = mkdtempSync(path.join(tmpdir(), "calls-untyped-"));
    try {
      for (const [file, source] of Object.entries(files)) writeFileSync(path.join(repo, file), source);
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [
          { id: "a", label: "get_openapi_path", ref: "openapi.py#get_openapi_path" },
          { id: "b", label: "get_fields_from_routes", ref: "openapi.py#get_fields_from_routes" },
        ],
        edges: [{ from: "a", to: "b", claim: "calls" }],
      });
      const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
      return report.edges.filter((one) => ACCUSING.has(one.kind));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it("calls the arrow wrong, and says the untyped calls were read", async () => {
    const found = await reds(FILES);
    expect(found.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(found[0]!.detail).toContain("2 on values nothing could type, each running a method of the name it calls");
  }, 60_000);

  it("leaves it alone when the head is kept somewhere", async () => {
    expect(await reds({ ...FILES, "wire.py": "from openapi import get_fields_from_routes\n\nHOOKS = [get_fields_from_routes]\n" })).toEqual([]);
  }, 60_000);

  it("asks a compiler where those calls go, so a live check still starts one", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "calls-untyped-ask-"));
    try {
      for (const [file, source] of Object.entries(FILES)) writeFileSync(path.join(repo, file), source);
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [
          { id: "a", label: "get_openapi_path", ref: "openapi.py#get_openapi_path" },
          { id: "b", label: "get_fields_from_routes", ref: "openapi.py#get_fields_from_routes" },
        ],
        edges: [{ from: "a", to: "b", claim: "calls" }],
      });
      const blind = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
      expect(blind.gated.map((one) => [one.kind, one.outcome, one.asked, one.referee])).toEqual([["calls-refuted", "stands", true, false]]);
      expect(wouldHelp(blind)).toBe(true);
      // A compiler that cannot say either: the red stands on what is written.
      const silent = checkDrift(board as BoardFile, createWorkspace(repo), {
        edges: true,
        closedBodyReferee: { resolveReceiver: () => undefined, declarationAt: () => undefined },
      });
      expect(silent.edges.filter((one) => ACCUSING.has(one.kind)).map((one) => one.kind)).toEqual(["calls-refuted"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("asks the compiler too when the red is a call landing on another routine of the far end's file", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "calls-untyped-near-"));
    try {
      writeFileSync(path.join(repo, "openapi.py"),
        "def get_openapi_path(route, operation):\n"
        + "    operation.setdefault(\"responses\", {})\n"
        + "    return helper(route)\n\n\n"
        + "def helper(route):\n    return route\n\n\n"
        + "def get_fields_from_routes(routes):\n    return routes\n");
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [
          { id: "a", label: "get_openapi_path", ref: "openapi.py#get_openapi_path" },
          { id: "b", label: "get_fields_from_routes", ref: "openapi.py#get_fields_from_routes" },
        ],
        edges: [{ from: "a", to: "b", claim: "calls" }],
      });
      const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
      expect(report.gated.map((one) => [one.kind, one.outcome, one.asked])).toEqual([["calls-wrong-routine", "stands", true]]);
      expect(wouldHelp(report)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  it("leaves it alone when the head is decorated", async () => {
    const decorated = FILES["openapi.py"].replace("def get_fields_from_routes", "@register\ndef get_fields_from_routes");
    expect(await reds({ "openapi.py": decorated })).toEqual([]);
  }, 60_000);
});

/*
 * A method read off a value and kept in a local -- rich's `append =
 * output.append`, then `append(text)` -- is the call `output.append(text)`
 * written in two steps. Read as that call, it falls under the same rule; read
 * as "a local holding some function", it kept the whole routine a doubt.
 */
describe("a local that holds a method read off a value is read as that call", () => {
  async function kindsOf(files: Record<string, string>, from: string, to: string): Promise<string[]> {
    const repo = mkdtempSync(path.join(tmpdir(), "calls-untyped-local-"));
    try {
      for (const [file, source] of Object.entries(files)) {
        const at = path.join(repo, file);
        if (path.dirname(file) !== ".") (await import("node:fs")).mkdirSync(path.dirname(at), { recursive: true });
        writeFileSync(at, source);
      }
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [{ id: "a", label: "from", ref: from }, { id: "b", label: "to", ref: to }],
        edges: [{ from: "a", to: "b", claim: "calls" }],
      });
      const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
      return report.edges.filter((one) => ACCUSING.has(one.kind)).map((one) => one.kind);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  const PY_RENDER = (body: string) =>
    "def escape(t):\n    return t\n\n\n"
    + `def render(parts, text):\n${body}\n    return parts\n`;

  it("calls a wrong arrow wrong in Python: append = parts.append", async () => {
    const files = { "markup.py": PY_RENDER("    append = parts.append\n    append(text)\n    pop = parts.pop\n    pop()") };
    expect(await kindsOf(files, "markup.py#render", "markup.py#escape")).toEqual(["calls-refuted"]);
  }, 60_000);

  it("calls a wrong arrow wrong in TypeScript: const push = parts.push", async () => {
    const files = {
      "markup.ts": "export function escape(t: string) { return t; }\n"
        + "export function render(parts: any, text: string) {\n  const push = parts.push;\n  push(text);\n  return parts;\n}\n",
    };
    expect(await kindsOf(files, "markup.ts#render", "markup.ts#escape")).toEqual(["calls-refuted"]);
  }, 60_000);

  /* The doubts it keeps. */
  it("stays quiet when the method read has the head's name", async () => {
    const files = { "markup.py": PY_RENDER("    run = parts.escape\n    run(text)") };
    expect(await kindsOf(files, "markup.py#render", "markup.py#escape")).toEqual([]);
  }, 60_000);

  it("stays quiet when the local is also assigned from a parameter", async () => {
    const files = {
      "markup.py": "def escape(t):\n    return t\n\n\n"
        + "def render(parts, text, given):\n    append = parts.append\n    if text:\n        append = given\n    append(text)\n    return parts\n",
    };
    expect(await kindsOf(files, "markup.py#render", "markup.py#escape")).toEqual([]);
  }, 60_000);

  it("stays quiet when the head is kept on the value under the method's name", async () => {
    const files = {
      "markup.py": PY_RENDER("    append = parts.append\n    append(text)"),
      "wire.py": "from markup import escape\n\n\nclass Parts:\n    append = escape\n",
    };
    expect(await kindsOf(files, "markup.py#render", "markup.py#escape")).toEqual([]);
  }, 60_000);

  it("stays quiet on a Rust field read into a local, which holds whatever was stored", async () => {
    const files = {
      "Cargo.toml": "[package]\nname = \"m\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": "pub struct P { pub hook: fn(u32) -> u32 }\n\n"
        + "pub fn escape(t: u32) -> u32 {\n    t\n}\n\n"
        + "pub fn render(p: &P, t: u32) -> u32 {\n    let f = p.hook;\n    f(t)\n}\n",
    };
    expect(await kindsOf(files, "src/lib.rs#render", "src/lib.rs#escape")).toEqual([]);
  }, 60_000);
});
