/**
 * TypeScript the bundled grammar misreads is read as TypeScript reads it
 * (#462).
 *
 * Three pieces of ordinary TypeScript made tree-sitter-typescript skip part of
 * a file: variance markers (`interface ZodType<out Output>`), a generic call
 * signature on a line of its own inside an interface (zx's `Shell`, hono's
 * `Context`, MobX's factories), and `export type * from`. The skipped part was
 * blanked as unread, and an unread line anywhere in a file withholds every
 * "it has none" about the file: a wrong arrow out of it was never caught and a
 * correct one never confirmed.
 *
 * The refusals come first: syntax the rewrite does not know must still stay
 * unread, text in strings and comments is never touched, and a block's
 * statements are never split.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, createWorkspace, type DriftReport } from "../src/engine/drift";
import { incomplete, initEngine, parseSource, resetEngineCache } from "../src/engine/parse";
import { refereedCheckLive } from "../src/engine/referee-live";
import { rewriteKnownSyntax } from "../src/engine/rewrite";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

let repo: string;

function write(files: Record<string, string>): void {
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(repo, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

/** One arrow, checked with the compilers live (as the MCP server does) or with none. */
async function checked(fromRef: string, toRef: string, claim: string, compilers: boolean): Promise<DriftReport> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: "tail", ref: fromRef },
      { id: "head", label: "head", ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim: claim as never }],
  });
  const workspace = createWorkspace(repo);
  if (!compilers) return checkDrift(board as BoardFile, workspace, { edges: true });
  const live = await refereedCheckLive(repo, (referee) =>
    checkDrift(board as BoardFile, workspace, { edges: true, ...(referee ? { closedBodyReferee: referee } : {}) }));
  return live.report;
}

/** What a person sees on the arrow: red, green, or not sure. */
function outcome(report: DriftReport): "red" | "green" | "not sure" {
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return "red";
  if (report.edges.length || report.unconfirmedEdges.length || report.unreadEdges.length || report.garbledClaims.length) return "not sure";
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmed = Object.entries(tally).filter(([name]) => name.endsWith("Confirmed"))
    .reduce((sum, [, value]) => sum + Number(value ?? 0), 0);
  // A `needs` held up has no "Confirmed" count of its own: it is checked and nothing withheld it.
  const needsHeld = Number(tally.needsChecked ?? 0) > 0 && !Object.keys(tally.needsWithheld as object).length;
  return confirmed > 0 || needsHeld ? "green" : "not sure";
}

/** Why an arrow is not sure: the reason it was left unconfirmed, or what withheld it. */
function why(report: DriftReport): string[] {
  const tally = report.claims as unknown as Record<string, unknown>;
  const withheld = Object.entries(tally)
    .filter(([name, value]) => name.endsWith("Withheld") && value && typeof value === "object" && !Array.isArray(value))
    .flatMap(([, value]) => Object.keys(value as object));
  return [...report.unconfirmedEdges.map((edge) => String((edge as { reason?: string }).reason)), ...withheld];
}

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  repo = mkdtempSync(path.join(tmpdir(), "ts-parse-gaps-"));
  resetEngineCache();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const TSCONFIG = { "tsconfig.json": "{ \"compilerOptions\": { \"strict\": true, \"target\": \"es2022\" } }\n" };

/** Whether this text reads whole: parsed, and nothing in it left unread. */
function readsWhole(text: string, language: "ts" | "tsx" = "ts"): boolean {
  return !incomplete(parseSource(text, language)!.rootNode);
}

/** The rewrite of `text`, checked to keep every offset and line where it was. */
function rewritten(text: string): string | undefined {
  const out = rewriteKnownSyntax(text);
  if (out !== undefined) {
    expect(out.length).toBe(text.length);
    expect(out.split("\n").map((line) => line.length)).toEqual(text.split("\n").map((line) => line.length));
  }
  return out;
}

/* ------------------------------------------------------------- refusals */

describe("refusals: what the rewrite does not know stays unread", () => {
  it("leaves a file that still does not parse unread, variance or not", () => {
    // `import('x').T` in a type is a fourth thing the grammar misreads, and no rewrite knows it.
    const text = [
      "export interface Box<out T> { value: T }",
      "export interface Parsed { ast?: import('@babel/types').Statement[] }",
      "export function open(): number { return 1; }",
      "",
    ].join("\n");
    expect(readsWhole(text)).toBe(false);
  });

  it("does not touch strings or comments", () => {
    const text = [
      "// interface Old<out T> {",
      "const doc = 'interface Box<in out T> { }';",
      "/* export type * from './gone' */",
      "export const x = 1;",
      "",
    ].join("\n");
    expect(rewritten(text)).toBeUndefined();
  });

  it("keeps a type parameter named out", () => {
    for (const text of ["type A<out> = out;", "type A<out extends string> = out;", "type A<in out> = out;"]) {
      const out = rewritten(text);
      expect(out?.includes("out>") || out?.includes("out extends") || out === undefined, text).toBe(true);
      expect((out ?? text).match(/\bout\b/g)!.length, text).toBe(2);
    }
  });

  it("never splits a statement in a block, even before a line that opens with <", () => {
    const text = [
      "export function f(a: number, T: number, b: number): boolean {",
      "  const c = a",
      "    <T",
      "  return c > b",
      "}",
      "",
    ].join("\n");
    expect(rewritten(text)).toBeUndefined();
  });

  it("does not split a call signature from a line that leaves its type open", () => {
    const text = [
      "export interface F {",
      "  pick: A |",
      "    <T>(x: T): T",
      "}",
      "",
    ].join("\n");
    expect(rewritten(text)).toBeUndefined();
  });
});

/* -------------------------------------------------------- what it reads */

describe("the three pieces of syntax read whole", () => {
  it("variance markers on a class, an interface and a type alias", () => {
    const text = [
      "export interface ZodType<out Output = unknown, in out Input = unknown> { _o: Output; _i: Input }",
      "export class Elysia<",
      "  const in out BasePath extends string = '',",
      "  in out Routes = {},",
      "> { base?: BasePath; routes?: Routes; group(): number { return 1; } }",
      "export type Prettify<in out T> = { [K in keyof T]: T[K] } & {};",
      "",
    ].join("\n");
    const out = rewritten(text)!;
    expect(out).not.toMatch(/\b(in out|out Output|in out Input)\b/);
    expect(out).toContain("const        BasePath");
    expect(out).toContain("[K in keyof T]");
    expect(readsWhole(text)).toBe(true);
  });

  it("a generic call signature on a line of its own, in an interface and in a type literal", () => {
    const text = [
      "export interface Shell<S = false, R = S extends true ? string : number> {",
      "  (pieces: TemplateStringsArray, ...args: any[]): R",
      "  <O extends object = {}, R = O extends { sync: true } ? Shell<true> : Shell>(opts: O): R",
      "  sync: {",
      "    (pieces: TemplateStringsArray, ...args: any[]): string",
      "    <D>(dest: D): D",
      "  }",
      "}",
      "export interface Factory {",
      "  // nameless actions",
      "  <T extends Function | undefined>(fn: T): T",
      "  // named actions",
      "  <T extends Function | undefined>(name: string, fn: T): T",
      "}",
      "export function fetch(url: string): Promise<string> & {",
      "  pipe: {",
      "    (dest: TemplateStringsArray): string",
      "    <D>(dest: D): D",
      "  }",
      "} {",
      "  return Object.assign(Promise.resolve(url), { pipe: (d: unknown) => d }) as never",
      "}",
      "",
    ].join("\n");
    expect(rewritten(text)!.match(/;</g)!.length).toBe(4);
    expect(readsWhole(text)).toBe(true);
  });

  it("export type * from", () => {
    const text = "export type * from './types';\nexport type * as Terser from 'terser';\nexport const x = 1;\n";
    expect(rewritten(text)).toBe("export      * from './types';\nexport      * as Terser from 'terser';\nexport const x = 1;\n");
    expect(readsWhole(text)).toBe(true);
  });

  it("leaves a file that parses as it was", () => {
    // A call signature after a `;` already parses; the rewrite runs only on a file that does not.
    const text = "export interface G { (a: string): void; <T>(b: T): T }\n";
    expect(readsWhole(text)).toBe(true);
  });
});

/* --------------------------------------------- arrows, both directions */

/** zx: a file whose `Shell` interface the grammar could not read. */
const ZX = {
  ...TSCONFIG,
  "util.ts": "export type Duration = number | `${number}ms`\nexport function parse(d: Duration): number { return Number(d) }\n",
  "core.ts": [
    "import { type Duration } from './util'",
    "export interface Shell<",
    "  S = false,",
    "  R = S extends true ? string : number,",
    "> {",
    "  (pieces: TemplateStringsArray, ...args: any[]): R",
    "  <O extends object = {}, R = O extends { sync: true } ? Shell<true> : Shell>(opts: O): R",
    "  sync: {",
    "    (pieces: TemplateStringsArray, ...args: any[]): string",
    "    (opts: object): Shell<true>",
    "  }",
    "}",
    "export class Snapshot { at = 0 }",
    "export class ProcessPromise extends Promise<string> {",
    "  snapshot?: Snapshot",
    "}",
    "export function sleep(duration: Duration): Promise<void> {",
    "  return new Promise((resolve) => setTimeout(resolve, Number(duration)))",
    "}",
    "export function tempfile(name?: string): string {",
    "  return name ?? 'tmp'",
    "}",
    "",
  ].join("\n"),
  "index.ts": "export * from './core'\n",
};

/** elysia: variance markers on a class's type parameters. */
const ELYSIA = {
  ...TSCONFIG,
  "elysia.ts": [
    "export class Router { add(path: string): number { return path.length } }",
    "export class Elysia<",
    "  const in out BasePath extends string = '',",
    "  in out Routes = {},",
    "> {",
    "  router?: Router",
    "  base?: BasePath",
    "  routes?: Routes",
    "}",
    "",
  ].join("\n"),
  "other.ts": "export const unrelated = 1\n",
};

/** The same zx file with one more line nobody can read: everything about the file stays withheld. */
const ZX_STILL_BROKEN = {
  ...ZX,
  "core.ts": ZX["core.ts"].replace(
    "export class Snapshot",
    "export interface Parsed { ast?: import('@babel/types').Statement[] }\nexport class Snapshot",
  ),
};

for (const compilers of [true, false]) {
  const mode = compilers ? "compilers on" : "compilers off";

  describe(`arrows touching a file the grammar misread (${mode})`, () => {
    it("catches a wrong takes, and confirms the correct one", async () => {
      write(ZX);
      expect(outcome(await checked("util.ts#Duration", "core.ts#tempfile", "takes", compilers))).toBe("red");
      expect(outcome(await checked("util.ts#Duration", "core.ts#sleep", "takes", compilers))).toBe("green");
    }, 180_000);

    it("catches a wrong conforms, and confirms the correct holds", async () => {
      write(ZX);
      const conforms = await checked("core.ts#ProcessPromise", "core.ts#Snapshot", "conforms", compilers);
      // A class may fit a type it never names; only a compiler can say it does not, so with none it stays not sure, read.
      if (compilers) expect(outcome(conforms)).toBe("red");
      else expect(why(conforms)).toEqual(["rests-on-unwritten"]);
      expect(outcome(await checked("core.ts#ProcessPromise", "core.ts#Snapshot", "holds", compilers))).toBe("green");
    }, 180_000);

    it("catches a wrong needs out of the file, and confirms the correct one", async () => {
      write(ZX);
      expect(outcome(await checked("core.ts", "index.ts", "needs", compilers))).toBe("red");
      expect(outcome(await checked("index.ts", "core.ts", "needs", compilers))).toBe("green");
    }, 180_000);

    it("reads a class with variance markers: holds confirmed, a wrong needs caught", async () => {
      write(ELYSIA);
      expect(outcome(await checked("elysia.ts#Elysia", "elysia.ts#Router", "holds", compilers))).toBe("green");
      const conforms = await checked("elysia.ts#Elysia", "elysia.ts#Router", "conforms", compilers);
      if (compilers) expect(outcome(conforms)).toBe("red");
      else expect(why(conforms)).toEqual(["rests-on-unwritten"]);
      expect(outcome(await checked("elysia.ts", "other.ts", "needs", compilers))).toBe("red");
    }, 180_000);

    it("refusal: with a line still unread in the file, the wrong arrows stay not sure", async () => {
      write(ZX_STILL_BROKEN);
      expect(outcome(await checked("util.ts#Duration", "core.ts#tempfile", "takes", compilers))).toBe("not sure");
      const conforms = await checked("core.ts#ProcessPromise", "core.ts#Snapshot", "conforms", compilers);
      expect(outcome(conforms)).toBe("not sure");
      expect(why(conforms)).toContain("incomplete");
      expect(outcome(await checked("core.ts", "index.ts", "needs", compilers))).toBe("not sure");
    }, 180_000);
  });
}
