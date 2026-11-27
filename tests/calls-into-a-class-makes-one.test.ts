/**
 * "`load` calls `Parser`", where Parser is a class, an interface or a trait,
 * is wrong when `load` neither makes one nor calls anything it declares.
 * These are the "makes one?" half (class-calls research 2026-11, step 2):
 *
 *   - naming a class as a type makes nothing: what a routine says it
 *     returns, and the type a local is declared with, are no more a
 *     construction than a parameter's type is (#432) -- unless the routine
 *     uses that value in a way that runs the class's own code with no call
 *     written (loops over it, adds it), and the class has such code;
 *   - a TypeScript interface is made by writing an object with every member
 *     it requires: a body that writes no such object (and spreads none, and
 *     makes no class that could be one) makes none;
 *   - nothing makes a Rust trait: it is only ever called through the
 *     methods it declares.
 *
 * Every arrow here has its calls placed without a compiler, so the "makes
 * one?" half is the only thing that decides it. Each wrong arrow has a
 * correct twin that must not go red.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { dropRepo, hasRustAnalyzer, scratchRepo, verdicts } from "./helpers/arrow-probe";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();
beforeAll(async () => { await initEngine(); }, 60_000);

let repo: string | undefined;
afterEach(() => { if (repo) dropRepo(repo); repo = undefined; });

type Case = { name: string; want: "red" | "not-red"; from: string; to: string; files: Record<string, string> };

/** One repository per case, every case's verdict in order. */
async function run(cases: Case[], compiler: boolean): Promise<string[]> {
  const out: string[] = [];
  for (const one of cases) {
    repo = scratchRepo(one.files);
    const { each } = await verdicts(repo, [[one.from, one.to, "calls"]], { compiler });
    out.push(`${one.name} => ${each[0]!.reds.length > 0 ? "red" : "not-red"}`);
    dropRepo(repo);
    repo = undefined;
  }
  return out;
}
const wanted = (cases: Case[]) => cases.map((one) => `${one.name} => ${one.want}`);

const PY_WIDGET = "class Widget:\n    def run(self):\n        return 1\n";
const PY_ITER = "class Widget:\n    def __iter__(self):\n        return iter(())\n";
const PY_ADD = "class Widget:\n    def __add__(self, other):\n        return self\n";

const PYTHON: Case[] = [
  { name: "py wrong: the class is named only as what the routine returns", want: "red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_WIDGET,
    "pkg/a.py": "from .c import Widget\n\n\ndef f(store) -> Widget:\n    return store.current\n" } },
  { name: "py wrong: the class is named only as a local's declared type", want: "red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_WIDGET,
    "pkg/a.py": "from .c import Widget\n\n\ndef f(store):\n    w: Widget = store.current\n    return w\n" } },
  { name: "py correct: says it returns one and makes it", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_WIDGET,
    "pkg/a.py": "from .c import Widget\n\n\ndef f() -> Widget:\n    return Widget()\n" } },
  { name: "py correct: returns one it iterated, and the class declares __iter__", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_ITER,
    "pkg/a.py": "from .c import Widget\n\n\ndef f(store) -> Widget:\n    w = store.current\n    for one in w:\n        print(one)\n    return w\n" } },
  { name: "py correct: a local declared as the class is iterated, and the class declares __iter__", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_ITER,
    "pkg/a.py": "from .c import Widget\n\n\ndef f(store):\n    w: Widget = store.current\n    for one in w:\n        print(one)\n" } },
  { name: "py correct: returns a sum, and the class declares __add__", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_ADD,
    "pkg/a.py": "from .c import Widget\n\n\ndef f(a, b) -> Widget:\n    return a + b\n" } },
  { name: "py correct: says it returns one and makes it through the class's own maker", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": "class Widget:\n    @classmethod\n    def build(cls):\n        return cls()\n",
    "pkg/a.py": "from .c import Widget\n\n\ndef f() -> Widget:\n    return Widget.build()\n" } },
  { name: "py correct: the class is made through a value the local holds", want: "not-red", from: "pkg/a.py#f", to: "pkg/c.py#Widget", files: {
    "pkg/__init__.py": "", "pkg/c.py": PY_WIDGET,
    "pkg/a.py": "from typing import Type\n\nfrom .c import Widget\n\n\ndef f(kind):\n    make: Type[Widget] = kind\n    return make()\n" } },
];

const TSCFG = { "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n" };
const TS_C = "export class C {\n  run(): number { return 1; }\n}\n";
const TS_ITER = "export class C {\n  *[Symbol.iterator](): Iterator<number> { yield 1; }\n}\n";
const SHAPE = "export interface Shape {\n  area(): number;\n  name: string;\n  hint?: string;\n}\n";

const TYPESCRIPT: Case[] = [
  { name: "ts wrong: the class is named only as what the routine returns", want: "red", from: "a.ts#f", to: "c.ts#C", files: { ...TSCFG,
    "c.ts": TS_C, "a.ts": "import type { C } from \"./c\";\nexport function f(store: { current: C }): C {\n  return store.current;\n}\n" } },
  { name: "ts wrong: the class is named only as a local's declared type", want: "red", from: "a.ts#f", to: "c.ts#C", files: { ...TSCFG,
    "c.ts": TS_C, "a.ts": "import type { C } from \"./c\";\nexport function f(store: { current: C }): number {\n  const one: C = store.current;\n  return one === store.current ? 1 : 0;\n}\n" } },
  { name: "ts correct: says it returns one and makes it", want: "not-red", from: "a.ts#f", to: "c.ts#C", files: { ...TSCFG,
    "c.ts": TS_C, "a.ts": "import { C } from \"./c\";\nexport function f(): C {\n  return new C();\n}\n" } },
  { name: "ts correct: a local declared as the class is spread, and the class is iterable", want: "not-red", from: "a.ts#f", to: "c.ts#C", files: { ...TSCFG,
    "c.ts": TS_ITER, "a.ts": "import type { C } from \"./c\";\nexport function f(store: { current: C }): number[] {\n  const one: C = store.current;\n  return [...one];\n}\n" } },

  { name: "ts wrong: interface head, a literal that leaves a required member out", want: "red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "export function f(): number {\n  const o = { name: \"a\" };\n  return o.name.length;\n}\n" } },
  { name: "ts wrong: interface head, no object at all", want: "red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "export function f(n: number): number {\n  return n + 1;\n}\n" } },
  { name: "ts correct: interface head, writes a literal with every required member", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "export function f(): number {\n  const o = { name: \"a\", area: () => 1 };\n  return o.name.length;\n}\n" } },
  { name: "ts correct: interface head, a literal that spreads another", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "export function f(base: object): number {\n  const o = { ...base, name: \"a\" };\n  return o.name.length;\n}\n" } },
  { name: "ts correct: interface head, a literal completed by Object.assign", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "export function f(base: object): object {\n  return Object.assign({ name: \"a\" }, base);\n}\n" } },
  { name: "ts correct: interface head, makes a class that implements it", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE,
    "sq.ts": "import type { Shape } from \"./i\";\nexport class Square implements Shape {\n  name = \"sq\";\n  area(): number { return 1; }\n}\n",
    "a.ts": "import { Square } from \"./sq\";\nexport function f(): object {\n  return new Square();\n}\n" } },
  { name: "ts correct: interface head, makes a class that has every member without saying so", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE,
    "sq.ts": "export class Square {\n  name = \"sq\";\n  area(): number { return 1; }\n}\n",
    "a.ts": "import { Square } from \"./sq\";\nexport function f(): object {\n  return new Square();\n}\n" } },
  { name: "ts correct: interface head, makes a language class that may have every member", want: "not-red", from: "a.ts#f", to: "e.ts#Failure", files: { ...TSCFG,
    "e.ts": "export interface Failure {\n  name: string;\n  message: string;\n}\n",
    "a.ts": "export function f(): object {\n  return new Error(\"no\");\n}\n" } },
  { name: "ts correct: interface head, built piece by piece and returned as one", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": SHAPE, "a.ts": "import type { Shape } from \"./i\";\nexport function f(): Shape {\n  const o: any = { name: \"a\" };\n  o.area = () => 1;\n  return o;\n}\n" } },
  { name: "ts correct: interface with only optional members, any literal may be one", want: "not-red", from: "a.ts#f", to: "i.ts#Opts", files: { ...TSCFG,
    "i.ts": "export interface Opts {\n  depth?: number;\n}\n", "a.ts": "export function f(): object {\n  return {};\n}\n" } },
  { name: "ts correct: interface whose members every array has, an array may be one", want: "not-red", from: "a.ts#f", to: "i.ts#Sized", files: { ...TSCFG,
    "i.ts": "export interface Sized {\n  length: number;\n}\n", "a.ts": "export function f(): number[] {\n  return [1, 2];\n}\n" } },
  { name: "ts correct: interface with a call signature, a function may be one", want: "not-red", from: "a.ts#f", to: "i.ts#Handler", files: { ...TSCFG,
    "i.ts": "export interface Handler {\n  (n: number): number;\n  label: string;\n}\n", "a.ts": "export function f(): (n: number) => number {\n  return (n) => n;\n}\n" } },
  { name: "ts correct: a class merged with an interface of the same name", want: "not-red", from: "a.ts#f", to: "i.ts#Shape", files: { ...TSCFG,
    "i.ts": "export interface Shape {\n  name: string;\n}\nexport class Shape {\n  area(): number { return 1; }\n}\n",
    "a.ts": "export function f(n: number): number {\n  return n + 1;\n}\n" } },
];

const CARGO = { "Cargo.toml": "[package]\nname = \"p\"\nversion = \"0.1.0\"\nedition = \"2021\"\n\n[lib]\npath = \"src/lib.rs\"\n" };
const TRAITS = "pub trait Walks {\n    fn walk(&self) -> u32;\n}\npub trait Runs {\n    fn run(&self) -> u32;\n}\n";

const RUST: Case[] = [
  { name: "rust wrong: trait head, nothing it declares is called", want: "red", from: "src/a.rs#f", to: "src/c.rs#Walks", files: { ...CARGO,
    "src/lib.rs": "pub mod a;\npub mod c;\n", "src/c.rs": TRAITS,
    "src/a.rs": "pub fn f(n: u32) -> u32 {\n    n + 1\n}\n" } },
  { name: "rust correct: trait head, a method it declares is called through a bound", want: "not-red", from: "src/a.rs#f", to: "src/c.rs#Walks", files: { ...CARGO,
    "src/lib.rs": "pub mod a;\npub mod c;\n", "src/c.rs": TRAITS,
    "src/a.rs": "use crate::c::Walks;\npub fn f<T: Walks>(x: &T) -> u32 {\n    x.walk()\n}\n" } },
  { name: "rust correct: trait head, a method it declares is called on a struct that implements it", want: "not-red", from: "src/a.rs#f", to: "src/c.rs#Walks", files: { ...CARGO,
    "src/lib.rs": "pub mod a;\npub mod c;\npub mod w;\n", "src/c.rs": TRAITS,
    "src/w.rs": "use crate::c::Walks;\npub struct Widget;\nimpl Walks for Widget {\n    fn walk(&self) -> u32 { 1 }\n}\n",
    "src/a.rs": "use crate::c::Walks;\nuse crate::w::Widget;\npub fn f(x: &Widget) -> u32 {\n    x.walk()\n}\n" } },
  { name: "rust correct: trait head, called through a trait object", want: "not-red", from: "src/a.rs#f", to: "src/c.rs#Walks", files: { ...CARGO,
    "src/lib.rs": "pub mod a;\npub mod c;\n", "src/c.rs": TRAITS,
    "src/a.rs": "use crate::c::Walks;\npub fn f(x: &dyn Walks) -> u32 {\n    x.walk()\n}\n" } },
];

describe("the \"makes one?\" half, with no compiler", () => {
  it("Python: a return type and a local's type make nothing", async () => {
    expect(await run(PYTHON, false)).toEqual(wanted(PYTHON));
  }, 120_000);
  it("TypeScript: types make nothing; an interface is made by an object with every member it requires", async () => {
    expect(await run(TYPESCRIPT, false)).toEqual(wanted(TYPESCRIPT));
  }, 120_000);
  it("Rust: nothing makes a trait (correct arrows only: a red here waits on the compiler)", async () => {
    const correct = RUST.filter((one) => one.want === "not-red");
    expect(await run(correct, false)).toEqual(wanted(correct));
  }, 120_000);
});

describe("the same with the compilers", () => {
  it("Python", async () => {
    expect(await run(PYTHON, true)).toEqual(wanted(PYTHON));
  }, 300_000);
  it("TypeScript", async () => {
    expect(await run(TYPESCRIPT, true)).toEqual(wanted(TYPESCRIPT));
  }, 300_000);
  it.skipIf(!hasRustAnalyzer)("Rust", async () => {
    expect(await run(RUST, true)).toEqual(wanted(RUST));
  }, 600_000);
});
