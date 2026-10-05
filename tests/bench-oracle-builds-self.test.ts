/**
 * The answer key's "makes" for a class pointed at itself.
 *
 * A class box is read whole, so the class's own declaration is inside what is
 * searched. Its name there is a declaration, not a use: `class
 * Blueprint(Scaffold):` reads as a call `Blueprint(...)`, which keyed every
 * Python class as making itself (flask's `Blueprint -> Blueprint` and `App ->
 * App`), and `class Widget extends Base` left every TypeScript class a doubt.
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
    root = mkdtempSync(path.join(os.tmpdir(), "builds-self-"));
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
  return (from: string, to: string) => oracle!.judge({ word: "builds", from, to });
}

describe("Python: a class pointed at itself", () => {
  const judge = oracleOver("python", {
    "scaffold.py": "class Scaffold:\n    def route(self):\n        return 1\n",
    "blueprints.py": [
      "from scaffold import Scaffold",
      "",
      "",
      "class Blueprint(Scaffold):",
      "    def __init__(self, name: str):",
      "        self.name = name",
      "",
      "    def register(self, other: \"Blueprint\") -> None:",
      "        self.route()",
      "",
      "",
      "class Node:",
      "    def clone(self):",
      "        return Node()",
      "",
    ].join("\n"),
  });

  it("is false when nothing in it makes one, though its header is written like a call", async () => {
    expect((await judge("blueprints.py#Blueprint", "blueprints.py#Blueprint")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is still true when a method makes one", async () => {
    expect(await judge("blueprints.py#Node", "blueprints.py#Node"))
      .toEqual({ truth: "true", why: "the body constructs one here" });
  }, LIVE_TIMEOUT_MS);
});

describe("TypeScript: a class pointed at itself", () => {
  const judge = oracleOver("ts", {
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext" } }),
    "widget.ts": [
      "export class Base { go(): number { return 1; } }",
      "export class Widget extends Base { size(): number { return this.go(); } }",
      "export class Node { clone(): Node { return new Node(); } }",
      "",
    ].join("\n"),
  });

  it("is false when nothing in it makes one, rather than a doubt over its own header", async () => {
    expect((await judge("widget.ts#Widget", "widget.ts#Widget")).truth).toBe("false");
  }, LIVE_TIMEOUT_MS);

  it("is still true when a method makes one", async () => {
    expect((await judge("widget.ts#Node", "widget.ts#Node")).truth).toBe("true");
  }, LIVE_TIMEOUT_MS);
});
