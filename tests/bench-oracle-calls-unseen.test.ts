/**
 * #428: three calls the answer key's call hierarchy never lists, so it keyed
 * real calls as "none of its calls is it".
 *
 * - A local that holds something that runs, called by name: flask's
 *   `wsgi_app` ends with `return response(environ, start_response)`.
 * - A constructor, run by creating its class: vite's `ssrLoadModule` writes
 *   `new SSRCompatModuleRunner(environment)`.
 * - A routine read out of a table and called: vue's `buildProps` does
 *   `const directiveTransform = context.directiveTransforms[name]` and calls
 *   it, and `compile.ts` fills that table with `bind: transformBind`. That one
 *   is a doubt, not a call, and only when non-test code stores the routine as
 *   a value. A callback parameter called is not a table.
 *
 * Asked of the real tools.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createOracle, type Oracle } from "../scripts/lib/bench-oracle";
import { createTooling, type Language } from "../scripts/lib/bench-tooling";

/** A language server's round trip under a loaded suite; see resolution-rust-lsp.test.ts. */
const LIVE_TIMEOUT_MS = 60_000;

function oracleOver(language: Language, files: Record<string, string>) {
  let root = "";
  let oracle: Oracle | undefined;
  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), "calls-unseen-"));
    for (const [relative, text] of Object.entries(files)) {
      const full = path.join(root, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    }
    oracle = createOracle(await createTooling(language, root));
  }, LIVE_TIMEOUT_MS);
  afterAll(() => {
    oracle?.close();
    if (root) rmSync(root, { recursive: true, force: true });
  });
  return (from: string, to: string) => oracle!.judge({ word: "calls", from, to });
}

describe("Python: a local that holds something that runs", () => {
  const judge = oracleOver("python", {
    "app.py": [
      "def make():",
      "    return print",
      "",
      "",
      "def handle(environ):",
      "    response = make()",
      "    return response(environ)",
      "",
      "",
      "def finish():",
      "    response = make()",
      "    return response",
      "",
    ].join("\n"),
  });

  it("is called when the body calls it, and the ref means the routine's own", async () => {
    expect(await judge("app.py#handle", "app.py#response"))
      .toEqual({ truth: "true", why: "the value is called here and resolves to it" });
  }, LIVE_TIMEOUT_MS);

  it("is still a kind mistake when the body only returns it", async () => {
    expect((await judge("app.py#finish", "app.py#response")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);
});

describe("TypeScript: a constructor and a table", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
    "runner.ts": [
      "export class Runner {",
      "  constructor(private name: string) {}",
      "  run(): string { return this.name; }",
      "}",
      "export function load(): Runner { return new Runner('a'); }",
      "export function idle(): number { return 1; }",
      "",
    ].join("\n"),
    "transforms.ts": [
      "export function bind(x: number): number { return x + 1; }",
      "export function model(x: number): number { return x * 2; }",
      "export function never(x: number): number { return x; }",
      "",
    ].join("\n"),
    "compile.ts": [
      "import { bind, model, never } from './transforms';",
      "export const table: Record<string, (x: number) => number> = { bind, model: model };",
      "export const list: Array<(x: number) => number> = [never];",
      "",
    ].join("\n"),
    "element.ts": [
      "import { table } from './compile';",
      "export function build(name: string): number {",
      "  const transform = table[name];",
      "  return transform ? transform(1) : 0;",
      "}",
      "export function plain(): number { return Math.abs(1); }",
      "export function each(cb: (x: number) => number): number { return cb(1); }",
      "",
    ].join("\n"),
  });

  it("calls a constructor when it creates the class", async () => {
    expect(await judge("runner.ts#load", "runner.ts#constructor"))
      .toEqual({ truth: "true", why: "it creates Runner, which runs this constructor" });
  }, LIVE_TIMEOUT_MS);

  it("does not call a constructor when it creates nothing", async () => {
    expect((await judge("runner.ts#idle", "runner.ts#constructor")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is a doubt when a call goes through a value and the routine is stored in one", async () => {
    const answer = await judge("element.ts#build", "transforms.ts#model");
    expect(answer.truth).toBe("undecidable");
    expect(answer.why).toBe("a call of transform, read out of a table is here, and model is stored as a value at compile.ts:2");
  }, LIVE_TIMEOUT_MS);

  it("is a doubt for a shorthand entry too", async () => {
    expect((await judge("element.ts#build", "transforms.ts#bind")).truth).toBe("undecidable");
  }, LIVE_TIMEOUT_MS);

  it("is still false for a routine stored only in a list, not under a key", async () => {
    expect((await judge("element.ts#build", "transforms.ts#never")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is still false when nothing is called through a value", async () => {
    expect((await judge("element.ts#plain", "transforms.ts#model")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is still false when the value called is a callback parameter, not a table", async () => {
    expect((await judge("element.ts#each", "transforms.ts#model")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);
});
