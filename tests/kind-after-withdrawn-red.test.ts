/**
 * A plainly wrong kind of end, when a word's own red was withdrawn (#463).
 *
 * `SmartRouter @conforms router.ts#match` cannot be true: `match` is a method,
 * and nothing implements a method. The kind reader (`parts.ts`) says so from
 * the text alone. But the `@conforms` reader answered first -- "the base list
 * does not name `match`" -- and that red rests on a compiler question. Where
 * the compiler cannot settle it, or none is running, the gate withdraws the
 * red, and the arrow came back "not sure" without the kind check ever being
 * asked. 14 wrong arrows on the benchmark sets had this shape.
 *
 * Now the kind check is asked when a red is withdrawn, from the text alone and
 * only about the end the withdrawn reader did not read: the signature words
 * read their head's signature, `@holds` and `@conforms` their tail's field and
 * base lists, so the kind check speaks about the other end. A reader that read
 * a signature at a class (its constructor) is not overruled about that end.
 *
 * Every red here is "not sure" on main; every test checks that the withdrawn
 * red is what it replaced, so a shape another path already catches cannot
 * pass for this one. The refusals come first: a field holding a function and
 * called (django's `_middleware_chain`), a callable class, a property, a Rust
 * fn-pointer field, a TypeScript field typed as a function, a name declared
 * twice where one declaration is the right kind, and right-kind ends behind
 * the same withdrawn reds. `@calls`, `@feeds` and `@accesses` are never asked
 * here: whether a data end can run is a compiler's question, and a wall-lift
 * of it made a false red on django.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, type ClosedBodyReferee, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import type { ArrowClaim } from "../src/engine/claim";
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

/** A compiler that is running and can settle nothing: every red resting on a question is withdrawn. */
const SILENT: ClosedBodyReferee = { resolveReceiver: () => undefined };

/** Both ways a red is withdrawn: the compiler could not say, and no compiler at all. */
const WITHDRAWN: Array<[string, ClosedBodyReferee | undefined]> = [
  ["a compiler that cannot say", SILENT],
  ["no compiler", undefined],
];

async function boardOf(fromRef: string, toRef: string, claim: ArrowClaim): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: fromRef.split("#")[1] ?? fromRef, ref: fromRef },
      { id: "head", label: toRef.split("#")[1] ?? toRef, ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim }],
  });
  return board;
}

async function check(
  files: Record<string, string>,
  from: string,
  to: string,
  claim: ArrowClaim,
  referee: ClosedBodyReferee | undefined,
) {
  const board = await boardOf(from, to, claim);
  const report = checkDrift(board, fakeWorkspace(files), {
    edges: true, ...(referee ? { closedBodyReferee: referee } : {}),
  });
  return {
    report,
    red: report.edges.find((edge) => (ACCUSING_EDGE_KINDS as readonly string[]).includes(edge.kind)),
    wrongKind: report.edges.find((edge) => edge.kind === "end-lacks-part"),
    /** The word's own red the gate withdrew, which is the only door this change opens. */
    withdrawn: report.gated.filter((one) => one.outcome !== "stands" && one.outcome !== "compiler-says-it-does"),
  };
}

/* The hono shape: an interface in one file, the classes that implement it in another. */
const TS: Record<string, string> = {
  "src/router.ts": [
    "export interface Router<T> {",
    "  add(method: string, path: string, handler: T): void",
    "  match(method: string, path: string): T[]",
    "}",
    "",
    "export interface Context<T> { schema: T }",
    "",
    "export function process<T>(ctx: T, schema: T): void {}",
    "",
    "export class Service<T> {",
    "  constructor(readonly value: T) {}",
    "}",
    "",
    "export interface Cfg { name: string }",
    "export function Cfg(): Cfg { return { name: '' } }",
    "",
  ].join("\n"),
  "src/smart.ts": [
    "import type { Router } from './router'",
    "",
    "export class SmartRouter<T> implements Router<T> {",
    "  add(method: string, path: string, handler: T): void {}",
    "  match(method: string, path: string): T[] { return [] }",
    "}",
    "",
    "export class Holder<T> { item: T | undefined }",
    "",
    "export function helper(): void {}",
    "",
    "export class Svc {",
    "  onError: (error: Error) => void = () => {}",
    "  run(): void { this.onError(new Error('x')) }",
    "}",
    "",
  ].join("\n"),
};

/* The marshmallow shape: a parameter typed through a module the check cannot open. */
const PY: Record<string, string> = {
  "src/fields.py": [
    "import typing",
    "from . import types",
    "",
    "",
    "class Field:",
    "    def __init__(self, *, load_default: typing.Any = None, validate: types.Validator | None = None) -> None:",
    "        self.load_default = load_default",
    "",
    "",
    "def process(ctx: types.Context, schema: types.Validator) -> None:",
    "    pass",
    "",
  ].join("\n"),
  "src/types.py": "import typing\n\nValidator = typing.Callable[[typing.Any], typing.Any]\nContext = typing.Any\n",
  "src/schema.py": [
    "from typing import Generic, TypeVar",
    "",
    "from .fields import Field",
    "",
    "T = TypeVar(\"T\")",
    "",
    "",
    "def _get_fields(attrs) -> list[tuple[str, Field]]:",
    "    return [(k, v) for k, v in attrs if isinstance(v, Field)]",
    "",
    "",
    "class Meta:",
    "    pass",
    "",
    "",
    "class Handler(Generic[T]):",
    "    def __call__(self, request: T) -> None:",
    "        pass",
    "",
    "",
    "class Q(Generic[T]):",
    "    @property",
    "    def session(self) -> T:",
    "        return self._session",
    "",
    "",
    "class BaseHandler:",
    "    _middleware_chain = None",
    "",
    "    def load_middleware(self):",
    "        self._middleware_chain = self._get_response",
    "",
    "    def get_response(self, request):",
    "        response = self._middleware_chain(request)",
    "        return response",
    "",
    "    def _get_response(self, request):",
    "        return request",
    "",
    "",
    "class Cfg:",
    "    name: str",
    "",
    "",
    "Cfg = make_config(Cfg)",
    "",
  ].join("\n"),
};

const RS: Record<string, string> = {
  "src/lib.rs": [
    "pub trait Router<T> {",
    "    fn add(&self, handler: T);",
    "    fn find(&self) -> Vec<T>;",
    "}",
    "",
    "pub struct Holder<T> {",
    "    pub item: T,",
    "}",
    "",
    "pub struct Context<T> {",
    "    pub schema: T,",
    "}",
    "",
    "pub fn process<T>(ctx: T, schema: T) {}",
    "",
    "pub fn helper() {}",
    "",
    "pub struct Service {",
    "    pub handler: fn(u8) -> u8,",
    "}",
    "",
    "impl Service {",
    "    pub fn run(&self) -> u8 {",
    "        (self.handler)(1)",
    "    }",
    "}",
    "",
    "pub struct Thing {",
    "    pub name: u8,",
    "}",
    "",
    "#[allow(non_snake_case)]",
    "pub fn Thing() -> Thing {",
    "    Thing { name: 0 }",
    "}",
    "",
  ].join("\n"),
};

/* ---------------------------------------------------------------- refusals */

describe("refusals: a withdrawn red with an end of the right kind stays not sure", () => {
  for (const [how, referee] of WITHDRAWN) {
    describe(`with ${how}`, () => {
      const rightKind: Array<[string, Record<string, string>, string, string, ArrowClaim]> = [
        ["@conforms into an interface, TypeScript", TS, "src/smart.ts#SmartRouter", "src/router.ts#Context", "conforms"],
        ["@holds into a type, TypeScript", TS, "src/smart.ts#Holder", "src/router.ts#Context", "holds"],
        ["@holds into a type, Rust", RS, "src/lib.rs#Holder", "src/lib.rs#Context", "holds"],
        ["@takes from a type into a generic function, TypeScript", TS, "src/router.ts#Context", "src/router.ts#process", "takes"],
        ["@takes from a type into a generic function, Rust", RS, "src/lib.rs#Context", "src/lib.rs#process", "takes"],
        // The reader read the constructor at the head: the kind check does not overrule it about that end.
        ["@takes into a class whose constructor the reader read, TypeScript", TS, "src/router.ts#Context", "src/router.ts#Service", "takes"],
        ["@takes into a class whose constructor the reader read, Python", PY, "src/schema.py#Meta", "src/fields.py#Field", "takes"],
        // A name declared twice, once as a type: it has the part, so nothing lacks it.
        ["@takes from a name declared as a function and an interface, TypeScript", TS, "src/router.ts#Cfg", "src/router.ts#process", "takes"],
        ["@takes from a name declared as a struct and a function, Rust", RS, "src/lib.rs#Thing", "src/lib.rs#process", "takes"],
      ];
      for (const [name, files, from, to, claim] of rightKind) {
        it(name, async () => {
          const { red, withdrawn } = await check(files, from, to, claim, referee);
          expect(withdrawn.length).toBe(1);
          expect(red).toBeUndefined();
        });
      }

      it("@takes from a name declared as a class and a value, Python", async () => {
        const { red } = await check(PY, "src/schema.py#Cfg", "src/fields.py#process", "takes", referee);
        expect(red).toBeUndefined();
      });

      it("@returns from a type into a property, Python", async () => {
        const { red } = await check(PY, "src/fields.py#Field", "src/schema.py#Q.session", "returns", referee);
        expect(red).toBeUndefined();
      });

      it("@calls a field that holds a function and is called (django's _middleware_chain), Python", async () => {
        const { red } = await check(
          PY, "src/schema.py#BaseHandler.get_response", "src/schema.py#BaseHandler._middleware_chain", "calls", referee,
        );
        expect(red).toBeUndefined();
      });

      it("@calls a property, Python", async () => {
        const { wrongKind } = await check(PY, "src/schema.py#BaseHandler.get_response", "src/schema.py#Q.session", "calls", referee);
        expect(wrongKind).toBeUndefined();
      });

      it("@calls a callable class, Python", async () => {
        const { wrongKind } = await check(PY, "src/schema.py#BaseHandler.get_response", "src/schema.py#Handler", "calls", referee);
        expect(wrongKind).toBeUndefined();
      });

      it("@calls a fn-pointer field, Rust", async () => {
        const { red } = await check(RS, "src/lib.rs#Service.run", "src/lib.rs#Service.handler", "calls", referee);
        expect(red).toBeUndefined();
      });

      it("@calls a field typed as a function, TypeScript", async () => {
        const { red } = await check(TS, "src/smart.ts#Svc.run", "src/smart.ts#Svc.onError", "calls", referee);
        expect(red).toBeUndefined();
      });
    });
  }
});

/* ---------------------------------------------------------------- the reds */

describe("a wrong kind of end the withdrawn red hid", () => {
  for (const [how, referee] of WITHDRAWN) {
    describe(`with ${how}`, () => {
      const wrong: Array<[string, Record<string, string>, string, string, ArrowClaim, string]> = [
        ["@conforms into an interface's method, TypeScript", TS, "src/smart.ts#SmartRouter", "src/router.ts#match", "conforms", "cannot be implemented"],
        ["@holds into an interface's method, TypeScript", TS, "src/smart.ts#Holder", "src/router.ts#match", "holds", "a function is not a type"],
        ["@holds into a trait's method, Rust", RS, "src/lib.rs#Holder", "src/lib.rs#Router::find", "holds", "a function is not a type"],
        ["@takes drawn from a function, TypeScript", TS, "src/smart.ts#helper", "src/router.ts#process", "takes", "a function is not a type"],
        ["@takes drawn from a function, Python", PY, "src/schema.py#_get_fields", "src/fields.py#Field", "takes", "a function is not a type"],
        ["@takes drawn from a function, Rust", RS, "src/lib.rs#helper", "src/lib.rs#process", "takes", "a function is not a type"],
      ];
      for (const [name, files, from, to, claim, says] of wrong) {
        it(`${name} is red`, async () => {
          const { wrongKind, withdrawn, report } = await check(files, from, to, claim, referee);
          expect(withdrawn.length).toBe(1);
          expect(wrongKind?.detail).toContain(says);
          expect(report.unconfirmedEdges).toEqual([]);
        });
      }
    });
  }
});

describe("what main already says about a callable type at the head of @takes is unchanged", () => {
  /*
   * Not this change's: on main the signature reader withholds on these, and
   * the kind check that runs after every reader already calls the head a
   * type with no parameters. This change only ever asks the other end, so
   * neither shape reaches it.
   */
  it.each([
    ["a callable interface, TypeScript", { ...TS, "src/handler.ts": "export interface Handler<T> { (request: T): void }\n" }, "src/router.ts#Context", "src/handler.ts#Handler"],
    ["a callable class, Python", PY, "src/schema.py#Meta", "src/schema.py#Handler"],
  ] as const)("%s", async (_name, files, from, to) => {
    const { withdrawn } = await check(files, from, to, "takes", SILENT);
    expect(withdrawn).toEqual([]);
  });
});
