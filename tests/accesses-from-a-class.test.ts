/**
 * "Renderer reads config.width" where Renderer is a class (#374): true when
 * one of Renderer's methods reads it -- #352's rule for `@calls`, applied to
 * `@accesses`. The checker confirms it, and, as for any tail, never calls the
 * arrow wrong for a read it did not see: only the far type lacking the member
 * is red.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

function over(files: Record<string, string>) {
  let repo = "";
  beforeAll(() => {
    repo = mkdtempSync(path.join(tmpdir(), "accesses-from-a-class-"));
    for (const [relative, contents] of Object.entries(files)) {
      const full = path.join(repo, relative);
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
  });
  afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }); });
  return async (from: string, to: string, member: string) => {
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [{ id: "tail", label: "tail", ref: from }, { id: "head", label: "head", ref: to }],
      edges: [{ from: "tail", to: "head", claim: "accesses", label: member }],
    });
    const report = checkDrift(board as BoardFile, createWorkspace(repo), { edges: true });
    if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return "red";
    return report.claims.accessesConfirmed > 0 ? "green" : "quiet";
  };
}

describe("TypeScript", () => {
  const ask = over({
    "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true } }\n",
    "config.ts": "export class Config { width = 1; height = 2; }\n",
    "render.ts": [
      'import { Config } from "./config";',
      "export class Renderer {",
      "  constructor(private config: Config) {}",
      "  draw(): number { return this.config.width; }",
      "}",
      "export class Idle {",
      "  constructor(private config: Config) {}",
      "  draw(): number { return this.config.height; }",
      "}",
      "",
    ].join("\n"),
  });

  it("confirms a class one of whose methods reads the member", async () => {
    expect(await ask("render.ts#Renderer", "config.ts#Config", "width")).toBe("green");
  });

  it("does not accuse a class none of whose methods reads it", async () => {
    expect(await ask("render.ts#Idle", "config.ts#Config", "width")).not.toBe("red");
  });

  it("still calls wrong a member the far type does not declare", async () => {
    expect(await ask("render.ts#Renderer", "config.ts#Config", "depth")).toBe("red");
  });
});

describe("Python", () => {
  const ask = over({
    "config.py": "class Config:\n    width: int = 1\n    height: int = 2\n",
    "render.py": [
      "from config import Config",
      "",
      "",
      "class Renderer:",
      "    def __init__(self, config: Config) -> None:",
      "        self.config: Config = config",
      "",
      "    def draw(self) -> int:",
      "        return self.config.width",
      "",
    ].join("\n"),
  });

  it("confirms a class one of whose methods reads the member", async () => {
    expect(await ask("render.py#Renderer", "config.py#Config", "width")).toBe("green");
  });
});

describe("Rust", () => {
  const ask = over({
    "Cargo.toml": '[package]\nname = "reads"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/lib.rs": "pub mod config;\npub mod render;\n",
    "src/config.rs": "pub struct Config {\n    pub width: u32,\n    pub height: u32,\n}\n",
    "src/render.rs": [
      "use crate::config::Config;",
      "pub struct Renderer {\n    pub config: Config,\n}",
      "impl Renderer {\n    pub fn draw(&self) -> u32 {\n        self.config.width\n    }\n}",
      "",
    ].join("\n\n"),
  });

  it("confirms a struct one of whose methods reads the member", async () => {
    expect(await ask("src/render.rs#Renderer", "src/config.rs#Config", "width")).toBe("green");
  });
});
