/**
 * `@builds` may now say "A doesn't create B" (#362).
 *
 * "A builds B" means A's own body creates the B: by writing it (`new B`,
 * `<B />`) or by calling B's own constructor. A B handed back by some other
 * function does not count (#360). So a body that creates nothing of the kind
 * is a wrong arrow, and it goes red with a sentence saying what it creates
 * instead.
 *
 * Every other test here is correct code that must stay quiet. Each one was
 * written against the unguarded rule first and watched go red, then its guard
 * was added -- the shapes are #360's table, the ones a bench cannot see
 * because the answer key shares the reader's blind spots.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, type DriftReport, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => {
      if (files[target] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${target}/`)) ? "directory" : "missing";
    },
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

async function checked(
  makerRef: string,
  madeRef: string,
  files: Record<string, string>,
  state?: "planned",
): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "maker", label: "maker", ref: makerRef },
      { id: "made", label: "made", ref: madeRef },
    ],
    edges: [{ from: "maker", to: "made", claim: "builds", ...(state ? { state } : {}) }],
  });
  return checkDrift(board, fakeWorkspace(files), { edges: true });
}

const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);
const accusations = (report: DriftReport) =>
  report.edges.filter((finding) => ACCUSING.has(finding.kind));

/** A class with behaviour: nothing but `new Widget` can make one. */
const WIDGET = "export class Widget { x = 0; go() {} }\n";

const ts = (factory: string, widget = WIDGET, extra: Record<string, string> = {}) => ({
  "tsconfig.json": "{}",
  "src/factory.ts": factory,
  "src/widget.ts": widget,
  ...extra,
});

describe("TypeScript: a function that creates something else", () => {
  it("goes red and says what it creates instead (vue's computed -> Dep)", async () => {
    const report = await checked("src/factory.ts#computed", "src/widget.ts#Widget", ts(
      "class ComputedRefImpl { value = 0; get() { return this.value; } }\n"
        + "export function computed(getter: () => number) {\n"
        + "  const cRef = new ComputedRefImpl();\n"
        + "  return cRef;\n"
        + "}\n",
    ));

    const red = accusations(report);
    expect(red.map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(red[0]!.detail).toContain("ComputedRefImpl");
    expect(report.clean).toBe(false);
  });
});

describe("TypeScript: a head something other than `new` can create", () => {
  /*
   * An object literal is a perfectly good interface, type alias or fields-only
   * class, and the body writes no name when it makes one: `run({ x: 1 })`
   * creates the Widget `run` asks for. #360 found ~470 of these in the corpus,
   * and excalidraw's `_newElementBase -> ExcalidrawElement` on the bench is
   * one -- a correct arrow the answer key calls false.
   */
  const literal = "import { run } from \"./widget\";\nexport function build() { run({ x: 1 }); }\n";

  it("stays quiet on an interface", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(literal,
      "export interface Widget { x: number }\nexport function run(w: Widget) {}\n"));
    expect(accusations(report)).toEqual([]);
  });

  it("stays quiet on a type alias", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(literal,
      "export type Widget = { x: number };\nexport function run(w: Widget) {}\n"));
    expect(accusations(report)).toEqual([]);
  });

  it("stays quiet on a class with fields and no methods", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(literal,
      "export class Widget { x = 0; }\nexport function run(w: Widget) {}\n"));
    expect(accusations(report)).toEqual([]);
  });

  it("stays quiet on an abstract class, which only a subclass can create", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(
      "export function build() { return 1; }\n",
      "export abstract class Widget { go() {} }\n"));
    expect(accusations(report)).toEqual([]);
  });

  it("stays quiet when the head is in another language", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.py#Widget", {
      "tsconfig.json": "{}",
      "src/factory.ts": "export function build() { return 1; }\n",
      "src/widget.py": "class Widget:\n    def go(self):\n        pass\n",
    });
    expect(accusations(report)).toEqual([]);
  });

  it("is still red on a class with behaviour", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(
      "export function build() { return 1; }\n",
      "export class Widget { constructor(public x: number) {} }\n"));
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(accusations(report)[0]!.detail).toMatch(/own code never creates one\. Getting/);
  });
});

describe("TypeScript: a body that could create it without writing `new Widget`", () => {
  const quiet = async (factory: string) => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(factory));
    expect(accusations(report)).toEqual([]);
  };

  it("stays quiet when the routine says it returns one", () => quiet(
    "import { makeWidget } from \"./make\";\nexport function build(): Widget { return makeWidget(); }\n"));

  it("stays quiet when the return type wraps one", () => quiet(
    "export async function build(): Promise<Widget> { return load(); }\n"));

  it("stays quiet on a local alias, const C = Widget", () => quiet(
    "import { Widget } from \"./widget\";\nexport function build() { const C = Widget; return new C(); }\n"));

  it("stays quiet on a static constructor, Widget.create()", () => quiet(
    "import { Widget } from \"./widget\";\nexport function build() { return Widget.create(); }\n"));

  it("stays quiet on Reflect.construct(Widget)", () => quiet(
    "import { Widget } from \"./widget\";\nexport function build() { return Reflect.construct(Widget, []); }\n"));

  it("stays quiet on import { Widget as W }", () => quiet(
    "import { Widget as W } from \"./widget\";\nexport function build() { return new W(); }\n"));

  it("stays quiet when the name is only a type, let w: Widget", () => quiet(
    "export function build() { const w: Widget = make(); w.go(); }\n"));
});

describe("TypeScript: a construction that may be a Widget under another name", () => {
  const quiet = async (factory: string, widget = WIDGET, extra: Record<string, string> = {}, maker = "src/factory.ts#build") => {
    const report = await checked(maker, "src/widget.ts#Widget", ts(factory, widget, extra));
    expect(accusations(report)).toEqual([]);
  };

  it("stays quiet on a module-level alias, const Ctor = Widget", () => quiet(
    "import { Widget } from \"./widget\";\nconst Ctor = Widget;\nexport function build() { return new Ctor(); }\n"));

  it("stays quiet on a default import under another name", () => quiet(
    "import W from \"./widget\";\nexport function build() { return new W(); }\n",
    "export default class Widget { x = 0; go() {} }\n"));

  it("stays quiet on a re-export under another name", () => quiet(
    "import { Gadget } from \"./index\";\nexport function build() { return new Gadget(); }\n",
    WIDGET, { "src/index.ts": "export { Widget as Gadget } from \"./widget\";\n" }));

  it("stays quiet on new this.constructor()", () => quiet(
    "", "export class Widget { x = 0; clone() { return new (this.constructor as any)(); } }\n",
    {}, "src/widget.ts#clone"));

  it("stays quiet on this.constructor kept in a local", () => quiet(
    "", "export class Widget { x = 0; clone() { const C: any = this.constructor; return new C(); } }\n",
    {}, "src/widget.ts#clone"));

  it("stays quiet on a generic new k()", () => quiet(
    "export function build<T>(k: new () => T): T { return new k(); }\n"));

  it("stays quiet on a class kept in a map", () => quiet(
    "import { Widget } from \"./widget\";\nconst KINDS = { w: Widget };\nexport function build(k: 'w') { return new KINDS[k](); }\n"));

  it("stays quiet on a subclass declared in the same file", () => quiet(
    "", WIDGET + "export class SubWidget extends Widget {}\nexport function build() { return new SubWidget(); }\n",
    {}, "src/widget.ts#build"));

  it("stays quiet on an imported subclass", () => quiet(
    "import { SubWidget } from \"./sub\";\nexport function build() { return new SubWidget(); }\n",
    WIDGET, { "src/sub.ts": "import { Widget } from \"./widget\";\nexport class SubWidget extends Widget {}\n" }));

  it("is still red on an imported class that is not a Widget", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget", ts(
      "import { Gear } from \"./gear\";\nexport function build() { return new Gear(); }\n",
      WIDGET, { "src/gear.ts": "export class Gear { turn() {} }\n" }));
    const red = accusations(report);
    expect(red.map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(red[0]!.detail).toContain("it creates Gear instead");
  });
});

describe("TypeScript: the rest of #360's table", () => {
  it("stays quiet on a class component rendered through a variable, const C = Widget; <C />", async () => {
    const report = await checked("src/factory.tsx#build", "src/widget.tsx#Widget", {
      "tsconfig.json": "{}",
      "src/factory.tsx": "import { Widget } from \"./widget\";\nconst C = Widget;\nexport function build() { return <C />; }\n",
      "src/widget.tsx": "import { Component } from \"react\";\nexport class Widget extends Component { render() { return <div />; } }\n",
    });
    expect(accusations(report)).toEqual([]);
  });

  it("is red on a component that renders a different component", async () => {
    const report = await checked("src/factory.tsx#build", "src/widget.tsx#Widget", {
      "tsconfig.json": "{}",
      "src/factory.tsx": "function Header() { return <div />; }\nexport function build() { return <Header />; }\n",
      "src/widget.tsx": "import { Component } from \"react\";\nexport class Widget extends Component { render() { return <div />; } }\n",
    });
    const red = accusations(report);
    expect(red.map((finding) => finding.kind)).toEqual(["builds-refuted"]);
    expect(red[0]!.detail).toContain("it creates Header instead");
  });

  it("stays quiet on a planned arrow: the code does not exist yet", async () => {
    const report = await checked("src/factory.ts#build", "src/widget.ts#Widget",
      ts("export function build() { return 1; }\n"), "planned");
    expect(accusations(report)).toEqual([]);
  });
});

/** A Python class with behaviour, and the package it lives in. */
const PY_WIDGET = "class Widget:\n    def __init__(self, x=0):\n        self.x = x\n";
const py = (factory: string, widget = PY_WIDGET, extra: Record<string, string> = {}) => ({
  "src/__init__.py": "",
  "src/factory.py": factory,
  "src/widget.py": widget,
  "src/helpers.py": "def helper():\n    return 1\n",
  ...extra,
});

describe("Python: a function that creates something else", () => {
  it("goes red when every call is read and none of them creates one (httpx's http_version -> Headers)", async () => {
    const report = await checked("src/factory.py#build", "src/widget.py#Widget",
      py("from .helpers import helper\n\ndef build():\n    return helper()\n"));
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["builds-refuted"]);
  });

  it("goes red as backwards when the head's code creates the tail (httpx's Headers -> Request)", async () => {
    const report = await checked("src/factory.py#Maker", "src/widget.py#Widget", py(
      "class Maker:\n    def run(self):\n        return 1\n",
      "from .factory import Maker\n\nclass Widget:\n    def make(self):\n        return Maker()\n"));
    const red = accusations(report);
    expect(red.map((finding) => finding.kind)).toEqual(["builds-backwards"]);
    expect(red[0]!.detail).toContain("Maker()");
  });

  it("is still backwards when the head's file writes `Widget | None` in a hint (httpx's URL -> Request)", async () => {
    // `Widget | None` gives the grammar a `left` field spelt Widget. Read as a
    // second declaration, it silenced every class used in a union hint.
    const report = await checked("src/factory.py#Maker", "src/widget.py#Widget", py(
      "class Maker:\n    def run(self):\n        return 1\n",
      "from .factory import Maker\n\nclass Widget:\n    def make(self, other: Widget | None = None):\n        return Maker()\n"));
    expect(accusations(report).map((finding) => finding.kind)).toEqual(["builds-backwards"]);
  });
});

describe("Python: a body that could create one without a call spelt as the class", () => {
  const quiet = async (factory: string, widget = PY_WIDGET, extra: Record<string, string> = {},
    maker = "src/factory.py#build", made = "src/widget.py#Widget") => {
    const report = await checked(maker, made, py(factory, widget, extra));
    expect(accusations(report)).toEqual([]);
  };
  const method = (body: string) => PY_WIDGET + "\n" + body;

  it("stays quiet on cls() in a classmethod", () => quiet("",
    method("    @classmethod\n    def from_dict(cls, d):\n        return cls(**d)\n"), {}, "src/widget.py#from_dict"));

  it("stays quiet on cls() in a classmethod that returns nothing", () => quiet("",
    method("    @classmethod\n    def register(cls, d):\n        REG.append(cls(**d))\n"), {}, "src/widget.py#register"));

  it("stays quiet on type(self)(..)", () => quiet("",
    method("    def copy(self):\n        return type(self)(self.x)\n"), {}, "src/widget.py#copy"));

  it("stays quiet on self.__class__(..)", () => quiet("",
    method("    def copy(self):\n        return self.__class__(self.x)\n"), {}, "src/widget.py#copy"));

  it("stays quiet on a module-level alias, Maker = Widget", () => quiet(
    "from .widget import Widget\nMaker = Widget\n\ndef build():\n    return Maker()\n"));

  it("stays quiet on a local alias", () => quiet(
    "from .widget import Widget\n\ndef build():\n    Maker = Widget\n    return Maker()\n"));

  it("stays quiet on Widget.from_dict(..)", () => quiet(
    "from .widget import Widget\n\ndef build(d):\n    return Widget.from_dict(d)\n"));

  it("stays quiet on a class kept in a dict", () => quiet(
    "from .widget import Widget\nKINDS = {'w': Widget}\n\ndef build(k):\n    return KINDS[k]()\n"));

  it("stays quiet on a class as a default argument", () => quiet(
    "from .widget import Widget\n\ndef build(factory=Widget):\n    return factory()\n"));

  it("stays quiet on a class passed in", () => quiet("def build(factory):\n    return factory()\n"));

  it("stays quiet on the module's attribute, widget.Widget()", () => quiet(
    "from . import widget\n\ndef build():\n    return widget.Widget()\n"));

  it("stays quiet on a class kept in an attribute, self.widget_class() (flask)", () => quiet(
    "from .helpers import helper\n\nclass Maker:\n    widget_class = None\n\n    def build(self):\n        helper()\n        return self.widget_class()\n",
    PY_WIDGET, {}, "src/factory.py#build"));

  it("stays quiet on an imported subclass, SubWidget()", () => quiet(
    "from .sub import SubWidget\n\ndef build():\n    return SubWidget()\n",
    PY_WIDGET, { "src/sub.py": "from .widget import Widget\n\nclass SubWidget(Widget):\n    pass\n" }));

  it("stays quiet on a subclass's __init__ calling super().__init__()", () => quiet("", PY_WIDGET, {
    "src/sub.py": "from .widget import Widget\n\nclass SubWidget(Widget):\n    def __init__(self):\n        super().__init__()\n",
  }, "src/sub.py#__init__"));

  it("stays quiet on a TypedDict, which a dict literal creates", () => quiet(
    "def build():\n    return {'x': 1}\n",
    "from typing import TypedDict\n\nclass Widget(TypedDict):\n    x: int\n"));

  it("stays quiet on a Protocol, which any class with the method satisfies", () => quiet(
    "from .helpers import helper\n\ndef build():\n    return helper()\n",
    "from typing import Protocol\n\nclass Widget(Protocol):\n    def go(self) -> None: ...\n"));

  it("stays quiet on a planned arrow", async () => {
    const report = await checked("src/factory.py#build", "src/widget.py#Widget",
      py("from .helpers import helper\n\ndef build():\n    return helper()\n"), "planned");
    expect(accusations(report)).toEqual([]);
  });
});
