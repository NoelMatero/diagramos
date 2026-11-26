/**
 * An arrow into a value the kind reader could not find (missed map
 * 2026-11b, pattern 1d).
 *
 * `transformElement --@calls--> source` cannot be true when `source` is the
 * key of an object literal holding `''`: nothing can call a string. But the
 * kind reader (`parts.ts`) looked only at declarations and parameters, and a
 * key, an attribute set in a method (`self._nested = False`) or a name in a
 * tuple (`start, stop, step = s.indices(n)`) is neither. It found nothing,
 * asked nothing, and the arrow stayed "not sure" however plainly it pointed
 * at a piece of data. 27 wrong arrows on the study sets ended at such a name.
 *
 * Now the reader also reads the places a file gives a name a value without
 * declaring it: an object's key, an attribute set on an object, a name inside
 * a destructuring or tuple target. Each is data when the text says so (a
 * literal, a plain annotation) or when a compiler says its value cannot be
 * called, and the name lacks a part only when **every** such place lacks it.
 *
 * Every red here is "not sure" on main. Each wrong arrow's tail also writes
 * the head's name and makes a call nobody can place, so the call reading and
 * "a value is called by its name" (#514) cannot settle it first: the kind of
 * the end is its only chance of a verdict. The refusals are the shapes where
 * such a name may hold a function: a function written under it anywhere, a
 * name the compiler calls callable, the name written as a string (`setattr`,
 * `obj["x"]`), a destructured parameter, `None` waiting for a value, an
 * import.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import type { ArrowClaim } from "../src/engine/claim";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { partsOf } from "../src/engine/parts";
import { refereedCheck } from "../src/engine/referee";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function boardOf(claim: ArrowClaim, fromRef: string, toRef: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "from", label: "from", ref: fromRef },
      { id: "to", label: "to", ref: toRef },
    ],
    edges: [{ from: "from", to: "to", claim }],
  });
  return board;
}

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);
const reds = (report: DriftReport) => report.edges.filter((finding) => ACCUSING.has(finding.kind));
/** The kind red, and nothing else: a red another reader gives is not this rule's. */
const kindRed = (report: DriftReport) => {
  expect(reds(report).map((finding) => finding.kind)).toEqual(["end-lacks-part"]);
  return reds(report)[0]!.detail;
};

async function textCheck(claim: ArrowClaim, fromRef: string, toRef: string, files: Record<string, string>) {
  return checkDrift(await boardOf(claim, fromRef, toRef), fakeWorkspace(files), { edges: true });
}

/*
 * The tails. Each writes the head's name -- so "a value is called by its
 * name" cannot rule it out -- and calls something out of a table by a key
 * nobody can read, so the call reading never closes.
 */
const TS_TAIL = "export function transform(node: any, table: any, kind: string) {\n"
  + "  table[kind](node.source);\n"
  + "}\n";
const PY_TAIL = "def render(node, table, kind):\n"
  + "    table[kind](node.source, node.step, node._nested, node.dump_fields)\n";

describe("text alone: a name given only data", () => {
  it("calls an arrow into an object's key holding a string wrong (vue's `source: ''`)", async () => {
    const report = await textCheck("calls", "src/run.ts#transform", "src/run.ts#source", {
      "src/run.ts": TS_TAIL + "export const DEFAULTS = { source: '', depth: 1 };\n",
    });
    const detail = kindRed(report);
    expect(detail).toContain("cannot be called");
    expect(detail).toContain("anchored at `source`, a value,");
  });

  it("calls an arrow into an attribute set to a boolean wrong (rich's `self._nested = False`)", async () => {
    const files = {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/live.py": "class Live:\n    def __init__(self):\n        self._nested = False\n\n"
        + "    def start(self):\n        self._nested = True\n",
    };
    expect(kindRed(await textCheck("calls", "src/run.py#render", "src/live.py#_nested", files)))
      .toContain("cannot be called");
    expect(kindRed(await textCheck("builds", "src/run.py#render", "src/live.py#_nested", files)))
      .toContain("is not a type");
  });

  it("calls an arrow into an attribute annotated as a dict wrong (marshmallow's `self.dump_fields: dict[str, Field] = {}`)", async () => {
    const report = await textCheck("calls", "src/run.py#render", "src/schema.py#dump_fields", {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/schema.py": "class Schema:\n    def __init__(self):\n        self.dump_fields: dict[str, Field] = {}\n",
    });
    expect(kindRed(report)).toContain("cannot be called");
  });

  it("reads a JavaScript attribute set to a number as data", () => {
    const source = "class Job {\n  constructor() {\n    this.attempts = 0;\n  }\n  retry() {\n    this.attempts = 1;\n  }\n}\n";
    expect(partsOf(source, "attempts", "js")?.callable).toBe("lacks");
  });
});

describe("text alone: what must stay not sure", () => {
  const quiet = async (claim: ArrowClaim, fromRef: string, toRef: string, files: Record<string, string>) => {
    expect(reds(await textCheck(claim, fromRef, toRef, files))).toEqual([]);
  };

  it("a key that holds a function in one place and a string in another", async () => {
    await quiet("calls", "src/run.ts#transform", "src/run.ts#source", {
      "src/run.ts": TS_TAIL + "export const A = { source: '' };\nexport const B = { source: () => 1 };\n",
    });
  });

  it("an attribute that holds a function in one place and a boolean in another", async () => {
    await quiet("calls", "src/run.py#render", "src/live.py#_nested", {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/live.py": "class Live:\n    def __init__(self):\n        self._nested = False\n\n"
        + "    def start(self, hook):\n        self._nested = lambda: hook()\n",
    });
  });

  it("an attribute that holds whatever it was handed, with no compiler to ask", async () => {
    await quiet("calls", "src/run.py#render", "src/live.py#_nested", {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/live.py": "class Live:\n    def __init__(self, nested):\n        self._nested = nested\n",
    });
  });

  it("an attribute set to None and nothing else: a slot waiting for its value (django's `_middleware_chain`)", async () => {
    await quiet("calls", "src/run.py#render", "src/live.py#_nested", {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/live.py": "class Live:\n    def __init__(self):\n        self._nested = None\n",
    });
  });

  it("a name the file also writes as a string: setattr, a key read by its string", async () => {
    await quiet("calls", "src/run.py#render", "src/live.py#_nested", {
      "src/__init__.py": "",
      "src/run.py": PY_TAIL,
      "src/live.py": "class Live:\n    def __init__(self, hook):\n        self._nested = False\n"
        + "        setattr(self, \"_nested\", hook)\n",
    });
    await quiet("calls", "src/run.ts#transform", "src/run.ts#source", {
      "src/run.ts": TS_TAIL + "export const A = { source: '' };\nexport function f(o: any, g: any) { o['source'] = g; }\n",
    });
  });

  it("a name a parameter destructures", async () => {
    await quiet("calls", "src/run.ts#transform", "src/run.ts#source", {
      "src/run.ts": TS_TAIL + "export const A = { source: '' };\nexport function f({ source }: any) { return source(); }\n",
    });
  });

  it("a name the file imports", async () => {
    await quiet("calls", "src/run.ts#transform", "src/run.ts#source", {
      "src/run.ts": "import { source } from './other';\n" + TS_TAIL + "export const A = { source: '' };\n",
      "src/other.ts": "export function source() { return 1; }\n",
    });
  });

  it("a key in a Python dict, which is a string and not a name, and a keyword argument", () => {
    const source = "def f(g):\n    table = {\"step\": 1}\n    g(step=2)\n";
    expect(partsOf(source, "step", "python")).toBeUndefined();
  });

  it("a name in a tuple, with no compiler to say what it holds", () => {
    const source = "def f(s, n):\n    start, stop, step = s.indices(n)\n    return start\n";
    expect(partsOf(source, "step", "python")?.callable).toBe("unsure");
  });

  it("Rust is not read this way: its values go through the written type", () => {
    const source = "fn f() { let (a, b) = (1, 2); }\n";
    expect(partsOf(source, "a", "rust")).toBeUndefined();
  });
});

let repo: string;

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe("with a compiler: a name given a value the text cannot judge", () => {
  beforeEach(() => {
    // Outside the worktree: a scratch source file inside one is read by the dependency tests.
    repo = mkdtempSync(path.join(tmpdir(), "value-slots-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { target: "ES2022", strict: true } }));
  });
  afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

  const refereed = (board: BoardFile) => {
    const workspace = createWorkspace(repo);
    return refereedCheck(repo, (referee) => checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
  };

  it("TypeScript: calls an arrow into a key holding a message wrong (npm-check-updates' `error: `...``)", async () => {
    write("src/run.ts", TS_TAIL);
    write("src/query.ts", "export function query(message: string, err: any) {\n"
      + "  if (err) return { error: `${message}: failed` };\n"
      + "  return { error: message || 'Invalid URL' };\n}\n");
    const board = await boardOf("calls", "src/run.ts#transform", "src/query.ts#error");
    expect(reds(checkDrift(board, createWorkspace(repo)))).toEqual([]);
    expect(kindRed(refereed(board))).toContain("cannot be called");
  });

  it("TypeScript: calls an arrow into a destructured number wrong", async () => {
    write("src/run.ts", TS_TAIL);
    write("src/range.ts", "function pair(): [number, number] { return [1, 2]; }\n"
      + "export function span() {\n  const [start, end] = pair();\n  return end - start;\n}\n");
    const board = await boardOf("calls", "src/run.ts#transform", "src/range.ts#start");
    expect(kindRed(refereed(board))).toContain("cannot be called");
  });

  it("TypeScript: stays quiet on a key holding a function the text cannot see", async () => {
    write("src/run.ts", TS_TAIL);
    write("src/query.ts", "function fail(): void {}\nexport function query() {\n  return { error: fail };\n}\n");
    const board = await boardOf("calls", "src/run.ts#transform", "src/query.ts#error");
    expect(reds(refereed(board))).toEqual([]);
  });

  it("TypeScript: a destructured class is not told it is not a type", async () => {
    write("src/run.ts", TS_TAIL);
    write("src/models.ts", "class User { id = 1; }\nconst registry = { User };\n"
      + "export function make() {\n  const { User: Model } = registry;\n  return new Model();\n}\n");
    const board = await boardOf("builds", "src/run.ts#transform", "src/models.ts#Model");
    expect(reds(refereed(board))).toEqual([]);
  });

  /*
   * Python goes through pyright, which answers over a pipe: the check records
   * the question on a first pass, asks it once, and reads the answer back.
   */
  const live = async (board: BoardFile) => {
    const workspace = createWorkspace(repo);
    const { report } = await refereedCheckLive(repo, (referee) =>
      checkDrift(board, workspace, referee ? { closedBodyReferee: referee } : {}));
    return report;
  };

  it("Python: calls an arrow into a name unpacked from a tuple of ints wrong (rich's `line_start, line_end = ...`)", async () => {
    write("run.py", PY_TAIL);
    write("text.py", "def spans(line_ranges: list[tuple[int, int]], n: int) -> int:\n"
      + "    line_start, line_end = line_ranges[n]\n    return line_end - line_start\n");
    const board = await boardOf("calls", "run.py#render", "text.py#line_start");
    expect(reds(checkDrift(board, createWorkspace(repo)))).toEqual([]);
    expect(kindRed(await live(board))).toContain("cannot be called");
  }, 120_000);

  it("Python: stays quiet on a tuple of functions", async () => {
    write("run.py", PY_TAIL);
    write("hooks.py", "from typing import Callable\n\n\n"
      + "def handlers() -> tuple[Callable[[], None], Callable[[], None]]:\n    return (lambda: None, lambda: None)\n\n\n"
      + "def go():\n    on_ok, on_err = handlers()\n    on_ok()\n");
    const board = await boardOf("calls", "run.py#render", "hooks.py#on_err");
    expect(reds(await live(board))).toEqual([]);
  }, 120_000);

  it("Python: stays quiet on an attribute set to None here and to a function later", async () => {
    write("run.py", PY_TAIL);
    write("live.py", "class Live:\n    def __init__(self):\n        self.chain = None\n\n"
      + "    def load(self, handler):\n        self.chain = handler\n");
    const board = await boardOf("calls", "run.py#render", "live.py#chain");
    expect(reds(await live(board))).toEqual([]);
  }, 120_000);
});
