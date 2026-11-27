/**
 * "Could this call be one of the class's?" -- a `calls` arrow with a class at
 * one end (class-calls research 2026-11, step 1).
 *
 * "`load` calls `Parser`", where Parser is a class, is wrong when `load`
 * neither makes a Parser nor calls anything Parser declares. A wrong arrow
 * like that was caught 54% of the time against 81% for two plain functions:
 * the checker gave up on any call it could not place, although Parser has no
 * method of that name. The rules here, each a fact about the language:
 *
 *   1  a call by a name the class (and every base this repository writes)
 *      does not declare is not one of the class's
 *   2  a call a compiler placed on a method belongs to the class that method
 *      is written in, where two classes of one file share the name
 *   6  a class at the near end is judged through its own code; a Rust trait
 *      through its default methods
 *
 * and the refusals that keep a correct arrow from going red: a member the
 * text does not spell (`__getattr__`, `setattr`, a computed key, a macro in
 * an `impl`), the class or one of its methods kept under another name, a
 * library method the class replaces, a method using its own object (`with
 * self:` runs `__enter__`; rich's `Console.control -> Console` was red so).
 *
 * The cases are the research's small cases (`~/bench-class-calls/fixtures`),
 * one per shape and language. Every correct arrow must stay not red with no
 * compiler; a subset is checked again with the compilers on. The wrong
 * arrows that need rules 3-5 ("does it make one") are not here.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { wouldHelp } from "../src/engine/referee";
import { refereedCheckLive } from "../src/engine/referee-live";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const hasRustAnalyzer = (() => {
  try { execFileSync("rust-analyzer", ["--version"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);
type Want = "not-red" | "red" | "red with a compiler";
type Case = { name: string; files: Record<string, string>; from: string; to: string; want: Want };
const cases: Case[] = [];
const add = (name: string, want: Want, from: string, to: string, files: Record<string, string>) => cases.push({ name, files, from, to, want });

/* ---------------- TypeScript ---------------- */
const TSCFG = { "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler" }, include: ["src"] }) };
add("ts wrong: untyped call by a name the class does not declare", "red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: untyped call by a name the class declares", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.run();\n}\n" });
add("ts correct: the name is declared by a base in the same file", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class Base {\n  walk(): number { return 1; }\n}\nexport class C extends Base {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: the name is declared by a base in another file", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/base.ts": "export class Base {\n  walk(): number { return 1; }\n}\n",
  "src/c.ts": "import { Base } from './base';\nexport class C extends Base {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a method of the class is kept under another name", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\nexport const table = { walk: C.prototype.run };\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: the class is kept under another name and made through it", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\nexport const kinds = { widget: C };\n",
  "src/a.ts": "export function f(x: any): unknown {\n  return new x.widget();\n}\n" });
add("ts correct: a factory kept under another name makes one", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\nexport const kinds = { widget: () => new C() };\n",
  "src/a.ts": "export function f(x: any): unknown {\n  return x.widget();\n}\n" });
add("ts correct: a field of the class holds a function and is called", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  onDone: () => void = () => {};\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.onDone();\n}\n" });
add("ts correct: a member set in the constructor is called", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  constructor(cb: () => void) { (this as any).later = cb; }\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.later();\n}\n" });
add("ts correct: interface head, calls a member it declares", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Shape {\n  area(): number;\n  name: string;\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.area();\n}\n" });
add("ts correct: interface head, a member declared by an interface it extends", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Base {\n  walk(): void;\n}\nexport interface Shape extends Base {\n  area(): number;\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: interface head, writes a literal with every required member", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Shape {\n  area(): number;\n  name: string;\n  hint?: string;\n}\n",
  "src/a.ts": "export function f(use: (s: unknown) => void): void {\n  use({ name: 'a', area: () => 1 });\n}\n" });
add("ts correct: interface head, a literal that spreads another", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Shape {\n  area(): number;\n  name: string;\n}\n",
  "src/a.ts": "export function f(base: object, use: (s: unknown) => void): void {\n  use({ ...base, name: 'a' });\n}\n" });
add("ts correct: interface head, makes a class that implements it", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Shape {\n  area(): number;\n  name: string;\n}\n",
  "src/sq.ts": "import type { Shape } from './i';\nexport class Square implements Shape {\n  name = 'sq';\n  area(): number { return 1; }\n}\n",
  "src/a.ts": "import { Square } from './sq';\nexport function f(): unknown {\n  return new Square();\n}\n" });
add("ts correct: interface with only optional members, any literal may be one", "not-red", "src/a.ts#f", "src/i.ts#Opts", { ...TSCFG,
  "src/i.ts": "export interface Opts {\n  depth?: number;\n}\n",
  "src/a.ts": "export function f(use: (s: unknown) => void): void {\n  use({});\n}\n" });
add("ts correct: class tail, one of its methods calls a method of the head class on an untyped value", "not-red", "src/a.ts#Runner", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export class Runner {\n  go(x: any): void {\n    x.run();\n  }\n}\n" });
add("ts wrong: class tail to class head, nothing of the head's is called or made", "red", "src/a.ts#Runner", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export class Runner {\n  go(x: any): void {\n    x.walk();\n  }\n}\n" });
add("ts correct: class tail with a base in another file whose method makes the head", "not-red", "src/a.ts#Runner", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/base.ts": "import { C } from './c';\nexport class Base {\n  make(): C { return new C(); }\n}\n",
  "src/a.ts": "import { Base } from './base';\nexport class Runner extends Base {\n  go(x: any): void {\n    x.walk();\n  }\n}\n" });

/* ---------------- Python ---------------- */
add("py wrong: untyped call by a name the class does not declare", "red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: untyped call by a name the class declares", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.run()\n" });
add("py correct: declared by a base in another file", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/base.py": "class Base:\n    def walk(self):\n        return 1\n",
  "pkg/c.py": "from .base import Base\n\nclass Widget(Base):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: a base nothing can place", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "from .missing import Base\n\nclass Widget(Base):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: a base built by a call", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "def mixin(base):\n    return base\n\nclass Widget(mixin(object)):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: __getattr__ answers for any name", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __getattr__(self, name):\n        return lambda: 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: the class kept as a class attribute and made through it", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/h.py": "from .c import Widget\n\nclass Holder:\n    widget_class = Widget\n",
  "pkg/a.py": "def f(holder):\n    return holder.widget_class()\n" });
add("py correct: the class handed to a registry", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/h.py": "from .c import Widget\n\nKINDS = {}\n\ndef register(name, cls):\n    KINDS[name] = cls\n\nregister('w', Widget)\n",
  "pkg/a.py": "def f(registry):\n    return registry.make()\n" });
add("py wrong: the class is only named: a base, isinstance, an annotation", "red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/h.py": "from .c import Widget\n\nclass Big(Widget):\n    pass\n\ndef check(x) -> bool:\n    return isinstance(x, Widget)\n\ndef hint(x: 'Widget') -> None:\n    return None\n",
  "pkg/a.py": "def f(registry):\n    return registry.make()\n" });
add("py correct: a method of the class is kept under another name", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n\n    def arm(self, timer):\n        timer.on_fire = self.run\n",
  "pkg/a.py": "def f(timer):\n    timer.on_fire()\n" });
add("py correct: an attribute set in __init__ is called", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __init__(self, cb):\n        self.later = cb\n",
  "pkg/a.py": "def f(x):\n    x.later()\n" });
add("py correct: a property is called", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    @property\n    def handler(self):\n        return print\n",
  "pkg/a.py": "def f(x):\n    x.handler()\n" });
add("py correct: class tail, a method calls a method of the head on an untyped value", "not-red", "pkg/a.py#Runner", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/a.py": "class Runner:\n    def go(self, x):\n        x.run()\n" });
add("py wrong: class tail to class head", "red", "pkg/a.py#Runner", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def run(self):\n        return 1\n",
  "pkg/a.py": "class Runner:\n    def go(self, x):\n        x.walk()\n" });
add("py correct: iterating a handed-in value runs the class's __iter__", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __iter__(self):\n        return iter(())\n",
  "pkg/a.py": "from .c import Widget\n\ndef f(x: Widget):\n    for one in x:\n        one.walk()\n" });

add("py correct: returns one it iterated, and the class declares __iter__", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __iter__(self):\n        return iter(())\n",
  "pkg/a.py": "from .c import Widget\n\ndef f(store) -> Widget:\n    w = store.current\n    for one in w:\n        one.walk()\n    return w\n" });
add("py correct: a local declared as the class is iterated, and the class declares __iter__", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __iter__(self):\n        return iter(())\n",
  "pkg/a.py": "from .c import Widget\n\ndef f(store):\n    w: Widget = store.current\n    for one in w:\n        one.walk()\n" });
add("py correct: returns a sum, and the class declares __add__", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __add__(self, other):\n        return self\n",
  "pkg/a.py": "from .c import Widget\n\ndef f(a, b) -> Widget:\n    return a + b\n" });
add("py correct: says it returns one and makes it through the class's own maker", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    @classmethod\n    def build(cls):\n        return cls()\n",
  "pkg/a.py": "from .c import Widget\n\ndef f() -> Widget:\n    return Widget.build()\n" });
add("ts correct: says it returns one and makes it", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "import { C } from './c';\nexport function f(): C {\n  return new C();\n}\n" });
add("ts correct: a method set on the class from outside it is called", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(): number { return 1; }\n}\n(C.prototype as any).walk = function (): number { return 2; };\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });

add("py correct: a value of the class is kept under another name and called (__call__)", "not-red", "pkg/a.py#f", "pkg/c.py#Validator", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Validator:\n    def __call__(self, value):\n        return value\n",
  "pkg/h.py": "from .c import Validator\n\nclass Holder:\n    validate = Validator()\n",
  "pkg/a.py": "def f(holder, x):\n    return holder.validate(x)\n" });
add("py correct: a method the class inherits from a base two files away", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/root.py": "class Root:\n    def walk(self):\n        return 1\n",
  "pkg/base.py": "from .root import Root\n\nclass Base(Root):\n    pass\n",
  "pkg/c.py": "from pkg.base import Base\n\nclass Widget(Base):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: a base reached through a module attribute", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/base.py": "class Base:\n    def walk(self):\n        return 1\n",
  "pkg/c.py": "from . import base\n\nclass Widget(base.Base):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("ts correct: a base class reached through a re-exporting index file", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/base.ts": "export class Base {\n  walk(): number { return 1; }\n}\n",
  "src/index.ts": "export { Base } from './base';\n",
  "src/c.ts": "import { Base } from './index';\nexport class C extends Base {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a base class imported under another name", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/base.ts": "export class Base {\n  walk(): number { return 1; }\n}\n",
  "src/c.ts": "import { Base as Root } from './base';\nexport class C extends Root {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a default-exported base class", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/base.ts": "export default class Base {\n  walk(): number { return 1; }\n}\n",
  "src/c.ts": "import Anything from './base';\nexport class C extends Anything {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });

add("py correct: a subclass's method enters its own object, which runs the base's __enter__", "not-red", "pkg/c.py#use", "pkg/c.py#Box", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Box:\n    def __enter__(self):\n        return self\n\n    def __exit__(self, *exc):\n        return None\n\n\nclass Crate(Box):\n    def use(self, items):\n        with self:\n            items.extend(x for x in ())\n" });
add("py correct: a base's method loops over its own object, and the class at the far end is a kind of it that writes __iter__", "not-red", "pkg/c.py#total", "pkg/c.py#Bag", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Counted:\n    def total(self):\n        n = 0\n        for _ in self:\n            n += 1\n        return n\n\n\nclass Bag(Counted):\n    def __iter__(self):\n        return iter(())\n" });
add("py wrong: a method of an unrelated class with bases only sets its own attributes; the far end has a library base and dunders", "red", "pkg/a.py#prepare", "pkg/c.py#Table", {
  "pkg/__init__.py": "",
  "pkg/c.py": "from collections.abc import MutableMapping\n\n\nclass Table(MutableMapping):\n    def __init__(self):\n        self._d = {}\n\n    def __getitem__(self, k):\n        return self._d[k]\n\n    def __setitem__(self, k, v):\n        self._d[k] = v\n\n    def __delitem__(self, k):\n        del self._d[k]\n\n    def __iter__(self):\n        return iter(self._d)\n\n    def __len__(self):\n        return len(self._d)\n",
  "pkg/a.py": "class Hooks:\n    pass\n\n\nclass Prepared(Hooks):\n    def prepare(self, method):\n        self.method = method\n        if self.method is not None:\n            self.method = self.method.upper()\n" });
add("py wrong: a method enters its own object, and the far end is an unrelated class with __enter__", "red", "pkg/a.py#use", "pkg/c.py#Lock", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Lock:\n    def __enter__(self):\n        return self\n\n    def __exit__(self, *exc):\n        return None\n",
  "pkg/a.py": "class Box:\n    def __enter__(self):\n        return self\n\n    def __exit__(self, *exc):\n        return None\n\n    def use(self, items):\n        with self:\n            items.extend(x for x in ())\n" });

add("py wrong: a method only hands its own object to id(), which runs nothing of it", "red", "pkg/c.py#__repr__", "pkg/c.py#Task", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Task:\n    def __init__(self, name: str) -> None:\n        self.name = name\n\n    def __repr__(self) -> str:\n        return f\"<Task {self.name!r} at {id(self):#x}>\"\n\n    def __hash__(self) -> int:\n        return 1\n" });
add("py correct: a method hands its own object to a library routine that formats it", "not-red", "pkg/c.py#show", "pkg/c.py#Task", {
  "pkg/__init__.py": "",
  "pkg/c.py": "import logging\n\n\nclass Task:\n    def __init__(self, name: str) -> None:\n        self.name = name\n\n    def __repr__(self) -> str:\n        return \"task\"\n\n    def show(self) -> None:\n        logging.info(\"%s\", self)\n" });

/* ---------------- Rust ---------------- */
const CARGO = { "Cargo.toml": "[package]\nname = \"fx\"\nversion = \"0.1.0\"\nedition = \"2021\"\n" };
add("rust wrong: method call by a name the struct does not declare", "red with a compiler", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\npub mod d;\n",
  "src/c.rs": "pub struct Widget { pub n: u32 }\nimpl Widget {\n    pub fn run(&self) -> u32 { self.n }\n}\n",
  "src/d.rs": "pub struct Other;\nimpl Other {\n    pub fn walk(&self) -> u32 { 1 }\n}\n",
  "src/a.rs": "use crate::d::Other;\npub fn f(x: &Other) -> u32 {\n    x.walk()\n}\n" });
add("rust correct: the method is declared in an impl in another file", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\npub mod e;\n",
  "src/c.rs": "pub struct Widget { pub n: u32 }\nimpl Widget {\n    pub fn run(&self) -> u32 { self.n }\n}\n",
  "src/e.rs": "use crate::c::Widget;\nimpl Widget {\n    pub fn walk(&self) -> u32 { 2 }\n}\n",
  "src/a.rs": "pub fn f<T: Walks>(x: &T) -> u32 {\n    x.walk()\n}\npub trait Walks { fn walk(&self) -> u32; }\n" });
add("rust correct: a derived method is called", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "#[derive(Clone)]\npub struct Widget { pub n: u32 }\n",
  "src/a.rs": "use crate::c::Widget;\npub fn f(x: &Widget) -> u32 {\n    let y = x.clone();\n    y.n\n}\n" });
add("rust correct: a method std gives every Display type is called on one (to_string)", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "use std::fmt;\npub struct Widget { pub n: u32 }\nimpl fmt::Display for Widget {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, \"{}\", self.n) }\n}\npub fn make() -> Widget { Widget { n: 1 } }\n",
  "src/a.rs": "use crate::c::make;\npub fn f() -> usize {\n    let w = make();\n    w.to_string().len()\n}\n" });
add("rust correct: trait head, a method it declares is called", "not-red", "src/a.rs#f", "src/c.rs#Walks", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "pub trait Walks {\n    fn walk(&self) -> u32;\n}\n",
  "src/a.rs": "use crate::c::Walks;\npub fn f<T: Walks>(x: &T) -> u32 {\n    x.walk()\n}\n" });
add("ts correct: interface head, built piece by piece and returned as one", "not-red", "src/a.ts#f", "src/i.ts#Shape", { ...TSCFG,
  "src/i.ts": "export interface Shape {\n  area(): number;\n  name: string;\n}\n",
  "src/a.ts": "import type { Shape } from './i';\nexport function f(): Shape {\n  const o: any = { name: 'a' };\n  o.area = () => 1;\n  return o;\n}\n" });
add("ts wrong: the class's own code calls that name on something else, and declares no member of it", "red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  run(x: any): number { x.walk(); return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a member written under a computed name", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "const key = 'walk';\nexport class C {\n  [key](): number { return 1; }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a member assigned onto this by Object.assign", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  constructor(extra: object) { Object.assign(this, extra); }\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("ts correct: a constructor parameter property holding a function", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class C {\n  constructor(public walk: () => void) {}\n}\n",
  "src/a.ts": "export function f(x: any): void {\n  x.walk();\n}\n" });
add("py correct: an attribute set through setattr", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __init__(self, hooks):\n        for name, hook in hooks.items():\n            setattr(self, name, hook)\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: two attributes set in one assignment", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Widget:\n    def __init__(self, a, b):\n        self.walk, self.run = a, b\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: a class-level name holding a function", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "def _walk(self):\n    return 1\n\nclass Widget:\n    walk = _walk\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("py correct: a dataclass field that holds a function", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "from dataclasses import dataclass\nfrom typing import Callable\n\n@dataclass\nclass Widget:\n    walk: Callable[[], int]\n",
  "pkg/a.py": "def f(x):\n    x.walk()\n" });
add("rust correct: a method a macro writes inside the impl", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "macro_rules! walker { () => { pub fn walk(&self) -> u32 { 1 } }; }\npub struct Widget;\nimpl Widget {\n    walker!();\n}\n",
  "src/a.rs": "pub trait W { fn walk(&self) -> u32; }\npub fn f<T: W>(x: &T) -> u32 {\n    x.walk()\n}\n" });
add("rust correct: to_string on a Display value read out of a field, the type never named", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "use std::fmt;\npub struct Widget { pub n: u32 }\nimpl fmt::Display for Widget {\n    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, \"{}\", self.n) }\n}\npub struct Holder { pub w: Widget }\n",
  "src/a.rs": "use crate::c::Holder;\npub fn f(h: &Holder) -> usize {\n    h.w.to_string().len()\n}\n" });
add("rust correct: comparing two values of the type runs its derived PartialEq, the type never named", "not-red", "src/a.rs#f", "src/c.rs#Widget", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/c.rs": "#[derive(PartialEq)]\npub struct Widget { pub n: u32 }\npub struct Holder { pub w: Widget, pub v: Widget }\n",
  "src/a.rs": "use crate::c::Holder;\npub fn f(h: &Holder) -> bool {\n    h.w == h.v\n}\n" });
add("ts correct: a value typed as the base, the head a subclass in another file that inherits the method", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/base.ts": "export class Base {\n  walk(): number { return 1; }\n}\n",
  "src/c.ts": "import { Base } from './base';\nexport class C extends Base {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "import type { Base } from './base';\nexport function f(x: Base): void {\n  x.walk();\n}\n" });
add("ts correct: a value typed as the base in the same file as the head, which inherits the method", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class Base {\n  walk(): number { return 1; }\n}\nexport class C extends Base {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "import type { Base } from './c';\nexport function f(x: Base): void {\n  x.walk();\n}\n" });
add("ts wrong: a value typed as another class of the head's file that shares a method's name", "red with a compiler", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class Other {\n  run(): number { return 2; }\n}\nexport class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "import type { Other } from './c';\nexport function f(x: Other): number {\n  return x.run();\n}\n" });
add("ts correct: a value typed as the head, calling the method it shares with another class of its file", "not-red", "src/a.ts#f", "src/c.ts#C", { ...TSCFG,
  "src/c.ts": "export class Other {\n  run(): number { return 2; }\n}\nexport class C {\n  run(): number { return 1; }\n}\n",
  "src/a.ts": "import type { C } from './c';\nexport function f(x: C): number {\n  return x.run();\n}\n" });
add("py correct: a value typed as the base, the head a subclass in another file that inherits the method", "not-red", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/base.py": "class Base:\n    def walk(self):\n        return 1\n",
  "pkg/c.py": "from .base import Base\n\nclass Widget(Base):\n    def run(self):\n        return 1\n",
  "pkg/a.py": "from .base import Base\n\ndef f(x: Base):\n    x.walk()\n" });
add("py wrong: a value typed as another class of the head's file that shares a method's name", "red with a compiler", "pkg/a.py#f", "pkg/c.py#Widget", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Other:\n    def run(self):\n        return 2\n\nclass Widget:\n    def run(self):\n        return 1\n",
  "pkg/a.py": "from .c import Other\n\ndef f(x: Other):\n    return x.run()\n" });
add("py correct: a method enters its own object (with self), which runs the class's __enter__", "not-red", "pkg/c.py#use", "pkg/c.py#Box", {
  "pkg/__init__.py": "",
  "pkg/c.py": "class Box:\n    def __enter__(self):\n        return self\n\n    def __exit__(self, *exc):\n        return None\n\n    def bell(self):\n        self.use([])\n\n    def use(self, items):\n        with self:\n            items.extend(x for x in ())\n" });
add("py correct: a call typed as a library class that the head derives from and overrides", "not-red", "pkg/a.py#f", "pkg/c.py#NullFile", {
  "pkg/__init__.py": "",
  "pkg/c.py": "from typing import IO\n\nclass NullFile(IO[str]):\n    def write(self, text: str) -> int:\n        return 0\n",
  "pkg/a.py": "from typing import IO\n\ndef f(file: IO[str], text: str) -> None:\n    file.write(text)\n" });
add("ts correct: a call typed as a library class that the head derives from and overrides", "not-red", "src/a.ts#f", "src/c.ts#Quiet", { ...TSCFG,
  "src/c.ts": "export class Quiet extends Error {\n  toDetail(): string { return 'q'; }\n  toString(): string { return 'quiet'; }\n}\n",
  "src/a.ts": "export function f(e: Error): string {\n  return e.toString();\n}\n" });
add("rust wrong: trait tail, its default method calls something else", "red", "src/c.rs#Walks", "src/a.rs#helper", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/a.rs": "pub fn helper() -> u32 { 1 }\npub fn other() -> u32 { 2 }\n",
  "src/c.rs": "use crate::a::other;\npub trait Walks {\n    fn walk(&self) -> u32 { other() }\n}\n" });
add("rust correct: trait tail, its default method calls it", "not-red", "src/c.rs#Walks", "src/a.rs#helper", { ...CARGO,
  "src/lib.rs": "pub mod a;\npub mod c;\n",
  "src/a.rs": "pub fn helper() -> u32 { 1 }\n",
  "src/c.rs": "use crate::a::helper;\npub trait Walks {\n    fn walk(&self) -> u32 { helper() }\n}\n" });

/** Checked once with the compilers on: every language's refusals, and the wrong arrows only a compiler settles. */
const LIVE = new Set<string>([
  "ts wrong: untyped call by a name the class does not declare",
  "ts correct: the name is declared by a base in another file",
  "ts correct: a call typed as a library class that the head derives from and overrides",
  "ts correct: a value typed as the base, the head a subclass in another file that inherits the method",
  "ts correct: a value typed as the head, calling the method it shares with another class of its file",
  "ts wrong: class tail to class head, nothing of the head's is called or made",
  "py wrong: untyped call by a name the class does not declare",
  "py correct: declared by a base in another file",
  "py correct: the class kept as a class attribute and made through it",
  "py correct: a method enters its own object (with self), which runs the class's __enter__",
  "py correct: a call typed as a library class that the head derives from and overrides",
  "py correct: a value typed as the base, the head a subclass in another file that inherits the method",
  "py correct: a base's method loops over its own object, and the class at the far end is a kind of it that writes __iter__",
  "py wrong: a method enters its own object, and the far end is an unrelated class with __enter__",
  "py wrong: class tail to class head",
  "rust correct: a derived method is called",
  "rust correct: a method std gives every Display type is called on one (to_string)",
  "rust correct: the method is declared in an impl in another file",
  "rust correct: a method a macro writes inside the impl",
  "rust wrong: trait tail, its default method calls something else",
  "rust wrong: method call by a name the struct does not declare",
  "ts wrong: a value typed as another class of the head's file that shares a method's name",
  "py wrong: a value typed as another class of the head's file that shares a method's name"
]);

const repos: string[] = [];
afterAll(() => { for (const repo of repos) rmSync(repo, { recursive: true, force: true }); });

async function check(one: Case, live: boolean): Promise<DriftReport> {
  // Outside the worktree on purpose: a scratch source file inside one is read by the dependency tests.
  const repo = mkdtempSync(path.join(tmpdir(), "calls-class-names-"));
  repos.push(repo);
  for (const [relative, contents] of Object.entries(one.files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [{ id: "tail", label: "tail", ref: one.from }, { id: "head", label: "head", ref: one.to }],
    edges: [{ from: "tail", to: "head", claim: "calls" }],
  });
  const workspace = createWorkspace(repo);
  if (!live) return checkDrift(board, workspace, { edges: true });
  return (await refereedCheckLive(repo, (referee) =>
    checkDrift(board, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }))).report;
}

const reds = (report: DriftReport) => report.edges.filter((finding) => ACCUSES.has(finding.kind)).map((finding) => finding.kind);

describe("with no compiler", () => {
  it.each(cases.map((one) => [one.name, one] as const))("%s", async (_name, one) => {
    const report = await check(one, false);
    // Red: "calls nothing of it", or "calls its neighbour instead" (a wrong-routine red).
    if (one.want === "red") expect(reds(report)).toHaveLength(1);
    else expect(reds(report)).toEqual([]);
  }, 60_000);
});

describe("with the compilers on", () => {
  const picked = cases.filter((one) => LIVE.has(one.name));
  it("picks every case it names", () => { expect(picked.length).toBe(LIVE.size); });
  it.each(picked.map((one) => [one.name, one] as const))("%s", async (_name, one) => {
    if (one.from.endsWith(".rs") && !hasRustAnalyzer) return;
    const report = await check(one, true);
    if (one.want === "not-red") expect(reds(report)).toEqual([]);
    else expect(reds(report)).toHaveLength(1);
  }, 180_000);
});

describe("a red the name test rests on waits for the compilers", () => {
  it("a text pass that ruled a call out by its name asks for one", async () => {
    const one = cases.find((each) => each.name === "py wrong: untyped call by a name the class does not declare")!;
    const report = await check(one, false);
    expect(reds(report)).toEqual(["calls-refuted"]);
    expect(wouldHelp(report)).toBe(true);
  }, 60_000);
});
