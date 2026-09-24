/**
 * An arrow into a plain value is called wrong on the compiler's word (#343).
 *
 * `execute --@calls--> ctx` cannot be true when `ctx` holds a request context:
 * nothing can call one. Before this, the checker only knew that when the type
 * was written as a plain word -- `string`, `int` -- and stayed quiet on
 * `ctx = makeContext()` or `ctx: RequestContext`, because a named type might be
 * a function in disguise. About fifty planted mistakes in the bench were that.
 *
 * The compiler knows. What is pinned here, per language: the wrong arrow goes
 * red once a compiler answers, the right arrow into a value that really is a
 * function stays green, and with no compiler nothing is accused.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { createClosedBodyReferee, refereedCheck } from "../src/engine/referee";
import { refereedCheckLive } from "../src/engine/referee-live";
import { createPyrightLspReferee } from "../src/engine/referee-python-lsp";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

async function boardOf(fromRef: string, toRef: string, claim: "calls" | "builds" = "calls"): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim }],
  });
  return board;
}

/** The one arrow's verdict, the way a person reads it off the report. */
function verdictOf(report: DriftReport): "red" | "green" | "quiet" {
  if (report.edges.some((edge) => edge.kind === "end-lacks-part")) return "red";
  if (report.edges.length > 0) return "red";
  return report.claims.callsConfirmed + report.claims.buildsConfirmed > 0 ? "green" : "quiet";
}

beforeEach(() => {
  // Outside the worktree on purpose: a scratch source file inside one is read
  // by the dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "engine-parts-compiler-"));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("TypeScript: an arrow into a value", () => {
  /*
   * The bench's shape: a local holding whatever a call returned. `execute`
   * also calls a method on an `any`, which no reader can follow, so its call
   * list never closes and no other check has anything to say -- the arrow's
   * only chance of a verdict is the kind of thing at its head.
   */
  const SOURCES = {
    "src/ctx.ts": "export class RequestContext { url = \"\"; }\n"
      + "export function makeContext(): RequestContext { return new RequestContext(); }\n",
    "src/run.ts": "import { makeContext } from \"./ctx\";\n"
      + "export function execute(sink: any) {\n"
      + "  const ctx = makeContext();\n"
      + "  sink.send(ctx.url);\n"
      + "}\n",
  };

  it("is called wrong when the compiler says the value cannot be called", async () => {
    for (const [file, contents] of Object.entries(SOURCES)) write(file, contents);
    const board = await boardOf("src/run.ts#execute", "src/run.ts#ctx");
    const workspace = createWorkspace(repo);

    const plain = checkDrift(board, workspace);
    expect(verdictOf(plain)).toBe("quiet");

    const red = refereed(board).edges.find((edge) => edge.kind === "end-lacks-part");
    expect(red?.detail).toContain("cannot be called");
  });

  it("stays green on a right arrow into a value that holds a function", async () => {
    write("src/handler.ts", "export interface Handler { (n: number): void }\n"
      + "export function makeHandler(): Handler { return () => {}; }\n");
    write("src/run.ts", "import { makeHandler } from \"./handler\";\n"
      + "export function execute(sink: any) {\n"
      + "  const handler = makeHandler();\n"
      + "  sink.send();\n"
      + "  handler(1);\n"
      + "}\n");
    const board = await boardOf("src/run.ts#execute", "src/run.ts#handler");
    expect(verdictOf(refereed(board))).toBe("green");
  });
});

describe("TypeScript: @builds into a value", () => {
  const MAKE = "export function version(): string { return \"1\"; }\n"
    + "export const Model = class { id = 1; };\n";

  it("is called wrong when the value is a string", async () => {
    write("src/make.ts", MAKE);
    write("src/run.ts", "import { version } from \"./make\";\n"
      + "export function create(sink: any) {\n  const current = version();\n  return sink.make(current);\n}\n");
    const board = await boardOf("src/run.ts#create", "src/run.ts#current", "builds");
    expect(verdictOf(checkDrift(board, createWorkspace(repo)))).toBe("quiet");
    const red = refereed(board).edges.find((edge) => edge.kind === "end-lacks-part");
    expect(red?.detail).toContain("is not a type");
  });

  it("is not called wrong when the value is a class held in a variable", async () => {
    write("src/make.ts", MAKE);
    write("src/run.ts", "import { Model } from \"./make\";\n"
      + "export function create(sink: any) {\n  const Kind = Model;\n  return sink.make(new Kind());\n}\n");
    const board = await boardOf("src/run.ts#create", "src/run.ts#Kind", "builds");
    expect(refereed(board).edges).toEqual([]);
  });
});

/** A check the way every product path runs one: plain first, the compiler if it would help. */
function refereed(board: BoardFile): DriftReport {
  const workspace = createWorkspace(repo);
  return refereedCheck(repo, (referee) => checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
}

describe("what the TypeScript compiler answers about one value", () => {
  /*
   * One line per shape a value's type takes in real source. `false` is the
   * only answer that can put a red on a board, so every shape where a value
   * can be called -- however indirectly -- has to come back something else.
   */
  const SOURCE = [
    "export class RequestContext { url = \"\"; }",
    "export interface Handler { (n: number): void }",
    "declare const any_: any;",
    "export const ctx = new RequestContext();",
    "export const count = 4 as number;",
    "export const onDone: (() => void) | undefined = undefined;",
    "export const legacy: Function | string = \"\";",
    "export const handler: Handler = () => {};",
    "export const opaque = any_;",
    "export const Model = class { id = 1; };",
    "export class Box<TError, TName extends string> { failure!: TError | null; name!: TName; }",
    "",
  ].join("\n");

  const ask = (name: string) => {
    write("src/values.ts", SOURCE);
    const referee = createClosedBodyReferee(repo)!;
    const at = SOURCE.search(new RegExp(`\\b${name}\\b\\s*[!:=]`));
    return referee.kindAt!("src/values.ts", { start: at, end: at + name.length });
  };

  it("says an instance and a number cannot be called, and are not types", () => {
    expect(ask("ctx")).toEqual({ callable: false, type: false });
    expect(ask("count")).toEqual({ callable: false, type: false });
  });

  it("says a callback that may be missing can be called", () => {
    expect(ask("onDone")?.callable).toBe(true);
  });

  it("says a value typed `Function` can be called, though `Function` declares no signature", () => {
    expect(ask("legacy")?.callable).toBe(true);
  });

  it("says a value of a named function type can be called", () => {
    expect(ask("handler")?.callable).toBe(true);
  });

  it("does not know about an `any`", () => {
    expect(ask("opaque")?.callable).toBeUndefined();
  });

  it("says a class held in a variable can be called, so it is never told it is not a type", () => {
    expect(ask("Model")?.callable).toBe(true);
  });

  it("does not know about a type parameter that may be a function, and reads one that may not", () => {
    expect(ask("failure")?.callable).toBeUndefined();
    expect(ask("name")?.callable).toBe(false);
  });
});

describe("Python: an arrow into a value", () => {
  /*
   * The same shape through pyright, which answers over a pipe: the check
   * records the question on a first pass, asks it once, and reads the answer
   * back. `sink.send` is on a parameter nothing types, so the call list never
   * closes and the head's kind is the arrow's only chance of a verdict.
   */
  const CTX = "class RequestContext:\n    def __init__(self):\n        self.url = \"\"\n\n\n"
    + "def make_context():\n    return RequestContext()\n";

  it("is called wrong when pyright says the value cannot be called", async () => {
    write("ctx.py", CTX);
    write("run.py", "from ctx import make_context\n\n\ndef execute(sink):\n"
      + "    ctx = make_context()\n    sink.send(ctx.url)\n");
    const board = await boardOf("run.py#execute", "run.py#ctx");
    const workspace = createWorkspace(repo);
    expect(verdictOf(checkDrift(board, workspace))).toBe("quiet");

    const { report } = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
    const red = report.edges.find((edge) => edge.kind === "end-lacks-part");
    expect(red?.detail).toContain("cannot be called");
    // Named as what it is. A local has no keyword before its name, and the
    // sentence used to fall back to "a type" -- "a type is a plain value".
    expect(red?.detail).toContain("anchored at `ctx`, a value,");
  }, 120_000);

  const HANDLER = "class Base:\n    def __call__(self, n):\n        return n\n\n\n"
    + "class Handler(Base):\n    pass\n\n\nhandler = Handler()\n";

  it("stays green on a right arrow into a value whose class inherits `__call__`", async () => {
    write("handler.py", HANDLER);
    write("run.py", "from handler import handler\n\n\ndef execute(sink):\n"
      + "    sink.send()\n    handler(1)\n");
    const board = await boardOf("run.py#execute", "handler.py#handler");
    const workspace = createWorkspace(repo);
    const { report } = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
    expect(verdictOf(report)).toBe("green");
  }, 120_000);

  it("is not called wrong when the reader cannot confirm the call and pyright says it can be made", async () => {
    // A call on a local is one the reader never confirms, so this arrow is
    // quiet before and after -- and the one thing that must not happen to it
    // is a red from a compiler answer read the wrong way round.
    write("handler.py", HANDLER + "\n\ndef make_handler():\n    return Handler()\n");
    write("run.py", "from handler import make_handler\n\n\ndef execute(sink):\n"
      + "    local = make_handler()\n    sink.send()\n    local(1)\n");
    const board = await boardOf("run.py#execute", "run.py#local");
    const workspace = createWorkspace(repo);
    const { report } = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
    expect(report.edges).toEqual([]);
  }, 120_000);
});

describe("what pyright answers about one value", () => {
  /*
   * One name per shape, asked of one server. `false` is the only answer that
   * can put a red on a board; every value something can call -- through a
   * base class, a `functools.partial`, a class object -- has to come back as
   * anything else.
   */
  const SOURCE = [
    "import functools",
    "from typing import Type",
    "",
    "",
    "class Plain:",
    "    pass",
    "",
    "",
    "class Base:",
    "    def __call__(self):",
    "        return 1",
    "",
    "",
    "class Derived(Base):",
    "    pass",
    "",
    "",
    "def pick(flag):",
    "    return Plain() if flag else None",
    "",
    "",
    "def work(n):",
    "    return n",
    "",
    "",
    "def which() -> Type[Plain]:",
    "    return Plain",
    "",
    "",
    "PlainKind = Type[Plain]",
    "",
    "",
    "def which_kind() -> PlainKind:",
    "    return Plain",
    "",
    "",
    "plain = Plain()",
    "derived = Derived()",
    "maybe = pick(True)",
    "table = {\"a\": 1}",
    "bound = functools.partial(work, 1)",
    "kind = Plain",
    "func = work",
    "mystery = undefined_name",
    "chosen = which()",
    "aliased = which_kind()",
    "",
    "",
    "class Holder:",
    "    callback = None",
    "",
    "    def set(self, fn):",
    "        self.callback = fn",
    "",
    "",
    "def run(hook=None, count: int = 0):",
    "    return hook, count",
    "",
  ].join("\n");

  let answers: Record<string, unknown>;
  beforeAll(async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "engine-parts-pyright-"));
    writeFileSync(path.join(dir, "values.py"), SOURCE);
    const pyright = await createPyrightLspReferee(dir);
    try {
      answers = {};
      for (const name of ["plain", "derived", "maybe", "table", "bound", "kind", "func", "mystery", "chosen", "aliased"]) {
        const at = SOURCE.search(new RegExp(`^${name} =`, "m"));
        answers[name] = await pyright.valueKindAt(path.join(dir, "values.py"), SOURCE, at);
      }
      for (const [name, pattern] of [["callback", /callback = None/], ["hook", /hook=None/], ["count", /count: int/]] as const) {
        const at = SOURCE.search(pattern);
        answers[name] = await pyright.valueKindAt(path.join(dir, "values.py"), SOURCE, at);
      }
    } finally {
      pyright.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("says an instance of a class without `__call__` cannot be called, and is not a type", () => {
    expect(answers.plain).toEqual({ callable: false, type: false });
  });

  it("says an instance whose base defines `__call__` can be called", () => {
    expect((answers.derived as { callable?: boolean }).callable).toBe(true);
  });

  it("reads each half of a value that may be None", () => {
    expect((answers.maybe as { callable?: boolean }).callable).toBe(false);
  });

  it("says a dict cannot be called", () => {
    expect((answers.table as { callable?: boolean }).callable).toBe(false);
  });

  it("says a functools.partial can be called", () => {
    expect((answers.bound as { callable?: boolean }).callable).toBe(true);
  });

  it("never says a class held in a variable, or a function, cannot be called", () => {
    expect((answers.kind as { callable?: boolean } | undefined)?.callable).not.toBe(false);
    expect((answers.func as { callable?: boolean } | undefined)?.callable).not.toBe(false);
  });

  it("never says a class held through typing.Type cannot be called", () => {
    // pydantic's `cls_ = cls or model`, found by measure:parts: pyright prints
    // the old spelling with a capital T, and calling a class is how one is made.
    expect((answers.chosen as { callable?: boolean } | undefined)?.callable).not.toBe(false);
  });

  it("never says a class held through an alias cannot be called, though the hover shows only the alias", () => {
    // pydantic's `cls_: ModelOrDc`, where `ModelOrDc = Type[Union[...]]`: the
    // hover names the alias, `typeDefinition` names the classes, and nothing
    // says the value is the class rather than one of it.
    expect((answers.aliased as { callable?: boolean } | undefined)?.callable).not.toBe(false);
  });

  it("does not know about a value it cannot resolve", () => {
    expect((answers.mystery as { callable?: boolean } | undefined)?.callable).toBeUndefined();
  });

  /*
   * Two shapes where pyright's hover is the value written *here* and not
   * everything the name may hold. `callback = None` in a class body is
   * replaced by `self.callback = fn` in a method, and `hook=None` is only a
   * default -- a caller passes the function. Either read as "cannot be
   * called" is a red on a board that is right.
   */
  it("does not judge an unannotated class attribute, which a method may replace", () => {
    expect((answers.callback as { callable?: boolean } | undefined)?.callable).toBeUndefined();
  });

  it("does not judge an unannotated parameter by its default, and does judge an annotated one", () => {
    expect((answers.hook as { callable?: boolean } | undefined)?.callable).toBeUndefined();
    expect((answers.count as { callable?: boolean } | undefined)?.callable).toBe(false);
  });
});
