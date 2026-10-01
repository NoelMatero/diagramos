/**
 * "This file imports that one" is not called wrong when the import is written
 * in a form the reader could not place (#386, #390, #383, #393).
 *
 * `import x = require("./x")` is an import the reader never read. A sibling
 * package imported by its name (`@acme/core`) and a Rust macro from another
 * file (`crate::cents!`) are imports whose landing the text does not give.
 * The first is now read; the other two are put to the compiler, and with no
 * compiler a red about them is withheld.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, hasRustAnalyzer, redsOf, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

describe("TypeScript's `import x = require()` (#386)", () => {
  const CJS = {
    "package.json": "{ \"name\": \"probe\" }\n",
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"module\": \"nodenext\", \"moduleResolution\": \"nodenext\", \"target\": \"es2022\", \"noEmit\": true } }\n",
    "lib/legacy.cts": "function legacy(): number {\n  return 1;\n}\nexport = legacy;\n",
    "lib/plain.ts": "export function plain(): number {\n  return 1;\n}\n",
    "h1.cts": "import legacy = require(\"./lib/legacy.cjs\");\nexport function r(): number {\n  return legacy();\n}\n",
    "h4.ts": "import plainMod = require(\"./lib/plain\");\nexport function r(): number {\n  return plainMod.plain();\n}\n",
  };

  it.each([
    ["with no extension", "h4.ts", "lib/plain.ts"],
    ["of a `.cjs` that is a `.cts`", "h1.cts", "lib/legacy.cts"],
  ])("is read as an import, %s, even with no compiler", async (_shape, from, to) => {
    repo = scratchRepo(CJS);
    const { each: [arrow] } = await verdicts(repo, [[from, to, "needs"]], { compiler: false });
    expect(arrow).toEqual({ reds: [] });
  }, 60_000);

  it("still calls a wrong arrow from it wrong", async () => {
    repo = scratchRepo(CJS);
    expect(await redsOf(repo, ["h4.ts", "lib/legacy.cts", "needs"], { compiler: false })).toEqual(["needs-absent"]);
  }, 60_000);
});

const MONO = {
  "package.json": "{ \"name\": \"root\", \"private\": true, \"workspaces\": [\"packages/*\"] }\n",
  "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\", \"module\": \"nodenext\", \"moduleResolution\": \"nodenext\" } }\n",
  "packages/core/package.json": "{ \"name\": \"@acme/core\", \"type\": \"module\", \"exports\": { \".\": \"./src/index.ts\", \"./money\": \"./src/money.ts\" } }\n",
  "packages/core/src/index.ts": "export { double } from \"./math.js\";\n",
  "packages/core/src/math.ts": "export function double(x: number): number {\n  return x * 2;\n}\n",
  "packages/core/src/money.ts": "export class Money {}\n",
  "packages/util/package.json": "{ \"name\": \"@acme/util\", \"type\": \"module\" }\n",
  "packages/util/src/index.ts": "export function triple(x: number): number {\n  return x * 3;\n}\n",
  "packages/app/package.json": "{ \"name\": \"@acme/app\", \"type\": \"module\", \"dependencies\": { \"@acme/core\": \"*\" } }\n",
  "packages/app/src/main.ts": "import { double } from \"@acme/core\";\nimport { Money } from \"@acme/core/money\";\n\nexport function run(): number {\n  return double(1);\n}\n\nexport function make(): Money {\n  return new Money();\n}\n",
};

describe("a sibling package imported by its name, in a workspace (#390)", () => {
  const RIGHT: Array<[string, string, string]> = [
    ["packages/app/src/main.ts", "packages/core/src/index.ts", "needs"],
    ["packages/app/src/main.ts", "packages/core/src/math.ts", "depends"],
    ["packages/app/src/main.ts", "packages/core/src/money.ts", "needs"],
  ];

  it("stays quiet on each arrow, when npm has linked the packages", async () => {
    repo = scratchRepo(MONO);
    const { symlinkSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${repo}/node_modules/@acme`, { recursive: true });
    symlinkSync("../../packages/core", `${repo}/node_modules/@acme/core`);
    const { each } = await verdicts(repo, RIGHT);
    expect(each.map((one) => one.reds)).toEqual([[], [], []]);
  }, 60_000);

  it("stays quiet on a fresh clone with nothing linked", async () => {
    repo = scratchRepo(MONO);
    const { each } = await verdicts(repo, RIGHT);
    expect(each.map((one) => one.reds)).toEqual([[], [], []]);
  }, 60_000);

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(MONO);
    const { each } = await verdicts(repo, RIGHT, { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([[], [], []]);
    expect(each.map((one) => one.unconfirmed)).toEqual(["rests-on-unwritten", "rests-on-unwritten", "rests-on-unwritten"]);
  }, 60_000);

  it("still calls wrong a file that imports nothing, with no compiler", async () => {
    repo = scratchRepo(MONO);
    expect(await redsOf(repo, ["packages/util/src/index.ts", "packages/core/src/math.ts", "needs"], { compiler: false })).toEqual(["needs-absent"]);
  }, 60_000);

  it("still calls it wrong when the compiler says the package leads elsewhere", async () => {
    repo = scratchRepo(MONO);
    const { symlinkSync, mkdirSync } = await import("node:fs");
    mkdirSync(`${repo}/node_modules/@acme`, { recursive: true });
    symlinkSync("../../packages/core", `${repo}/node_modules/@acme/core`);
    expect(await redsOf(repo, ["packages/app/src/main.ts", "packages/util/src/index.ts", "needs"])).toEqual(["needs-absent"]);
  }, 60_000);
});

const RUST = {
  "Cargo.toml": "[workspace]\nmembers = [\"core\", \"app\"]\nresolver = \"2\"\n",
  "core/Cargo.toml": "[package]\nname = \"core_lib\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
  "core/src/lib.rs": "pub mod util;\npub mod macros;\npub mod user;\npub mod plain;\n",
  "core/src/util.rs": "pub fn double(x: i64) -> i64 {\n    x * 2\n}\n",
  "core/src/plain.rs": "pub fn one() -> i64 {\n    1\n}\n",
  "core/src/macros.rs": "#[macro_export]\nmacro_rules! cents {\n    ($x:expr) => {\n        $crate::util::double($x)\n    };\n}\n",
  "core/src/user.rs": "pub fn u() -> i64 {\n    crate::cents!(1)\n}\n",
  "app/Cargo.toml": "[package]\nname = \"app\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[dependencies]\ncore_lib = { path = \"../core\" }\n",
  "app/src/main.rs": "mod only_macro;\nmod use_macro;\nfn main() {\n    only_macro::run();\n    use_macro::run();\n}\n",
  "app/src/only_macro.rs": "pub fn run() {\n    let _ = core_lib::cents!(3);\n}\n",
  "app/src/use_macro.rs": "use core_lib::cents;\n\npub fn run() {\n    let _ = cents!(3);\n}\n",
};

describe("a Rust macro another file defines (#383)", () => {
  const RIGHT: Array<[string, string, string]> = [
    ["core/src/user.rs", "core/src/macros.rs", "needs"],
    ["app/src/only_macro.rs", "core/src/macros.rs", "needs"],
    ["app/src/use_macro.rs", "core/src/macros.rs", "needs"],
  ];

  it("is withheld, not red, with no compiler", async () => {
    repo = scratchRepo(RUST);
    const { each } = await verdicts(repo, RIGHT, { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([[], [], []]);
  }, 60_000);

  it("keeps quiet on what the macro's body names, with no compiler", async () => {
    repo = scratchRepo(RUST);
    const { each } = await verdicts(repo, [
      ["core/src/user.rs", "core/src/util.rs", "depends"],
      ["core/src/macros.rs", "core/src/util.rs", "needs"],
    ], { compiler: false });
    expect(each.map((one) => one.reds)).toEqual([[], []]);
  }, 60_000);

  it("still calls wrong a file whose imports are all written, with no compiler", async () => {
    repo = scratchRepo(RUST);
    expect(await redsOf(repo, ["core/src/plain.rs", "core/src/util.rs", "needs"], { compiler: false })).toEqual(["needs-absent"]);
  }, 60_000);

  it.skipIf(!hasRustAnalyzer)("is withdrawn when rust-analyzer says where the macro is", async () => {
    repo = scratchRepo(RUST);
    const { each } = await verdicts(repo, RIGHT);
    expect(each).toEqual(RIGHT.map(() => ({ reds: [], unconfirmed: "compiler-says-it-does" })));
  }, 240_000);
});
