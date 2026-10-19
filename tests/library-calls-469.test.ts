/**
 * A call into a library cannot be the box an arrow points at (#469).
 *
 * `cast(...)` from `typing`, `isNil(...)` from a utility package,
 * `max(...)` from `std::cmp`: the code that runs is outside the repository,
 * so it is not the head. The checker used to leave those calls "not sure",
 * and one of them kept a whole function from being checked.
 *
 * The refusals come first, because they are what makes the rule safe:
 *
 *   - The library is handed something of this repository's that it can run:
 *     a function by name, a bound method, a coroutine made by a call written
 *     here, a closure. Libraries call back, so the body stays "not sure".
 *     A parameter handed on is not one: what it holds is not in the text,
 *     and with compilers live main already read `asyncio.Task(coro)` that
 *     way before this change.
 *   - The import only looks like a package. A workspace sibling
 *     (`@acme/common/utils`, Nest's 477 calls in the #467 census) or a
 *     tsconfig nickname is this repository's own code.
 *
 * Then the wrong arrows the rule exists for: every call placed, one of them
 * a library's, and the head is none of them.
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

/** The same check every other rust-analyzer test here makes: the live half needs the real binary. */
const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

/**
 * Checked from the text alone, the way a check with no compiler sees it, or
 * with the compilers live, the way the MCP server and the bench check.
 */
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

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "library-calls-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

interface Shapes {
  files: Record<string, string>;
  /** Right arrows, or arrows nobody can call wrong: must stay quiet. */
  right: Array<[string, string, string]>;
  /** Wrong arrows: the red expected, `calls-refuted` when left out. */
  wrong: Array<[string, string, string] | [string, string, string, string]>;
}

function shapes(language: string, fixture: Shapes): void {
  const rust = Object.keys(fixture.files).some((file) => file.endsWith(".rs"));
  for (const live of [false, true]) {
    describe.skipIf(live && rust && !hasRustAnalyzer)(`${language}, ${live ? "compilers live" : "text alone"}`, () => {
      if (fixture.right.length > 0) {
        it.each(fixture.right)("stays quiet when %s", async (_shape, from, to) => {
          write(fixture.files);
          expect(accusations(await checked(from, to, live))).toEqual([]);
        }, 180_000);
      }
      if (fixture.wrong.length > 0) {
        it.each(fixture.wrong)("calls a wrong arrow wrong when %s", async (_shape, from, to, kind = "calls-refuted") => {
          write(fixture.files);
          expect(accusations(await checked(from, to, live))).toEqual([kind]);
        }, 180_000);
      }
    });
  }
}

describe("refusals: the library is handed something of the repository's it can run", () => {
  shapes("Python", {
    files: {
      "target.py": "def b(x):\n    return x\n\n\ndef other(x):\n    return x\n",
      "work.py": [
        "import asyncio\nfrom threading import Thread\nfrom functools import partial\nfrom toolz import pipe\nfrom target import b",
        "async def work():\n    b(1)",
        "def helper(x):\n    return b(x)",
        "def start_named():\n    coro = work()\n    return asyncio.Task(coro)",
        "def through_pipe(xs):\n    return pipe(xs, helper)",
        "def through_thread():\n    Thread(target=helper).start()",
        "def through_partial():\n    return partial(helper, 1)",
        "class Runner:\n    def run(self):\n        return b(2)\n\n    def go(self):\n        return Thread(target=self.run)",
        "",
      ].join("\n\n\n"),
    },
    right: [
      ["asyncio.Task is handed a coroutine made from a function that calls the head", "work.py#start_named", "target.py#b"],
      ["a library function is handed a function that calls the head", "work.py#through_pipe", "target.py#b"],
      ["a library class is handed a function as a keyword", "work.py#through_thread", "target.py#b"],
      ["functools.partial wraps a function that calls the head", "work.py#through_partial", "target.py#b"],
      ["a library is handed a bound method that calls the head", "work.py#Runner.go", "target.py#b"],
    ],
    wrong: [],
  });

  shapes("TypeScript", {
    files: {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "target.ts": "export function b(x: number): number {\n  return x;\n}\n",
      "work.ts": [
        "import { debounce, flow } from \"lodash\";\nimport { b } from \"./target\";",
        "function helper(x: number): number {\n  return b(x);\n}",
        "export function viaMap(xs: number[]): number[] {\n  return xs.map(helper);\n}",
        "export function viaDebounce(): () => void {\n  return debounce(helper, 10);\n}",
        "export function viaFlow(): (x: number) => number {\n  return flow(helper);\n}",
        "export class Panel {\n  flush(): number {\n    return b(1);\n  }\n\n  later(): () => void {\n    return debounce(this.flush, 10);\n  }\n}",
        "",
      ].join("\n\n"),
    },
    right: [
      ["arr.map is handed a function that calls the head", "work.ts#viaMap", "target.ts#b"],
      ["a library function is handed a function that calls the head", "work.ts#viaDebounce", "target.ts#b"],
      ["a library composes a function that calls the head", "work.ts#viaFlow", "target.ts#b"],
      ["a library is handed a bound method that calls the head", "work.ts#Panel.later", "target.ts#b"],
    ],
    wrong: [],
  });

  shapes("Rust", {
    files: {
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
      "src/lib.rs": "pub mod target;\npub mod work;\n",
      "src/target.rs": "pub fn b(x: i32) -> i32 {\n    x\n}\n",
      "src/work.rs": [
        "use std::thread::spawn;\nuse crate::target::b;",
        "fn helper() {\n    b(1);\n}",
        "pub fn through_spawn() {\n    spawn(helper);\n}",
        "pub fn through_closure(xs: Vec<i32>) {\n    xs.into_iter().for_each(|x| { b(x); });\n}",
        "",
      ].join("\n\n"),
    },
    right: [
      ["a library function is handed a function that calls the head", "src/work.rs#through_spawn", "src/target.rs#b"],
      ["iter.for_each is handed a closure that calls the head", "src/work.rs#through_closure", "src/target.rs#b"],
    ],
    wrong: [],
  });
});

describe("refusals: an import that only looks like a package is this repository's", () => {
  /*
   * Nest's shape (#467): the root `package.json` lists `packages/*` as
   * workspaces, tsconfig maps `@acme/common/*` there, and a file in one
   * package imports a deep path of another by the sibling's published name.
   * The arrow is right; reading the import as a library would call it wrong.
   */
  /* `isNil` reaches `unrelated`, so an arrow from its caller is one level high, never wrong. */
  const helper = "import { unrelated } from \"../other\";\n\nexport function isNil(x: unknown): boolean {\n  return unrelated() === 0 || x === undefined;\n}\n";
  const caller = "import { isNil } from \"@acme/common/utils/shared\";\n\nexport function load(x: unknown): number {\n  return isNil(x) ? 0 : 1;\n}\n";
  const other = "export function unrelated(): number {\n  return 1;\n}\n";

  shapes("a workspace sibling", {
    files: {
      "package.json": "{ \"name\": \"root\", \"private\": true, \"workspaces\": [\"packages/*\"] }\n",
      "packages/common/package.json": "{ \"name\": \"@acme/common\" }\n",
      "packages/common/utils/shared.ts": helper,
      "packages/common/other.ts": other,
      "packages/core/package.json": "{ \"name\": \"@acme/core\" }\n",
      "packages/core/load.ts": caller,
    },
    right: [
      ["the call is to the sibling's own function", "packages/core/load.ts#load", "packages/common/utils/shared.ts#isNil"],
      ["the sibling's function may be what reaches the head", "packages/core/load.ts#load", "packages/common/other.ts#unrelated"],
    ],
    wrong: [],
  });

  shapes("a tsconfig nickname", {
    files: {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"baseUrl\": \".\", \"paths\": { \"@acme/common/*\": [\"./lib/common/*\"] } } }\n",
      "lib/common/utils/shared.ts": helper,
      "lib/common/other.ts": other,
      "app/load.ts": caller,
    },
    right: [
      ["the call is to the nickname's own function", "app/load.ts#load", "lib/common/utils/shared.ts#isNil"],
      ["the nickname's function may be what reaches the head", "app/load.ts#load", "lib/common/other.ts#unrelated"],
    ],
    wrong: [],
  });

  shapes("a Python module the import roots do not reach", {
    files: {
      "libs/common/shared.py": "from other import unrelated\n\n\ndef is_nil(x):\n    return unrelated() == 0 or x is None\n",
      "libs/common/other.py": "def unrelated():\n    return 1\n",
      "app/load.py": "from shared import is_nil\n\n\ndef load(x):\n    return 0 if is_nil(x) else 1\n",
    },
    right: [
      ["a module named like one of the repository's files", "app/load.py#load", "libs/common/other.py#unrelated"],
    ],
    wrong: [],
  });

  shapes("a Rust crate of this workspace", {
    files: {
      "Cargo.toml": "[workspace]\nmembers = [\"common\", \"core\"]\n",
      "common/Cargo.toml": "[package]\nname = \"acme-common\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "common/src/lib.rs": "pub mod other;\n\nuse crate::other::unrelated;\n\npub fn is_nil(x: Option<i32>) -> bool {\n    unrelated() == 0 || x.is_none()\n}\n",
      "common/src/other.rs": "pub fn unrelated() -> i32 {\n    1\n}\n",
      "core/Cargo.toml": "[package]\nname = \"acme-core\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\nacme-common = { path = \"../common\" }\n",
      "core/src/lib.rs": "use acme_common::is_nil;\n\npub fn load(x: Option<i32>) -> i32 {\n    if is_nil(x) { 0 } else { 1 }\n}\n",
    },
    right: [
      ["the sibling crate's function may be what reaches the head", "core/src/lib.rs#load", "common/src/other.rs#unrelated"],
    ],
    wrong: [],
  });
});

describe("a library call is not the head", () => {
  shapes("Python", {
    files: {
      "target.py": "def b(x):\n    return x\n",
      "compat.py": "from urllib.parse import quote as compat_quote\n",
      "work.py": [
        "import os\nimport warnings\nfrom typing import cast\nfrom urllib.parse import quote\nfrom toolz import pipe\nfrom compat import compat_quote",
        "def plain(x):\n    return quote(cast(str, x))",
        "def module_calls(x):\n    warnings.warn('old')\n    return os.getcwd()",
        "def keeps_value(x):\n    return quote(x, safe='/')",
        "def passed_on(x):\n    return compat_quote(x)",
        "def shout(x):\n    return x",
        "def hands_unrelated(xs):\n    return list(pipe(xs, shout))",
        "",
      ].join("\n\n\n"),
    },
    right: [],
    wrong: [
      ["the library is handed a function that never reaches the head", "work.py#hands_unrelated", "target.py#b"],
      ["every call is a library function imported by name", "work.py#plain", "target.py#b"],
      ["the library function is passed on by a module of the repository's", "work.py#passed_on", "target.py#b"],
      ["every call is a library module's function", "work.py#module_calls", "target.py#b"],
      ["the library is handed only plain values", "work.py#keeps_value", "target.py#b"],
    ],
  });

  shapes("TypeScript", {
    files: {
      "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
      "target.ts": "export function b(x: number): number {\n  return x;\n}\n",
      "vendor-core.ts": "export { isStringLiteral } from \"zurk/spawn\";\n",
      "util.ts": "export { isStringLiteral } from \"./vendor-core\";\n",
      "work.ts": [
        "import { isStringLiteral } from \"./util\";\nimport { debounce, isNil } from \"lodash\";\nimport * as path from \"node:path\";",
        "export function plain(x: unknown): number {\n  return isNil(x) ? 0 : 1;\n}",
        "export function joined(a: string): string {\n  return path.join(a, \"x\");\n}",
        "function shout(x: number): number {\n  return x;\n}",
        "export function echo(x: unknown): boolean {\n  return isStringLiteral(x);\n}",
        "export function handsUnrelated(): () => void {\n  return debounce(shout, 10);\n}",
        "",
      ].join("\n\n"),
    },
    right: [],
    wrong: [
      ["every call is a package's function imported by name", "work.ts#plain", "target.ts#b"],
      ["every call is a namespace import's function", "work.ts#joined", "target.ts#b"],
      ["the package's function is passed on through two files of the repository's", "work.ts#echo", "target.ts#b"],
      ["the library is handed a function that never reaches the head", "work.ts#handsUnrelated", "target.ts#b"],
    ],
  });

  shapes("Rust", {
    files: {
      "Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\nedition = \"2021\"\n[workspace]\n",
      "src/lib.rs": "pub mod target;\npub mod work;\n",
      "src/target.rs": "pub fn b(x: i32) -> i32 {\n    x\n}\n",
      "src/work.rs": "use std::cmp::max;\n\npub fn plain(x: i32) -> i32 {\n    max(x, 1)\n}\n",
    },
    right: [],
    wrong: [
      ["every call is a library function imported by name", "src/work.rs#plain", "src/target.rs#b"],
    ],
  });
});
