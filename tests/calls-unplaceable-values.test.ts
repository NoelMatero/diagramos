/**
 * A call the checker cannot follow to the code that runs is not a call it
 * checked (#400, #401, #402).
 *
 * "Every call this routine makes was checked" is only true when each call was
 * followed to a declaration. Three shapes were counted as followed and were
 * not, and each called a correct arrow wrong:
 *
 * - `pick()(1)` -- the outer call runs whatever `pick` returned, and was read
 *   as a second call of `pick` (#400);
 * - `const M = memo(Widget)` and `<M />` -- rendering was not counted as a
 *   call at all, and `M` names a value somebody built, not a routine (#402);
 * - `json.dump(d, w)` -- library code handed an object of this repository's
 *   may run its methods, and was read as reaching nothing here (#401).
 *
 * The guard the other way, per language: a body whose calls are all followed,
 * and that only names an unrelated function or hands on an object without the
 * head's method, still has its wrong arrow called wrong.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { callSitesIn } from "../src/engine/calls";
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

/** Checked the way the MCP server checks a board: compilers live. */
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
  repo = mkdtempSync(path.join(tmpdir(), "calls-unplaceable-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** One language's fixture: the files, the right arrows that must stay quiet, the wrong ones that must stay red. */
interface Shapes {
  files: Record<string, string>;
  right: Array<[string, string, string]>;
  /** The fourth element is the red expected, `calls-refuted` when left out. */
  wrong: Array<[string, string, string] | [string, string, string, string]>;
}

function shapes(language: string, fixture: Shapes, timeout: number, skip = false): void {
  describe.skipIf(skip)(language, () => {
    it.each(fixture.right)("stays quiet when %s", async (_shape, from, to) => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual([]);
    }, timeout);

    it.each(fixture.wrong)("still calls a wrong arrow wrong when %s", async (_shape, from, to, kind = "calls-refuted") => {
      write(fixture.files);
      expect(accusations(await checked(from, to))).toEqual([kind]);
    }, timeout);
  });
}

describe("a call of what another call returned (#400)", () => {
  shapes("TypeScript", {
    files: {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "util.ts": [
        "export function double(x: number): number {\n  return x * 2;\n}",
        "export function triple(x: number): number {\n  return x * 3;\n}",
        "export function pick(): (x: number) => number {\n  return double;\n}",
        "export function callPicked(): number {\n  return pick()(1);\n}",
        "export function plain(): number {\n  return triple(1);\n}",
        "",
      ].join("\n\n"),
    },
    right: [["the call runs a returned function", "util.ts#callPicked", "util.ts#double"]],
    wrong: [["every call is named, and none is the head", "util.ts#plain", "util.ts#double", "calls-wrong-routine"]],
  }, 120_000);

  shapes("Python", {
    files: {
      "util.py": [
        "def double(x):\n    return x * 2",
        "def triple(x):\n    return x * 3",
        "def pick():\n    return double",
        "def call_picked():\n    return pick()(1)",
        "def plain():\n    return triple(1)",
        "",
      ].join("\n\n\n"),
    },
    right: [["the call runs a returned function", "util.py#call_picked", "util.py#double"]],
    wrong: [["every call is named, and none is the head", "util.py#plain", "util.py#double", "calls-wrong-routine"]],
  }, 120_000);

  shapes("Rust", {
    files: {
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
      "src/lib.rs": "pub mod util;\n",
      "src/util.rs": [
        "pub fn double(x: i32) -> i32 {\n    x * 2\n}",
        "pub fn triple(x: i32) -> i32 {\n    x * 3\n}",
        "pub fn pick() -> fn(i32) -> i32 {\n    double\n}",
        "pub fn call_picked() -> i32 {\n    pick()(1)\n}",
        "pub fn plain() -> i32 {\n    triple(1)\n}",
        "",
      ].join("\n\n"),
    },
    right: [["the call runs a returned function", "src/util.rs#call_picked", "src/util.rs#double"]],
    wrong: [["every call is named, and none is the head", "src/util.rs#plain", "src/util.rs#double", "calls-wrong-routine"]],
  }, 180_000, !hasRustAnalyzer);
});

describe("rendering a component somebody wrapped (#402)", () => {
  const WIDGET = "import * as React from \"react\";\n\nexport function Widget2(props: { n: number }) {\n  return <b>{props.n}</b>;\n}\n";
  const OTHER = "import * as React from \"react\";\n\nexport function Other(props: { n: number }) {\n  return <i>{props.n}</i>;\n}\n";
  shapes("TSX", {
    files: {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"jsx\": \"react\" } }\n",
      "widget2.tsx": WIDGET,
      "other.tsx": OTHER,
      "memoed.tsx": "import * as React from \"react\";\nimport { Widget2 } from \"./widget2\";\n\nexport const Memoed = React.memo(Widget2);\n",
      "memo-default.tsx": "import * as React from \"react\";\nimport { Widget2 } from \"./widget2\";\n\nexport default React.memo(Widget2);\n",
      "other-default.tsx": "import * as React from \"react\";\n\nexport default function Plain(props: { n: number }) {\n  return <i>{props.n}</i>;\n}\n",
      "app.tsx": [
        "import * as React from \"react\";\nimport { Widget2 } from \"./widget2\";\nimport { Other } from \"./other\";\nimport { Memoed } from \"./memoed\";\nimport MemoDefault from \"./memo-default\";\nimport PlainDefault from \"./other-default\";",
        "const M = React.memo(Widget2);",
        "export function AppMemo() {\n  return <M n={1} />;\n}",
        "export function AppImported() {\n  return <Memoed n={1} />;\n}",
        "export function AppDefault() {\n  return <MemoDefault n={1} />;\n}",
        "export function AppPlainDefault() {\n  return <PlainDefault n={1} />;\n}",
        "export function AppOther() {\n  return <div><Other n={1} /></div>;\n}",
        "",
      ].join("\n\n"),
    },
    right: [
      ["the wrapper is in the same file", "app.tsx#AppMemo", "widget2.tsx#Widget2"],
      ["the wrapper is imported from another file", "app.tsx#AppImported", "widget2.tsx#Widget2"],
      ["the wrapper is another file's default export", "app.tsx#AppDefault", "widget2.tsx#Widget2"],
    ],
    wrong: [
      ["it renders only an unrelated component", "app.tsx#AppOther", "widget2.tsx#Widget2"],
      ["it renders only an unrelated default export", "app.tsx#AppPlainDefault", "widget2.tsx#Widget2"],
    ],
  }, 120_000);
});

describe("an object handed to library code (#401)", () => {
  shapes("Python", {
    files: {
      "writer.py": [
        "import json",
        "class Writer:\n    def __init__(self):\n        self.parts = []\n\n    def write(self, s):\n        self.parts.append(s)",
        "class Quiet:\n    def __init__(self):\n        self.parts = []\n\n    def flush(self):\n        self.parts.clear()",
        "def helper():\n    return 1",
        "def dump(w: Writer):\n    json.dump({'a': 1}, w)",
        "def show(w: Writer):\n    print('x', file=w)",
        "def show_quiet(q: Quiet):\n    print('x', file=q)",
        "",
      ].join("\n\n\n"),
    },
    right: [
      ["json.dump is handed the object", "writer.py#dump", "writer.py#write"],
      ["print is handed it as file=", "writer.py#show", "writer.py#write"],
    ],
    wrong: [
      /*
       * The compiler's "no" keeps the red. Asked of `print`, which is placed
       * without a server: through `json.dump` the question comes a round too
       * late for the one round a live check asks (#399's gap), and the red is
       * held back rather than shown.
       */
      ["the object handed on has no such method", "writer.py#show_quiet", "writer.py#write"],
      ["the head is a function, not a method of what is handed on", "writer.py#dump", "writer.py#helper"],
    ],
  }, 120_000);
});

describe("a call of a call does not hide a class the tail does call (#400, found by bench:planted)", () => {
  /*
   * nest's `RouterExplorer` calls `this.routePathFactory.create(...)`, and
   * elsewhere `this.createCallbackProxy(...)(req, res, next)`. The second is
   * now a call nothing can name, and it was the reason recorded for the
   * arrow -- one no compiler can settle, so the live check never started one
   * to place the first, and a confirmed arrow went unconfirmed.
   */
  it("still confirms an arrow between two classes", async () => {
    write({
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "factory.ts": "export class Factory {\n  create(n: number): number {\n    return n + 1;\n  }\n}\n",
      "explorer.ts": [
        "import { Factory } from \"./factory\";",
        "export class Explorer {\n  constructor(private readonly factory: Factory) {}\n\n"
          + "  paths(n: number): number {\n    return this.factory.create(n);\n  }\n\n"
          + "  proxy(): (n: number) => number {\n    return (n) => n;\n  }\n\n"
          + "  handle(n: number): number {\n    return this.proxy()(n);\n  }\n}",
        "",
      ].join("\n\n"),
    });
    const report = await checked("explorer.ts#Explorer", "factory.ts#Factory");
    expect(accusations(report)).toEqual([]);
    expect(report.claims.callsConfirmed).toBe(1);
  }, 120_000);
});

describe("a type named Ok is not a value somebody built (#402, found by bench:planted)", () => {
  /*
   * serde's `Serializer` impls declare `type Ok = Value;`, and the first
   * version of #402's rule took that `Ok` -- declared in the file, and
   * neither a routine nor a class -- for a value, so every `Ok(...)` read as
   * a call on one. That was the first reason serde_json's `Serializer ->
   * Value` stopped on, and no compiler settles it, so none was asked to place
   * the call that confirmed it. Only a declaration that assigns a value is one.
   */
  it("places Ok(...) as the language's own", () => {
    const source = [
      "pub trait Sink {\n    type Ok;\n    fn put(&self) -> Result<Self::Ok, ()>;\n}",
      "pub struct S;",
      "impl Sink for S {\n    type Ok = i32;\n\n    fn put(&self) -> Result<i32, ()> {\n        Ok(2)\n    }\n}",
      "",
    ].join("\n\n");
    const reading = callSitesIn({ file: "src/a.rs", source, language: "rust", imports: [] });
    if (!reading.read) throw new Error(`unread: ${reading.why}`);
    const sites = reading.bodies.flatMap((body) => body.sites).filter((site) => site.name === "Ok");
    expect(sites).toHaveLength(1);
    expect(sites[0]!.why).toBeUndefined();
  });
});

describe("an unnameable call written first does not hide the one a compiler can place", () => {
  it("still confirms an arrow between two classes", async () => {
    write({
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "factory.ts": "export class Factory {\n  create(n: number): number {\n    return n + 1;\n  }\n}\n",
      "explorer.ts": [
        "import { Factory } from \"./factory\";",
        "export class Explorer {\n  constructor(private readonly factory: Factory) {}\n\n"
          + "  proxy(): (n: number) => number {\n    return (n) => n;\n  }\n\n"
          + "  handle(n: number): number {\n    return this.proxy()(n);\n  }\n\n"
          + "  paths(n: number): number {\n    return this.factory.create(n);\n  }\n}",
        "",
      ].join("\n\n"),
    });
    const report = await checked("explorer.ts#Explorer", "factory.ts#Factory");
    expect(accusations(report)).toEqual([]);
    expect(report.claims.callsConfirmed).toBe(1);
  }, 120_000);
});
