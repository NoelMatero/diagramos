/**
 * Two ends that are plainly the wrong kind of thing, which the kind check
 * (`parts.ts`) never asked about (missed map 2026-11b, pattern 1a and 1b).
 *
 * **`@feeds` into a type or a plain value.** "`parse_long_arg` feeds
 * `ArgMatcher`" says parse_long_arg's result is handed to ArgMatcher, and
 * `ArgMatcher` is a struct: nothing hands a value to a struct, a value is
 * handed to a function. The kind check asked `@feeds` only for a result at
 * its start and nothing at its end, so with no flow found the arrow stayed
 * "not sure" for ever: 15 wrong arrows on the three study sets, in 10
 * projects and all three languages. The end now needs what `@takes` asks of
 * its function: parameters.
 *
 * A class whose construction is handed the value is what the `@feeds` reader
 * confirms first (`Buffer(receive(c))`, a Rust tuple struct the same), so
 * that arrow stays green; this is asked only after every reader came back
 * empty.
 *
 * **`@calls`, `@builds` or `@accesses` out of a TypeScript interface.** An
 * interface is erased when TypeScript compiles: nothing in one runs, however
 * many method signatures and function-typed fields it declares. The kind
 * check read those signatures as code (they carry parameters), so
 * "`PackageManager` calls `latest`" stayed "not sure" -- 9 wrong arrows in 5
 * projects. An interface declared beside a class, a function, a constant or a
 * namespace of the same name (TypeScript merges them, and zod writes one
 * beside its constant) is read through the other declaration, which may run.
 *
 * Tests per shape and per language, and the refusals first: an end that may
 * still run, or take a value, must stay as it was.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, type DriftReport, type Workspace } from "../src/engine/drift";
import { initEngine } from "../src/engine/parse";
import type { ArrowClaim } from "../src/engine/claim";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 60_000);

const ACCUSES = new Set<string>(ACCUSING_EDGE_KINDS);

/** A workspace over these files that can also be listed, which `@feeds` needs to find the wiring. */
function fakeWorkspace(files: Record<string, string>): Workspace {
  const norm = (target: string) => {
    const trimmed = target.replace(/^\.\//, "");
    return trimmed === "" || trimmed === "." ? "." : trimmed;
  };
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : norm(relative)),
    stat: (target) => {
      const at = norm(target);
      if (at === ".") return "directory";
      if (files[at] !== undefined) return "file";
      return Object.keys(files).some((file) => file.startsWith(`${at}/`)) ? "directory" : "missing";
    },
    read: (target) => files[norm(target)] ?? "",
    list: (target) => {
      const at = norm(target);
      const prefix = at === "." ? "" : `${at}/`;
      const names = new Set<string>();
      for (const file of Object.keys(files)) {
        if (file.startsWith(prefix)) names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

type Said = "red" | "green" | "quiet";

/** One arrow on its own board, checked from the text: green, red, or neither. */
async function said(
  files: Record<string, string>,
  fromRef: string,
  toRef: string,
  claim: ArrowClaim,
  label?: string,
): Promise<{ said: Said; report: DriftReport }> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: fromRef.split("#")[1] ?? fromRef, ref: fromRef },
      { id: "head", label: toRef.split("#")[1] ?? toRef, ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim, ...(label ? { label } : {}) }],
  });
  const report = checkDrift(board as BoardFile, fakeWorkspace(files), { edges: true });
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return { said: "red", report };
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmed = Object.entries(tally).some(([name, value]) => name.endsWith("Confirmed") && Number(value) > 0);
  return { said: confirmed ? "green" : "quiet", report };
}

const wrongKind = (report: DriftReport) => report.edges.find((finding) => finding.kind === "end-lacks-part");

/* --------------------------------------------------- @feeds into a type (1b) */

/**
 * In each language: a type, a function that makes a value, a function that
 * takes one, a plain constant, a value holding a function, and a type alias
 * of a function type. `produce` feeds `consume` nowhere, so no reader
 * confirms anything and the kind check is the only thing left to speak.
 */
const FEEDS: Record<string, { file: string; source: string }> = {
  rust: {
    file: "src/lib.rs",
    source: [
      "pub struct Matcher {",
      "    pub seen: Vec<u8>,",
      "}",
      "",
      "pub enum Strategy {",
      "    Literal,",
      "    Regex,",
      "}",
      "",
      "pub static LIMIT: usize = 4;",
      "pub static ON_DATA: fn(Vec<u8>) = consume;",
      "pub type Handler = fn(Vec<u8>);",
      "",
      "pub fn produce() -> Vec<u8> {",
      "    vec![1]",
      "}",
      "",
      "pub fn consume(bytes: Vec<u8>) {}",
      "",
    ].join("\n"),
  },
  python: {
    file: "src/matcher.py",
    source: [
      "from typing import Callable, TypeAlias",
      "",
      "class Matcher:",
      "    seen: bytes = b\"\"",
      "",
      "LIMIT: int = 4",
      "on_data: Callable[[bytes], None] = print",
      "Handler: TypeAlias = Callable[[bytes], None]",
      "",
      "def produce() -> bytes:",
      "    return b\"1\"",
      "",
      "def consume(data: bytes) -> None:",
      "    pass",
      "",
    ].join("\n"),
  },
  ts: {
    file: "src/matcher.ts",
    source: [
      "export class Matcher {",
      "  seen: Uint8Array = new Uint8Array();",
      "}",
      "",
      "export interface Strategy {",
      "  kind: string;",
      "}",
      "",
      "export const LIMIT: number = 4;",
      "export const onData: (data: Uint8Array) => void = consume;",
      "export type Handler = (data: Uint8Array) => void;",
      "",
      "export function produce(): Uint8Array {",
      "  return new Uint8Array();",
      "}",
      "",
      "export function consume(data: Uint8Array): void {}",
      "",
    ].join("\n"),
  },
};
const FEED_LANGUAGES = Object.keys(FEEDS);

/** The name each language gives the value that holds a function, and the alias. */
const CALLABLE_VALUE: Record<string, string> = { rust: "ON_DATA", python: "on_data", ts: "onData" };

describe("@feeds into something that can take a value is left alone", () => {
  it.each(FEED_LANGUAGES)("says nothing about a function at the end in %s", async (language) => {
    const { file, source } = FEEDS[language]!;
    const { report } = await said({ [file]: source }, `${file}#produce`, `${file}#consume`, "feeds");
    expect(wrongKind(report)).toBeUndefined();
  });

  it.each(FEED_LANGUAGES)("says nothing about a value holding a function in %s", async (language) => {
    // A field or a constant typed as a function is called all day long, and a
    // value handed to it has been fed to it.
    const { file, source } = FEEDS[language]!;
    const { report } = await said({ [file]: source }, `${file}#produce`, `${file}#${CALLABLE_VALUE[language]}`, "feeds");
    expect(wrongKind(report)).toBeUndefined();
  });

  it.each(FEED_LANGUAGES)("says nothing about a type alias in %s", async (language) => {
    // `type Handler = fn(..)` may be drawn for every function of that type;
    // nothing here follows an alias.
    const { file, source } = FEEDS[language]!;
    const { report } = await said({ [file]: source }, `${file}#produce`, `${file}#Handler`, "feeds");
    expect(wrongKind(report)).toBeUndefined();
  });

  it("stays green where the class is made with the value, in Python", async () => {
    const file = "src/matcher.py";
    const source = `${FEEDS.python!.source}\ndef run():\n    return Matcher(produce())\n`;
    const result = await said({ [file]: source }, `${file}#produce`, `${file}#Matcher`, "feeds");
    expect(result.said).toBe("green");
  });

  it("stays green where a Rust tuple struct is made with the value", async () => {
    const file = "src/lib.rs";
    const source = `${FEEDS.rust!.source}\npub struct Wrapped(pub Vec<u8>);\n\npub fn run() -> Wrapped {\n    Wrapped(produce())\n}\n`;
    const result = await said({ [file]: source }, `${file}#produce`, `${file}#Wrapped`, "feeds");
    expect(result.said).toBe("green");
  });
});

describe("@feeds into a type is red", () => {
  it.each(FEED_LANGUAGES)("for a class or a struct in %s", async (language) => {
    const { file, source } = FEEDS[language]!;
    const { said: verdict, report } = await said({ [file]: source }, `${file}#produce`, `${file}#Matcher`, "feeds");
    expect(verdict).toBe("red");
    expect(wrongKind(report)?.detail).toContain("Matcher");
    expect(wrongKind(report)?.detail).toContain("no parameters");
    expect(wrongKind(report)?.detail).toContain(language === "rust" ? "a struct" : "a class");
  });

  it.each(["rust", "ts"])("for an enum or an interface in %s", async (language) => {
    const { file, source } = FEEDS[language]!;
    const { said: verdict, report } = await said({ [file]: source }, `${file}#produce`, `${file}#Strategy`, "feeds");
    expect(verdict).toBe("red");
    expect(wrongKind(report)?.detail).toContain(language === "rust" ? "an enum" : "an interface");
  });

  it.each(FEED_LANGUAGES)("for a constant holding a number in %s", async (language) => {
    const { file, source } = FEEDS[language]!;
    const { said: verdict, report } = await said({ [file]: source }, `${file}#produce`, `${file}#LIMIT`, "feeds");
    expect(verdict).toBe("red");
    expect(wrongKind(report)?.detail).toContain("LIMIT");
  });

  it.each(FEED_LANGUAGES)("never for a plan in %s", async (language) => {
    const { file, source } = FEEDS[language]!;
    const { board } = await createDiagram(emptyBoard(), {
      name: "arch",
      nodes: [
        { id: "tail", label: "produce", ref: `${file}#produce` },
        { id: "head", label: "Matcher", ref: `${file}#Matcher` },
      ],
      edges: [{ from: "tail", to: "head", claim: "feeds", state: "planned" }],
    });
    const report = checkDrift(board as BoardFile, fakeWorkspace({ [file]: source }), { edges: true });
    expect(wrongKind(report)).toBeUndefined();
  });
});

/* ------------------------------------------ out of a TypeScript interface (1a) */

const IFACE_FILE = "src/manager.ts";
/**
 * npm-check-updates' shape: an interface of function-typed fields and method
 * signatures, a function it is drawn calling, and a type for `@builds`.
 */
const MANAGER = [
  "export interface Options { global: boolean }",
  "",
  "export interface Manager {",
  "  spawn?: (args: string[], options?: Options) => Promise<string>",
  "  latest(name: string, options: Options): Promise<string>",
  "  usesAddCommand?: boolean",
  "}",
  "",
  "export function latest(name: string, options: Options): Promise<string> {",
  "  return Promise.resolve(name);",
  "}",
  "",
].join("\n");

describe("an interface at the start of the arrow", () => {
  it("is red for @calls: nothing in an interface runs", async () => {
    const result = await said({ [IFACE_FILE]: MANAGER }, `${IFACE_FILE}#Manager`, `${IFACE_FILE}#latest`, "calls");
    expect(result.said).toBe("red");
    expect(wrongKind(result.report)?.detail).toContain("an interface");
    expect(wrongKind(result.report)?.detail).toContain("no body of code that runs");
  });

  it("is red for @builds", async () => {
    const result = await said({ [IFACE_FILE]: MANAGER }, `${IFACE_FILE}#Manager`, `${IFACE_FILE}#Options`, "builds");
    expect(wrongKind(result.report)?.detail).toContain("no body of code that runs");
  });

  it("is red for @accesses", async () => {
    const result = await said({ [IFACE_FILE]: MANAGER }, `${IFACE_FILE}#Manager`, `${IFACE_FILE}#Options`, "accesses", "global");
    expect(wrongKind(result.report)?.detail).toContain("no body of code that runs");
  });

  it("is red for an interface that extends another", async () => {
    // What an interface extends is another interface or a class's type; neither
    // puts code in this one.
    const source = `${MANAGER}export interface Npm extends Manager {\n  view(name: string): string\n}\n`;
    const result = await said({ [IFACE_FILE]: source }, `${IFACE_FILE}#Npm`, `${IFACE_FILE}#latest`, "calls");
    expect(wrongKind(result.report)?.detail).toContain("an interface");
  });
});

describe("an interface that shares its name with something that runs is left alone", () => {
  /*
   * TypeScript merges declarations of one name, and a box anchored at the name
   * means all of them. zod writes `interface $ZodType` beside `const $ZodType =
   * $constructor(...)`; a class or a namespace of the same name has code of
   * its own.
   */
  const merged: Array<[string, string]> = [
    ["a constant", "export const Manager = { latest(name: string) { return latest(name, { global: false }); } };\n"],
    ["a class", "export class Manager { run() { return latest(\"a\", { global: false }); } }\n"],
    ["a function", "export function Manager() { return latest(\"a\", { global: false }); }\n"],
    ["a namespace", "export namespace Manager { export const first = latest(\"a\", { global: false }); }\n"],
  ];

  it.each(merged)("beside %s", async (_shape, extra) => {
    const result = await said({ [IFACE_FILE]: `${MANAGER}${extra}` }, `${IFACE_FILE}#Manager`, `${IFACE_FILE}#latest`, "calls");
    expect(wrongKind(result.report)).toBeUndefined();
  });

  it("inside a declare module block, which adds to a declaration elsewhere", async () => {
    // `declare module "./client" { interface Client { .. } }` widens a class
    // written in another file; a box drawn at it may well mean that class.
    const source = `${MANAGER}declare module "./client" {\n  interface Client {\n    extra(name: string): string\n  }\n}\n`;
    const result = await said({ [IFACE_FILE]: source }, `${IFACE_FILE}#Client`, `${IFACE_FILE}#latest`, "calls");
    expect(wrongKind(result.report)).toBeUndefined();
  });
});

describe("other declarations with signatures and no code keep the reading they had", () => {
  it("an abstract class", async () => {
    // It may inherit, and its concrete methods' code is its own; not this rule.
    const source = `${MANAGER}export abstract class Base {\n  abstract latest(name: string): Promise<string>;\n}\n`;
    const result = await said({ [IFACE_FILE]: source }, `${IFACE_FILE}#Base`, `${IFACE_FILE}#latest`, "calls");
    expect(wrongKind(result.report)).toBeUndefined();
  });

  it("a Python Protocol", async () => {
    const file = "src/manager.py";
    const source = [
      "from typing import Protocol",
      "",
      "class Manager(Protocol):",
      "    def latest(self, name: str) -> str: ...",
      "",
      "def latest(name: str) -> str:",
      "    return name",
      "",
    ].join("\n");
    const result = await said({ [file]: source }, `${file}#Manager`, `${file}#latest`, "calls");
    expect(wrongKind(result.report)).toBeUndefined();
  });
});
