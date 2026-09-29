/**
 * The four questions a red is put to before it is shown (#393), asked of the
 * TypeScript compiler. One case per shape #373 found red on correct code,
 * each with the answer that would have kept it quiet, and a control per
 * question whose honest answer is "no".
 *
 * Nothing here checks a board: #393's first part adds the questions and
 * changes no verdict, so what is tested is what the compiler says.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { partsInclude, type DeclaredAt, type TypeParts } from "../src/engine/compiler-questions";
import type { ClosedBodyReferee } from "../src/engine/drift";
import { createClosedBodyReferee } from "../src/engine/referee";

let repo: string;
let referee: ClosedBodyReferee;
const sources = new Map<string, string>();

function write(relative: string, contents: string): void {
  const full = path.join(repo, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  sources.set(relative, contents);
}

/** The range of the `nth` (0-based) occurrence of `needle` in a file, where `mark` narrows it to a part. */
function at(file: string, needle: string, mark = needle, nth = 0): { start: number; end: number } {
  const text = sources.get(file)!;
  let from = -1;
  for (let i = 0; i <= nth; i += 1) {
    from = text.indexOf(needle, from + 1);
    if (from < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not in ${file}`);
  }
  const start = from + needle.indexOf(mark);
  return { start, end: start + mark.length };
}

/** The 1-based line a declaration's name sits on. */
function line(file: string, needle: string): number {
  const text = sources.get(file)!;
  return text.slice(0, text.indexOf(needle)).split("\n").length;
}

const PARTS = "src/parts.ts";
const place = (needle: string, name: string): { name: string; at: DeclaredAt } =>
  ({ name, at: { file: PARTS, line: line(PARTS, needle) } });

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), "compiler-questions-ts-"));
  write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "es2022", module: "esnext", moduleResolution: "bundler" } }));
  write(PARTS, [
    "export class Engine {}",
    "export class Wheel {}",
    "export interface Seat { sit(): void }",
    "export interface Named { name(): string }",
    "export type Door = { open: boolean };",
    "export enum Color { Red, Blue }",
    "export interface ButtonProps { label: string }",
    "export type FC<P> = (props: P) => unknown;",
    "export interface Box<T> { value: T }",
    "export class Money {",
    "  constructor(private cents: number) {}",
    "  toString(): string { return String(this.cents); }",
    "  valueOf(): number { return this.cents; }",
    "}",
    "export class Deck {",
    "  *[Symbol.iterator](): Iterator<number> { yield 1; }",
    "}",
    "export class Later {",
    "  then(done: (value: number) => void): void { done(1); }",
    "}",
    "",
  ].join("\n"));
  write("src/car.ts", [
    'import { Engine, Wheel, Seat, Door, Color, Named } from "./parts";',
    "export class Inferred {",
    "  engine = new Engine();",
    "}",
    "export class Untyped {",
    "  engine;",
    "  constructor() {",
    "    this.engine = new Engine();",
    "  }",
    "}",
    "export class Shapes {",
    "  byId: Map<string, Wheel> = new Map();",
    "  seat: Seat | null = null;",
    "  door: Readonly<Door> = { open: false };",
    "  color: Color = Color.Red;",
    "  make: () => Engine = () => new Engine();",
    "  count = 0;",
    "}",
    "export function run<N extends Named>(n: N): string { return n.name(); }",
    "export function any<T>(t: T): T { return t; }",
    "export function fallback(e = new Engine()): Engine { return e; }",
    "export class Dog { name(): string { return 'd'; } }",
    "export class Rock { weight = 1; }",
    "export class Never {",
    "  spare;",
    "}",
    "",
  ].join("\n"));
  write("src/button.ts", [
    'import type { ButtonProps, FC } from "./parts";',
    "export const Button: FC<ButtonProps> = (props) => props.label;",
    "",
  ].join("\n"));
  write("src/implicit.ts", [
    'import { Money, Deck, Later } from "./parts";',
    "export function show(m: Money): string { return `${m}`; }",
    "export function plus(m: Money): number { return +m; }",
    "export function each(d: Deck): number { let n = 0; for (const x of d) n += x; return n; }",
    "export async function wait(l: Later): Promise<number> { return await l; }",
    "export function plain(o: { a: number }): string { return `${o}`; }",
    "export function maybe(m: Money | null): string { return `${m}`; }",
    "",
  ].join("\n"));
  write("src/cjs.ts", 'import util = require("./util");\nexport const x = util.one;\n');
  write("src/util.ts", "export const one = 1;\n");
  write("src/lib-user.ts", 'import { thing } from "outside-lib";\nexport const y = thing;\n');
  write("node_modules/outside-lib/package.json", JSON.stringify({ name: "outside-lib", types: "index.d.ts" }));
  write("node_modules/outside-lib/index.d.ts", "export declare const thing: number;\n");
  // A workspace package, linked into node_modules the way npm install does it (#390).
  write("packages/core/package.json", JSON.stringify({ name: "@acme/core", exports: { ".": "./src/index.ts", "./money": "./src/money.ts" } }));
  write("packages/core/src/index.ts", "export function double(x: number): number { return x * 2; }\n");
  write("packages/core/src/money.ts", "export class Coin {}\n");
  mkdirSync(path.join(repo, "node_modules/@acme"), { recursive: true });
  symlinkSync(path.join(repo, "packages/core"), path.join(repo, "node_modules/@acme/core"));
  write("src/app.ts", 'import { double } from "@acme/core";\nimport { Coin } from "@acme/core/money";\nexport const z = double(1) + (new Coin() ? 1 : 0);\n');
  const built = createClosedBodyReferee(repo);
  if (!built) throw new Error("no TypeScript referee");
  referee = built;
});

afterAll(() => rmSync(repo, { recursive: true, force: true }));

const CAR = "src/car.ts";
const partsAt = (file: string, needle: string, mark?: string): TypeParts | undefined =>
  referee.typePartsAt!(file, at(file, needle, mark));

describe("typePartsAt: what a type is made of, where the text does not say", () => {
  it("names the class a field's initializer creates (#378: engine = new Engine())", () => {
    expect(partsInclude(partsAt(CAR, "engine = new Engine()", "engine"), place("class Engine", "Engine"))).toBe(true);
  });

  it("names the props type a component is assigned to (#381: FC<ButtonProps>)", () => {
    expect(partsInclude(partsAt("src/button.ts", "(props)", "props"), place("interface ButtonProps", "ButtonProps"))).toBe(true);
  });

  it("names a type parameter's bound (#380: <N extends Named>)", () => {
    expect(partsInclude(partsAt(CAR, "(n: N)", "n"), place("interface Named", "Named"))).toBe(true);
  });

  it("names the class a constructor assigns to a field with no written type (#378: `engine;`)", () => {
    expect(partsInclude(partsAt(CAR, "  engine;", "engine"), place("class Engine", "Engine"))).toBe(true);
  });

  it("names the type a default value gives an unannotated parameter", () => {
    expect(partsInclude(partsAt(CAR, "(e = new Engine())", "e"), place("class Engine", "Engine"))).toBe(true);
  });

  it.each([
    ["a Map's value", "byId: Map", "byId", "class Wheel", "Wheel"],
    ["a union with null", "seat: Seat", "seat", "interface Seat", "Seat"],
    ["an alias's argument", "door: Readonly", "door", "type Door", "Door"],
    ["an enum", "color: Color", "color", "enum Color", "Color"],
    ["a function's return", "make: () =>", "make", "class Engine", "Engine"],
  ])("sees through %s", (_shape, needle, mark, declaration, name) => {
    expect(partsInclude(partsAt(CAR, needle, mark), place(declaration, name))).toBe(true);
  });

  it("places a library's type outside the repository, and never matches it", () => {
    const parts = partsAt(CAR, "byId: Map", "byId")!;
    expect(parts.parts.find((one) => one.name === "Map")?.at).toBe("outside");
  });

  it("says no only when it saw the whole type: `count = 0` is a number and nothing else", () => {
    expect(partsInclude(partsAt(CAR, "count = 0", "count"), place("class Engine", "Engine"))).toBe(false);
  });

  it("cannot say, rather than says no, for a field nothing types or assigns", () => {
    expect(partsInclude(partsAt(CAR, "  spare;", "spare"), place("class Engine", "Engine"))).toBeUndefined();
  });

  it("cannot say for a type parameter with no bound", () => {
    expect(partsInclude(partsAt(CAR, "(t: T)", "t"), place("class Engine", "Engine"))).toBeUndefined();
  });
});

describe("fitsAt: whether a class fits an interface nobody wrote `implements` for (#379)", () => {
  it("says yes for a class with the interface's members", () => {
    expect(referee.fitsAt!(CAR, at(CAR, "class Dog", "Dog"), place("interface Named", "Named").at)).toBe(true);
  });

  it("says no for a class without them", () => {
    expect(referee.fitsAt!(CAR, at(CAR, "class Rock", "Rock"), place("interface Named", "Named").at)).toBe(false);
  });

  it("cannot say for a generic interface, whose answer depends on its arguments", () => {
    expect(referee.fitsAt!(CAR, at(CAR, "class Dog", "Dog"), place("interface Box", "Box").at)).toBeUndefined();
  });
});

describe("importTargetAt: where an import resolves", () => {
  it("follows `import x = require()` (#386)", () => {
    expect(referee.importTargetAt!("src/cjs.ts", at("src/cjs.ts", '"./util"'))).toEqual({ file: "src/util.ts" });
  });

  it("follows a workspace package by name to its home in the tree (#390)", () => {
    expect(referee.importTargetAt!("src/app.ts", at("src/app.ts", '"@acme/core"'))).toEqual({ file: "packages/core/src/index.ts" });
  });

  it("follows a workspace package's subpath export (#390)", () => {
    expect(referee.importTargetAt!("src/app.ts", at("src/app.ts", '"@acme/core/money"'))).toEqual({ file: "packages/core/src/money.ts" });
  });

  it("places a library outside the repository", () => {
    expect(referee.importTargetAt!("src/lib-user.ts", at("src/lib-user.ts", '"outside-lib"'))).toBe("outside");
  });
});

describe("memberAt: which routine an operator or a language rule runs (#384)", () => {
  const IMPLICIT = "src/implicit.ts";
  const member = (name: string) => ({ file: PARTS, line: line(PARTS, `${name}(`) });

  it.each([
    ["a template string runs toString", "`${m}`; }", "m", "toString", "toString"],
    ["unary + runs valueOf", "+m;", "m", "valueOf", "valueOf"],
    ["for..of runs the iterator", "of d)", "d", "[Symbol.iterator]", "*[Symbol.iterator]"],
    ["await runs then", "await l", "l", "then", "then"],
  ])("%s", (_shape, needle, mark, name, declared) => {
    const found = referee.memberAt!(IMPLICIT, at(IMPLICIT, needle, mark), name);
    expect(found).toContainEqual({ file: PARTS, line: line(PARTS, declared === "*[Symbol.iterator]" ? "*[Symbol.iterator]" : `${declared}(`) });
  });

  it("skips the null half of a union", () => {
    expect(referee.memberAt!(IMPLICIT, at(IMPLICIT, "`${m}`; }", "m", 1), "toString")).toEqual([member("toString")]);
  });

  it("places Object's own toString outside the repository", () => {
    expect(referee.memberAt!(IMPLICIT, at(IMPLICIT, "`${o}`", "o"), "toString")).toEqual(["outside"]);
  });
});

describe("importTargetAt under Node's own module rules (#386)", () => {
  let node: string;
  let asked: ClosedBodyReferee;
  const files: Record<string, string> = {
    "package.json": '{ "name": "probe" }\n',
    "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", target: "es2022", noEmit: true, allowJs: true } }),
    "lib/legacy.cts": "function legacy(): number { return 1; }\nexport = legacy;\n",
    "lib/plain.ts": "export function plain(): number { return 1; }\n",
    "lib/old.js": "function old() { return 1; }\nmodule.exports = { old };\n",
    "h1.cts": 'import legacy = require("./lib/legacy.cjs");\nexport const r = legacy();\n',
    "h4.ts": 'import plainMod = require("./lib/plain");\nexport const r = plainMod.plain();\n',
    "h5.js": 'const { old } = require("./lib/old");\nmodule.exports = { r: old };\n',
  };

  beforeAll(() => {
    node = mkdtempSync(path.join(os.tmpdir(), "compiler-questions-node-"));
    for (const [relative, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(node, relative)), { recursive: true });
      writeFileSync(path.join(node, relative), contents);
    }
    const built = createClosedBodyReferee(node);
    if (!built) throw new Error("no TypeScript referee");
    asked = built;
  });

  afterAll(() => rmSync(node, { recursive: true, force: true }));

  const specifier = (file: string, written: string) => {
    const start = files[file]!.indexOf(written);
    return { start, end: start + written.length };
  };

  it.each([
    ["a .cjs specifier to the .cts on disk", "h1.cts", '"./lib/legacy.cjs"', "lib/legacy.cts"],
    ["an extensionless require in a .ts file", "h4.ts", '"./lib/plain"', "lib/plain.ts"],
    ["a plain require() in JavaScript", "h5.js", '"./lib/old"', "lib/old.js"],
  ])("follows %s", (_shape, file, written, target) => {
    expect(asked.importTargetAt!(file, specifier(file, written))).toEqual({ file: target });
  });
});
