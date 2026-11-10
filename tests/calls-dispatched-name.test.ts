/**
 * A call through an interface, a trait, a Protocol or an override runs a
 * routine of the name it calls (#351).
 *
 * `job.moveToFailed()` calling `this.backend.moveToFailed(..)` through the
 * `QueueBackend` interface runs some class's `moveToFailed`. It cannot be
 * `Worker.handleFailed`, so a wrong arrow `moveToFailed -> handleFailed` can
 * be called wrong. Before, any such call kept the whole routine a doubt.
 *
 * The risk is a routine stored under the called name. `{ onError: handler }`
 * makes `h.onError()` run `handler`. Every shape that can do that keeps the
 * arrow a doubt, in each language: the routine named as a value, read by a
 * name in a string, renamed by an import, or called from a function with no
 * name that is then stored. Those refusals come first; the accusations after.
 *
 * Two levels. `stored.ts` alone, over text, says where a routine is written
 * so it can run under another name. And `callsBetween`, with "go to
 * definition" landing the call on an interface's method the way a compiler
 * answers, says whether the arrow is refuted.
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
import { storedIn } from "../src/engine/stored";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);

/** How each finding was written, for `name` read as a method (`member`) or as a free function. */
function found(files: Record<string, string>, name: string, member: boolean): string[] {
  const sources = Object.entries(files).map(([file, source]) => ({ file, source, language: languageOf(file)! }));
  return storedIn(() => sources).findings(name, member).map((one) => one.how);
}

/**
 * The arrow `from -> to` over `files`, where every call through `receiver.`
 * lands on line `line` of `iface` with the checker's "runs there" unsaid --
 * an interface's, a trait's, a Protocol's method.
 */
function verdict(
  files: Record<string, string>,
  from: { file: string; routine: string },
  to: { file: string; names: string[] },
  iface: { file: string; line: number },
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
    declarationAt: () => ({ file: iface.file, line: iface.line, concrete: false }),
    ...(stored ? { runsUnderAnotherName: (name: string, member: boolean) => index.findings(name, member).length > 0 } : {}),
  });
  return callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
}

const TS = {
  "iface.ts": "export interface Handler {\n  onError(e: Error): void;\n}\n",
  "run.ts": "import type { Handler } from \"./iface\";\n\nexport function run(h: Handler, e: Error) {\n  h.onError(e);\n}\n",
  "worker.ts":
    "export function handleFailed(e: Error) {\n  return e;\n}\n\n"
    + "export class Worker {\n  handleCompleted(e: Error) {\n    return e;\n  }\n}\n",
};
const TS_IFACE = { file: "iface.ts", line: 2 };
const TS_FREE = { from: { file: "run.ts", routine: "run" }, to: { file: "worker.ts", names: ["handleFailed"] } };
const TS_METHOD = { from: { file: "run.ts", routine: "run" }, to: { file: "worker.ts", names: ["handleCompleted"] } };

const PY = {
  "iface.py": "from typing import Protocol\n\n\nclass Handler(Protocol):\n    def on_error(self, e): ...\n",
  "run.py": "from iface import Handler\n\n\ndef run(h: Handler, e):\n    h.on_error(e)\n",
  "worker.py":
    "def handle_failed(e):\n    return e\n\n\n"
    + "class Worker:\n    def handle_completed(self, e):\n        return e\n",
};
const PY_IFACE = { file: "iface.py", line: 5 };
const PY_FREE = { from: { file: "run.py", routine: "run" }, to: { file: "worker.py", names: ["handle_failed"] } };
const PY_METHOD = { from: { file: "run.py", routine: "run" }, to: { file: "worker.py", names: ["handle_completed"] } };

const RS = {
  "src/iface.rs": "pub trait Handler {\n    fn on_error(&self, e: u32);\n}\n",
  "src/run.rs": "use crate::iface::Handler;\n\npub fn run(h: &dyn Handler, e: u32) {\n    h.on_error(e);\n}\n",
  "src/worker.rs":
    "pub fn handle_failed(e: u32) -> u32 {\n    e\n}\n\n"
    + "pub struct Worker;\n\nimpl Worker {\n    pub fn handle_completed(&self, e: u32) -> u32 {\n        e\n    }\n}\n",
};
const RS_IFACE = { file: "src/iface.rs", line: 2 };
const RS_FREE = { from: { file: "src/run.rs", routine: "run" }, to: { file: "src/worker.rs", names: ["handle_failed"] } };
const RS_METHOD = { from: { file: "src/run.rs", routine: "run" }, to: { file: "src/worker.rs", names: ["handle_completed"] } };

const refuted = (one: CallsVerdict) => one.verdict === "refuted";

describe("the head stored where a call of another name finds it stays a doubt: TypeScript", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "named in an object literal": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport const h = { onError: handleFailed };\n" }, "free", "value"],
    "a method handed bound": [{ "wire.ts": "export class W {\n  handleCompleted(e: Error) { return e; }\n  wire() { return { onError: this.handleCompleted.bind(this) }; }\n}\n" }, "method", "value"],
    "assigned to a field": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport class Box {\n  onError: (e: Error) => void;\n  constructor() { this.onError = handleFailed; }\n}\n" }, "free", "value"],
    "a class field naming the method": [{ "wire.ts": "export class W {\n  onError = this.handleCompleted;\n  handleCompleted(e: Error) { return e; }\n}\n" }, "method", "value"],
    "called from an arrow stored under the name": [{ "wire.ts": "import { handleFailed } from \"./worker\";\nexport const h = { onError: (e: Error) => handleFailed(e) };\n" }, "free", "wrapped"],
    "called from an arrow handed to a constructor that keeps it": [{
      "wire.ts": "import { handleFailed } from \"./worker\";\n"
        + "export class Box {\n  constructor(private onError: (e: Error) => void) {}\n}\n"
        + "export const b = new Box((e) => handleFailed(e));\n",
    }, "free", "wrapped"],
    "renamed by an import": [{ "wire.ts": "import { handleFailed as onError } from \"./worker\";\nexport const h = { onError };\n" }, "free", "renamed"],
    "read by its name in a string": [{ "wire.ts": "export function wire(w: any) {\n  return { onError: w[\"handleCompleted\"] };\n}\n" }, "method", "by-name"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...TS, ...extra };
      const arrow = kind === "free" ? TS_FREE : TS_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method")).toContain(how);
      const one = verdict(files, arrow.from, arrow.to, TS_IFACE);
      expect(refuted(one)).toBe(false);
      if (one.verdict === "absent") expect(one.notClosed).toBe("abstract-receiver");
    });
  }

  it("withholds when the call runs whatever the value holds (`call`, `apply`)", () => {
    const files = { ...TS, "run.ts": "import type { Handler } from \"./iface\";\n\nexport function run(h: Handler, e: Error) {\n  h.call(e);\n}\n" };
    expect(refuted(verdict(files, TS_FREE.from, TS_FREE.to, TS_IFACE))).toBe(false);
  });

  it("withholds at a constructor, which runs when its class is made", () => {
    const files = { ...TS, "worker.ts": "export class Worker {\n  constructor(e: Error) {\n    void e;\n  }\n}\n" };
    expect(refuted(verdict(files, TS_FREE.from, { file: "worker.ts", names: ["constructor"] }, TS_IFACE))).toBe(false);
  });

  it("withholds when the call has the head's own name", () => {
    const files = { ...TS, "worker.ts": "export class Worker {\n  onError(e: Error) {\n    return e;\n  }\n}\n" };
    expect(refuted(verdict(files, TS_FREE.from, { file: "worker.ts", names: ["onError"] }, TS_IFACE))).toBe(false);
  });

  it("withholds when nobody hands in the index", () => {
    expect(refuted(verdict(TS, TS_FREE.from, TS_FREE.to, TS_IFACE, false))).toBe(false);
  });
});

describe("the head stored where a call of another name finds it stays a doubt: Python", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "assigned to an attribute": [{ "wire.py": "from worker import handle_failed\n\n\nclass Box:\n    def __init__(self):\n        self.on_error = handle_failed\n" }, "free", "value"],
    "a method assigned to an attribute": [{ "wire.py": "class W:\n    def wire(self):\n        self.on_error = self.handle_completed\n" }, "method", "value"],
    "a method aliased in its class body": [{ "worker.py": "class Worker:\n    def handle_completed(self, e):\n        return e\n\n    on_error = handle_completed\n" }, "method", "value"],
    "a default value": [{ "wire.py": "from worker import handle_failed\n\n\ndef wire(on_error=handle_failed):\n    return on_error\n" }, "free", "value"],
    "called from a lambda stored in a dict": [{ "wire.py": "from worker import handle_failed\n\nHANDLERS = {\"error\": lambda e: handle_failed(e)}\n" }, "free", "wrapped"],
    "called from a lambda handed as a keyword": [{ "wire.py": "from worker import handle_failed\n\n\ndef wire(make):\n    return make(on_error=lambda e: handle_failed(e))\n" }, "free", "wrapped"],
    "read with getattr": [{ "wire.py": "def wire(w):\n    return getattr(w, \"handle_completed\")\n" }, "method", "by-name"],
    "renamed by an import": [{ "wire.py": "from worker import handle_failed as on_error\n" }, "free", "renamed"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...PY, ...extra };
      const arrow = kind === "free" ? PY_FREE : PY_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method")).toContain(how);
      expect(refuted(verdict(files, arrow.from, arrow.to, PY_IFACE))).toBe(false);
    });
  }

  it("withholds at a dunder, which the language calls by a name nobody writes", () => {
    const files = { ...PY, "worker.py": "class Worker:\n    def __getattr__(self, name):\n        return name\n" };
    expect(refuted(verdict(files, PY_FREE.from, { file: "worker.py", names: ["__getattr__"] }, PY_IFACE))).toBe(false);
  });

  it("withholds when the call is `__call__`", () => {
    const files = { ...PY, "run.py": "from iface import Handler\n\n\ndef run(h: Handler, e):\n    h.__call__(e)\n" };
    expect(refuted(verdict(files, PY_FREE.from, PY_FREE.to, PY_IFACE))).toBe(false);
  });
});

describe("the head stored where a call of another name finds it stays a doubt: Rust", () => {
  const shapes: Record<string, [Record<string, string>, "free" | "method", string]> = {
    "handed as a function pointer": [{ "src/wire.rs": "use crate::worker::handle_failed;\n\npub fn wire() {\n    register(handle_failed);\n}\n" }, "free", "value"],
    "a method handed by its path": [{ "src/wire.rs": "use crate::worker::Worker;\n\npub fn wire() {\n    register(Worker::handle_completed);\n}\n" }, "method", "value"],
    "a method named by its path inside a macro": [{ "src/wire.rs": "pub fn wire() {\n    let all = vec![Worker::handle_completed];\n}\n" }, "method", "value"],
    "called from a closure that is kept": [{ "src/wire.rs": "pub fn wire() -> Box<dyn Fn(u32) -> u32> {\n    Box::new(move |e| handle_failed(e))\n}\n" }, "free", "wrapped"],
    "renamed by a use": [{ "src/wire.rs": "pub use crate::worker::handle_failed as on_error;\n" }, "free", "renamed"],
  };
  for (const [shape, [extra, kind, how]] of Object.entries(shapes)) {
    it(`withholds when the head is ${shape}`, () => {
      const files = { ...RS, ...extra };
      const arrow = kind === "free" ? RS_FREE : RS_METHOD;
      expect(found(files, arrow.to.names[0]!, kind === "method")).toContain(how);
      expect(refuted(verdict(files, arrow.from, arrow.to, RS_IFACE))).toBe(false);
    });
  }

  it("withholds when the call is an `Fn` trait's", () => {
    const files = { ...RS, "src/run.rs": "pub fn run(h: &dyn Fn(u32), e: u32) {\n    h.call((e,));\n}\n" };
    expect(refuted(verdict(files, RS_FREE.from, RS_FREE.to, RS_IFACE))).toBe(false);
  });
});

describe("a name that only looks like the head's is not counted", () => {
  it("does not count a Rust field, a parameter or a local of the same name as a method", () => {
    const files = {
      ...RS,
      "src/wire.rs": "pub fn wire(handle_completed: u32, s: &S) -> u32 {\n    let x = s.handle_completed;\n    format!(\"{}\", s.handle_completed.len());\n    handle_completed + x\n}\n",
    };
    expect(found(files, "handle_completed", true)).toEqual([]);
  });

  it("does not count a bare name for a TypeScript or Python method", () => {
    expect(found({ ...TS, "wire.ts": "const handleCompleted = 1;\nexport const n = handleCompleted + 1;\n" }, "handleCompleted", true)).toEqual([]);
    expect(found({ ...PY, "wire.py": "def wire(handle_completed):\n    return handle_completed\n" }, "handle_completed", true)).toEqual([]);
  });

  it("does not count a function handed to a runner in the same file that only calls it", () => {
    // bullmq's worker: `this.retryIfFailed(() => this.handleFailed(..))`, and
    // `retryIfFailed(fn)` does nothing with `fn` but run it.
    const worker =
      "export class Worker {\n"
      + "  handleCompleted(e: Error) { return e; }\n"
      + "  async run(e: Error) { return await this.retryIfFailed<void>(() => { return this.handleCompleted(e); }, 1); }\n"
      + "  private async retryIfFailed<T>(fn: () => Promise<T> | T, times: number): Promise<T> { return await fn(); }\n"
      + "}\n";
    expect(found({ ...TS, "worker.ts": worker }, "handleCompleted", true)).toEqual([]);
    // The same runner keeping it: now it can be found again.
    const keeps = worker.replace("{ return await fn(); }", "{ this.kept = fn; return await fn(); }");
    expect(found({ ...TS, "worker.ts": keeps }, "handleCompleted", true)).toContain("wrapped");
  });
});

describe("a wrong arrow through a dispatched call is called wrong", () => {
  it("in TypeScript, for a free function and for a method", () => {
    for (const arrow of [TS_FREE, TS_METHOD]) {
      const one = verdict(TS, arrow.from, arrow.to, TS_IFACE);
      expect(one.verdict).toBe("refuted");
      if (one.verdict === "refuted") expect(one.evidence.dispatched).toBe(1);
    }
  });

  it("in Python, for a free function and for a method", () => {
    for (const arrow of [PY_FREE, PY_METHOD]) expect(verdict(PY, arrow.from, arrow.to, PY_IFACE).verdict).toBe("refuted");
  });

  it("in Rust, for a free function and for a method", () => {
    for (const arrow of [RS_FREE, RS_METHOD]) expect(verdict(RS, arrow.from, arrow.to, RS_IFACE).verdict).toBe("refuted");
  });

  it("when the head is only called by name, from a named routine or directly", () => {
    const files = {
      ...TS,
      "wire.ts": "import { handleFailed } from \"./worker\";\nexport class Impl {\n  onError(e: Error) { return handleFailed(e); }\n}\n",
    };
    expect(verdict(files, TS_FREE.from, TS_FREE.to, TS_IFACE).verdict).toBe("refuted");
  });
});

describe("through the whole check, with no compiler", () => {
  /*
   * A base class calling its own method that a subclass replaces is marked
   * from the text alone (#353), so `checkDrift` with no referee reads the
   * same rule a live check does.
   */
  const FILES = {
    "base.py":
      "class Transport:\n    def handle(self, r):\n        raise NotImplementedError\n\n"
      + "    def send(self, r):\n        return self.handle(r)\n",
    "http.py":
      "from base import Transport\n\n\nclass HTTPTransport(Transport):\n    def handle(self, r):\n        return r\n",
    "render.py": "def render(n):\n    return n\n",
  };

  async function reds(files: Record<string, string>): Promise<Array<{ kind: string; detail: string }>> {
    const repo = mkdtempSync(path.join(tmpdir(), "calls-dispatched-"));
    try {
      for (const [file, source] of Object.entries(files)) writeFileSync(path.join(repo, file), source);
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [{ id: "a", label: "send", ref: "base.py#send" }, { id: "b", label: "render", ref: "render.py#render" }],
        edges: [{ from: "a", to: "b", claim: "calls" }],
      });
      const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
      return report.edges.filter((one) => ACCUSING.has(one.kind));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it("calls the arrow wrong, and says the override was read", async () => {
    const found = await reds(FILES);
    expect(found.map((one) => one.kind)).toEqual(["calls-refuted"]);
    expect(found[0]!.detail).toContain("one through an interface or an override, which runs a method of the name it calls");
  }, 60_000);

  it("leaves it alone when the head is stored somewhere", async () => {
    expect(await reds({ ...FILES, "wire.py": "from render import render\n\nHOOKS = [render]\n" })).toEqual([]);
  }, 60_000);
});
