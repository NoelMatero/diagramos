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
 * a signature at a class (its constructor) or a callable type is not overruled
 * about that end.
 *
 * The refusals come first, and each language has them: a field holding a
 * function and called (django's `_middleware_chain`), a callable class, a
 * property, a Rust fn-pointer field, a TypeScript field typed as a function,
 * and a name declared twice where one declaration is the right kind. `@calls`,
 * `@feeds` and `@accesses` are never asked here: whether a data end can run is
 * a compiler's question, and a wall-lift of it made a false red on django.
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

async function boardOf(fromRef: string, toRef: string, claim: ArrowClaim, label?: string): Promise<BoardFile> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: fromRef.split("#")[1] ?? fromRef, ref: fromRef },
      { id: "head", label: toRef.split("#")[1] ?? toRef, ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim, ...(label ? { label } : {}) }],
  });
  return board;
}

async function check(
  file: string,
  source: string,
  from: string,
  to: string,
  claim: ArrowClaim,
  referee: ClosedBodyReferee | undefined,
  label?: string,
) {
  const board = await boardOf(`${file}#${from}`, `${file}#${to}`, claim, label);
  const report = checkDrift(board, fakeWorkspace({ [file]: source }), {
    edges: true, ...(referee ? { closedBodyReferee: referee } : {}),
  });
  const red = report.edges.find((edge) => ACCUSING_EDGE_KINDS.includes(edge.kind));
  return { report, red, wrongKind: report.edges.find((edge) => edge.kind === "end-lacks-part") };
}

const TS = {
  file: "src/router.ts",
  source: [
    "export interface Router<T> {",
    "  add(method: string, path: string, handler: T): void;",
    "  match(method: string, path: string): T[];",
    "}",
    "",
    "export class SmartRouter<T> implements Router<T> {",
    "  add(method: string, path: string, handler: T): void {}",
    "  match(method: string, path: string): T[] { return []; }",
    "}",
    "",
    "export interface Context<T> { schema: T }",
    "",
    "export function process<T>(ctx: T, schema: T): void {}",
    "",
    "export function helper(): void {}",
    "",
    "export class Holder<T> { item: T | undefined; }",
    "",
    "export class Service<T> {",
    "  constructor(readonly value: T) {}",
    "}",
    "",
    "export interface Handler<T> { (request: T): void }",
    "",
    "export class Svc {",
    "  onError: (error: Error) => void = () => {};",
    "  run(): void { this.onError(new Error('x')); }",
    "}",
    "",
    "export interface Cfg { name: string }",
    "export function Cfg(): Cfg { return { name: '' }; }",
    "",
  ].join("\n"),
};

const PY = {
  file: "src/router.py",
  source: [
    "from typing import Generic, Protocol, TypeVar",
    "",
    "T = TypeVar(\"T\")",
    "",
    "",
    "class Router(Protocol[T]):",
    "    def add(self, method: str, path: str, handler: T) -> None: ...",
    "    def match(self, method: str, path: str) -> list[T]: ...",
    "",
    "",
    "class SmartRouter(Router[T]):",
    "    def add(self, method: str, path: str, handler: T) -> None:",
    "        pass",
    "",
    "    def match(self, method: str, path: str) -> list[T]:",
    "        return []",
    "",
    "",
    "class Context(Generic[T]):",
    "    schema: T",
    "",
    "",
    "def process(ctx: T, schema: T) -> None:",
    "    pass",
    "",
    "",
    "def helper() -> None:",
    "    pass",
    "",
    "",
    "class Holder(Generic[T]):",
    "    item: T",
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

const RS = {
  file: "src/lib.rs",
  source: [
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
      it.each([
        ["ts", TS], ["python", PY], ["rust", RS],
      ] as const)("@holds into a type, a field typed by a type parameter, in %s", async (_language, { file, source }) => {
        const { red } = await check(file, source, "Holder", "Context", "holds", referee);
        expect(red).toBeUndefined();
      });

      it.each([
        ["ts", TS], ["python", PY], ["rust", RS],
      ] as const)("@takes from a type into a generic function, in %s", async (_language, { file, source }) => {
        const { red } = await check(file, source, "Context", "process", "takes", referee);
        expect(red).toBeUndefined();
      });

      it("@takes into a class whose constructor the reader read, in TypeScript", async () => {
        // The signature reader reads `Service`'s constructor; the kind check does not overrule it about that end.
        const { red } = await check(TS.file, TS.source, "Context", "Service", "takes", referee);
        expect(red).toBeUndefined();
      });

      it("@takes into a callable interface, in TypeScript", async () => {
        const { red } = await check(TS.file, TS.source, "Context", "Handler", "takes", referee);
        expect(red).toBeUndefined();
      });

      it("@takes into a callable class, in Python", async () => {
        const { red } = await check(PY.file, PY.source, "Context", "Handler", "takes", referee);
        expect(red).toBeUndefined();
      });

      it("@returns from a type into a property, in Python", async () => {
        const { red } = await check(PY.file, PY.source, "Context", "Q.session", "returns", referee);
        expect(red).toBeUndefined();
      });

      it("@calls a property, in Python", async () => {
        const { wrongKind } = await check(PY.file, PY.source, "BaseHandler.get_response", "Q.session", "calls", referee);
        expect(wrongKind).toBeUndefined();
      });

      it("@calls a field that holds a function and is called (django's _middleware_chain), in Python", async () => {
        const { red } = await check(
          PY.file, PY.source, "BaseHandler.get_response", "BaseHandler._middleware_chain", "calls", referee,
        );
        expect(red).toBeUndefined();
      });

      it("@calls a callable class, in Python", async () => {
        const { wrongKind } = await check(PY.file, PY.source, "BaseHandler.get_response", "Handler", "calls", referee);
        expect(wrongKind).toBeUndefined();
      });

      it("@calls a fn-pointer field, in Rust", async () => {
        const { red } = await check(RS.file, RS.source, "Service.run", "Service.handler", "calls", referee);
        expect(red).toBeUndefined();
      });

      it("@calls a field typed as a function, in TypeScript", async () => {
        const { red } = await check(TS.file, TS.source, "Svc.run", "Svc.onError", "calls", referee);
        expect(red).toBeUndefined();
      });

      it.each([
        ["ts", TS, "Cfg"], ["python", PY, "Cfg"], ["rust", RS, "Thing"],
      ] as const)("@takes from a name declared twice, one of them a type, in %s", async (_language, { file, source }, name) => {
        const { red } = await check(file, source, name, "process", "takes", referee);
        expect(red).toBeUndefined();
      });
    });
  }
});

/* ---------------------------------------------------------------- the reds */

describe("a wrong kind of end the withdrawn red hid", () => {
  for (const [how, referee] of WITHDRAWN) {
    describe(`with ${how}`, () => {
      it.each([
        ["ts", TS], ["python", PY],
      ] as const)("@conforms into a method is red in %s", async (_language, { file, source }) => {
        const { wrongKind, report } = await check(file, source, "SmartRouter", "Router.match", "conforms", referee);
        expect(wrongKind?.detail).toContain("cannot be implemented");
        expect(report.unconfirmedEdges).toEqual([]);
      });

      it.each([
        ["ts", TS], ["python", PY], ["rust", RS],
      ] as const)("@takes from a function is red in %s", async (_language, { file, source }) => {
        const { wrongKind, report } = await check(file, source, "helper", "process", "takes", referee);
        expect(wrongKind?.detail).toContain("a function is not a type");
        expect(report.unconfirmedEdges).toEqual([]);
      });

      it.each([
        ["ts", TS, "Router.match"], ["python", PY, "Router.match"], ["rust", RS, "Router::find"],
      ] as const)("@holds into a method is red in %s", async (_language, { file, source }, method) => {
        const { wrongKind, report } = await check(file, source, "Holder", method, "holds", referee);
        expect(wrongKind?.detail).toContain("is not a type");
        expect(report.unconfirmedEdges).toEqual([]);
      });
    });
  }
});
