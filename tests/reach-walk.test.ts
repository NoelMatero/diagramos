/**
 * The backward reach walk (#58): every routine that could possibly reach a door.
 *
 * A routine left out of that set is a routine the walk would say "never reaches
 * this", so every test here that asserts membership is a false accusation that
 * must not happen. One test per shape a constructor is run by, per language,
 * because each is a call that names a class and never the method that runs --
 * the shape httpx's recorded test run caught: `_init_transport` returns
 * `HTTPTransport(..)`, and only `HTTPTransport.__init__` opens the SSL context.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { couldReach, readRepo, type Walk } from "../scripts/lib/reach";
import { initEngine } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function repoOf(files: Record<string, string>): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "reach-walk-")));
  made.push(dir);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), source);
  }
  return dir;
}

/** The set for one door, failing loudly if the fixture's door is not a door. */
function reaching(dir: string, doorId: string, walk: Walk = "mentions"): Set<string> {
  const read = readRepo(dir);
  const door = read.routines.get(doorId);
  expect(door?.door, `${doorId} should be a door`).toBeDefined();
  return couldReach(door!, read, walk).set;
}

describe("Python constructors", () => {
  it("counts building an object as reaching what its __init__ reaches", () => {
    const dir = repoOf({
      "store.py": [
        "class Store:",
        "    def __init__(self, path):",
        "        self.handle = open(path)",
      ].join("\n"),
      "app.py": [
        "from store import Store",
        "",
        "def make_store(path):",
        "    return Store(path)",
        "",
        "def unrelated():",
        "    return 1",
      ].join("\n"),
    });
    const set = reaching(dir, "store.py#__init__");
    expect(set.has("app.py#make_store")).toBe(true);
    // The control: a fix that let everything in would pass the line above.
    expect(set.has("app.py#unrelated")).toBe(false);
  });

  it("counts building a subclass that inherits the constructor", () => {
    const dir = repoOf({
      "base.py": [
        "class Base:",
        "    def __init__(self, path):",
        "        self.handle = open(path)",
      ].join("\n"),
      "child.py": [
        "from base import Base",
        "",
        "class Child(Base):",
        "    def describe(self):",
        "        return 'child'",
      ].join("\n"),
      "app.py": [
        "from child import Child",
        "",
        "def make_child(path):",
        "    return Child(path)",
      ].join("\n"),
    });
    expect(reaching(dir, "base.py#__init__").has("app.py#make_child")).toBe(true);
  });

  it("counts __new__ and a dataclass's __post_init__ as constructors too", () => {
    const dir = repoOf({
      "records.py": [
        "from dataclasses import dataclass",
        "",
        "class Cached:",
        "    def __new__(cls, path):",
        "        open(path)",
        "        return super().__new__(cls)",
        "",
        "@dataclass",
        "class Loaded:",
        "    path: str",
        "    def __post_init__(self):",
        "        self.handle = open(self.path)",
      ].join("\n"),
      "app.py": [
        "from records import Cached, Loaded",
        "",
        "def cached(path):",
        "    return Cached(path)",
        "",
        "def loaded(path):",
        "    return Loaded(path)",
      ].join("\n"),
    });
    expect(reaching(dir, "records.py#__new__").has("app.py#cached")).toBe(true);
    expect(reaching(dir, "records.py#__post_init__").has("app.py#loaded")).toBe(true);
  });
});

describe("TypeScript constructors", () => {
  it("counts `new` as reaching what the constructor reaches", () => {
    const dir = repoOf({
      "store.ts": [
        'import * as fs from "node:fs";',
        "export class Store {",
        "  constructor(path: string) {",
        "    fs.readFileSync(path);",
        "  }",
        "}",
      ].join("\n"),
      "app.ts": [
        'import { Store } from "./store";',
        "export function makeStore(path: string) {",
        "  return new Store(path);",
        "}",
        "export function unrelated() {",
        "  return 1;",
        "}",
      ].join("\n"),
    });
    const set = reaching(dir, "store.ts#constructor");
    expect(set.has("app.ts#makeStore")).toBe(true);
    expect(set.has("app.ts#unrelated")).toBe(false);
  });

  it("counts `new` on a subclass that inherits the constructor", () => {
    const dir = repoOf({
      "base.ts": [
        'import * as fs from "node:fs";',
        "export class Base {",
        "  constructor(path: string) {",
        "    fs.readFileSync(path);",
        "  }",
        "}",
      ].join("\n"),
      "child.ts": [
        'import { Base } from "./base";',
        "export class Child extends Base {",
        "  describe() { return 'child'; }",
        "}",
      ].join("\n"),
      "app.ts": [
        'import { Child } from "./child";',
        "export function makeChild(path: string) {",
        "  return new Child(path);",
        "}",
      ].join("\n"),
    });
    expect(reaching(dir, "base.ts#constructor").has("app.ts#makeChild")).toBe(true);
  });
});
