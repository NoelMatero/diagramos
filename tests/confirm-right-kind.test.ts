/**
 * Two ways the checker said yes to an arrow that was wrong, found by the fill
 * study (2026-11, `~/bench-queue/fill-study-2026-11.md`): of 3,917 arrows it
 * confirmed across 123 boards, 93 were wrong, and these two habits were 80 of
 * them.
 *
 * **The end is the wrong kind of thing.** "`Auth` takes `Request`" was green
 * because a method inside the class `Auth` takes one. `takes` and `returns`
 * are about a function's signature, and a class, a trait, an interface or a
 * type alias has none of its own: the reader used to walk into the class and
 * read the first method it found. The same habit confirmed "`Lock` feeds
 * `use`" off `use(Lock())`, and "`Action` calls `Mutation`" where `Action` is
 * a type alias, which runs nothing. Such an arrow is now red where the kind
 * check already has a measured licence to say so (`parts.ts`), and "not
 * sure" where it has none. Never green.
 *
 * **The box's owner was dropped.** A box written `MatchStrategy::new` is read
 * as the plain name `new` (#409), so any `new` in the file could confirm it:
 * "`Glob` returns `MatchStrategy::new`" was green because `Glob::new` returns a
 * `Glob`. When confirming, the owner must match now. The plain reading stays
 * for refuting, so a name whose owner cannot be told apart never goes red on
 * that account: it goes "not sure".
 *
 * A test per shape and per language, and the right-kind and right-owner
 * arrows beside each, which must stay green.
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
async function said(files: Record<string, string>, fromRef: string, toRef: string, claim: ArrowClaim): Promise<{ said: Said; report: DriftReport }> {
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: fromRef.split("#")[1] ?? fromRef, ref: fromRef },
      { id: "head", label: toRef.split("#")[1] ?? toRef, ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim }],
  });
  const report = checkDrift(board as BoardFile, fakeWorkspace(files), { edges: true });
  if (report.edges.some((finding) => ACCUSES.has(finding.kind))) return { said: "red", report };
  const tally = report.claims as unknown as Record<string, unknown>;
  const confirmed = Object.entries(tally).some(([name, value]) => name.endsWith("Confirmed") && Number(value) > 0);
  return { said: confirmed ? "green" : "quiet", report };
}

const wrongKind = (report: DriftReport) => report.edges.find((finding) => finding.kind === "end-lacks-part");

/* ------------------------------------------------------------ the wrong kind */

/**
 * A type `Request`, and three things that are not functions but have one
 * inside them whose signature names it: a class with a constructor and a
 * method, an interface or trait with a method, and a function at the top for
 * the arrow that is right.
 */
const KINDS: Record<string, { file: string; source: string; container: string; contract: string; fn: string }> = {
  python: {
    file: "src/auth.py",
    container: "Auth",
    contract: "Flow",
    fn: "send",
    source: [
      "from typing import Protocol",
      "",
      "class Request:",
      "    url: str = \"\"",
      "",
      "class Response:",
      "    status: int = 0",
      "",
      "class Auth:",
      "    def __init__(self, request: Request) -> None:",
      "        self.request = request",
      "",
      "    def auth_flow(self, request: Request) -> Response:",
      "        return Response()",
      "",
      "class Flow(Protocol):",
      "    def handle(self, request: Request) -> Response: ...",
      "",
      "def send(request: Request) -> Response:",
      "    return Response()",
      "",
    ].join("\n"),
  },
  ts: {
    file: "src/auth.ts",
    container: "Auth",
    contract: "Flow",
    fn: "send",
    source: [
      "export class Request { url = \"\"; }",
      "export class Response { status = 0; }",
      "",
      "export class Auth {",
      "  constructor(private request: Request) {}",
      "  authFlow(request: Request): Response { return new Response(); }",
      "}",
      "",
      "export interface Flow {",
      "  handle(request: Request): Response;",
      "}",
      "",
      "export function send(request: Request): Response { return new Response(); }",
      "",
    ].join("\n"),
  },
  rust: {
    file: "src/auth.rs",
    container: "Table",
    contract: "Flow",
    fn: "send",
    source: [
      "pub struct Request { pub url: String }",
      "pub struct Response { pub status: u16 }",
      "",
      "/// A struct of function pointers: its fields take a Request, it takes nothing.",
      "pub struct Table {",
      "    pub run: fn(&Request) -> Response,",
      "}",
      "",
      "pub trait Flow {",
      "    fn handle(&self, request: &Request) -> Response;",
      "}",
      "",
      "pub fn send(request: &Request) -> Response { Response { status: request.url.len() as u16 } }",
      "",
    ].join("\n"),
  },
};

const KIND_LANGUAGES = Object.keys(KINDS);

describe("@takes and @returns into a class whose methods name the type", () => {
  it.each(KIND_LANGUAGES)("is red in %s for @takes, never green", async (language) => {
    const { file, source, container } = KINDS[language]!;
    const { said: answer, report } = await said({ [file]: source }, `${file}#Request`, `${file}#${container}`, "takes");
    expect(answer).toBe("red");
    expect(wrongKind(report)?.detail).toContain("no parameters or return type");
  });

  it.each(KIND_LANGUAGES)("is red in %s for @returns, never green", async (language) => {
    const { file, source, container } = KINDS[language]!;
    const { said: answer, report } = await said({ [file]: source }, `${file}#Response`, `${file}#${container}`, "returns");
    expect(answer).toBe("red");
    expect(wrongKind(report)?.detail).toContain("no parameters or return type");
  });
});

describe("@takes and @returns into an interface, a protocol or a trait", () => {
  it.each(KIND_LANGUAGES)("is red in %s for @takes", async (language) => {
    const { file, source, contract } = KINDS[language]!;
    const { said: answer, report } = await said({ [file]: source }, `${file}#Request`, `${file}#${contract}`, "takes");
    expect(answer).toBe("red");
    expect(wrongKind(report)).toBeDefined();
  });

  it.each(KIND_LANGUAGES)("is red in %s for @returns", async (language) => {
    const { file, source, contract } = KINDS[language]!;
    const { said: answer } = await said({ [file]: source }, `${file}#Response`, `${file}#${contract}`, "returns");
    expect(answer).toBe("red");
  });
});

describe("the function those arrows should have pointed at", () => {
  it.each(KIND_LANGUAGES)("stays green in %s for @takes and @returns", async (language) => {
    const { file, source, fn } = KINDS[language]!;
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#${fn}`, "takes")).said).toBe("green");
    expect((await said({ [file]: source }, `${file}#Response`, `${file}#${fn}`, "returns")).said).toBe("green");
  });

  it("stays green at a method inside the class, written Class.method", async () => {
    const { file, source } = KINDS.python!;
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#Auth.auth_flow`, "takes")).said).toBe("green");
    const ts = KINDS.ts!;
    expect((await said({ [ts.file]: ts.source }, `${ts.file}#Request`, `${ts.file}#Auth.authFlow`, "takes")).said).toBe("green");
  });

  it("stays green at a function written as a value", async () => {
    const file = "src/handlers.ts";
    const source = [
      "export class Request { url = \"\"; }",
      "export const handle = (request: Request): void => { void request; };",
      "export const wrapped = Object.freeze(function inner(request: Request): void { void request; });",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#handle`, "takes")).said).toBe("green");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#wrapped`, "takes")).said).toBe("green");
  });

  it("stays green at a decorated Python function", async () => {
    const file = "src/views.py";
    const source = [
      "import functools",
      "",
      "class Request:",
      "    pass",
      "",
      "@functools.lru_cache",
      "def view(request: Request) -> None:",
      "    pass",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#view`, "takes")).said).toBe("green");
  });
});

describe("a class written as a value is not read as its constructor", () => {
  it("is not green in TypeScript", async () => {
    const file = "src/auth.ts";
    const source = [
      "export class Request { url = \"\"; }",
      "export const Auth = class {",
      "  constructor(private request: Request) {}",
      "};",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#Auth`, "takes")).said).not.toBe("green");
  });
});

describe("@takes into a type alias of a function type", () => {
  /*
   * `type Handler = (request: Request) => void` names the parameter -- but the
   * alias is a type, not something that runs, and nothing measured lets the
   * kind check call an alias the wrong kind (it may name a function type).
   * So neither colour: not green, not red.
   */
  it("is neither green nor red in TypeScript", async () => {
    const file = "src/types.ts";
    const source = [
      "export class Request { url = \"\"; }",
      "export type Handler = (request: Request) => void;",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#Handler`, "takes")).said).toBe("quiet");
  });

  it("is neither green nor red in Rust", async () => {
    const file = "src/types.rs";
    const source = [
      "pub struct Request;",
      "pub type Handler = fn(&Request);",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Request`, `${file}#Handler`, "takes")).said).toBe("quiet");
  });
});

describe("@feeds from a class that is constructed and handed on", () => {
  /*
   * `use(Lock())` hands a new Lock to `use`, and the feeds reader matched the
   * call `Lock()` as though `Lock` were a function producing a result. A class
   * has no result; the arrow means `@takes` (or `@builds`) and is red.
   */
  const FEEDS: Record<string, { file: string; source: string }> = {
    python: {
      file: "src/sync.py",
      source: [
        "class Lock:",
        "    pass",
        "",
        "def make() -> Lock:",
        "    return Lock()",
        "",
        "def use(lock: Lock) -> None:",
        "    pass",
        "",
        "def main() -> None:",
        "    use(Lock())",
        "    use(make())",
        "",
      ].join("\n"),
    },
    rust: {
      file: "src/sync.rs",
      source: [
        "pub struct Lock(pub u8);",
        "",
        "pub fn make() -> Lock { Lock(0) }",
        "",
        "pub fn take(lock: Lock) {}",
        "",
        "pub fn main() {",
        "    take(Lock(1));",
        "    take(make());",
        "}",
        "",
      ].join("\n"),
    },
  };

  it.each(Object.keys(FEEDS))("is red in %s, never green", async (language) => {
    const { file, source } = FEEDS[language]!;
    const head = language === "rust" ? "take" : "use";
    const { said: answer, report } = await said({ [file]: source }, `${file}#Lock`, `${file}#${head}`, "feeds");
    expect(answer).toBe("red");
    expect(wrongKind(report)?.detail).toContain("no result");
  });

  it.each(Object.keys(FEEDS))("stays green in %s from the function that makes one", async (language) => {
    const { file, source } = FEEDS[language]!;
    const head = language === "rust" ? "take" : "use";
    expect((await said({ [file]: source }, `${file}#make`, `${file}#${head}`, "feeds")).said).toBe("green");
  });
});

describe("@calls from a type alias", () => {
  /*
   * TanStack's `Action` is a union of action interfaces, and "`Action` calls
   * `Mutation`" was green. An alias runs nothing. Whether it is the wrong
   * kind of end is not something the kind check is licensed to say about an
   * alias (it may stand for a function type), so: not sure.
   */
  it("is neither green nor red in TypeScript", async () => {
    const file = "src/mutation.ts";
    const source = [
      "interface Pending { type: 'pending' }",
      "interface Failed { type: 'failed' }",
      "export type Action = Pending | Failed;",
      "",
      "export class Mutation {",
      "  state = 0;",
      "  dispatch(action: Action): void {",
      "    const reducer = (state: number): number => state + 1;",
      "    this.state = reducer(this.state);",
      "  }",
      "}",
      "",
    ].join("\n");
    expect((await said({ [file]: source }, `${file}#Action`, `${file}#Mutation`, "calls")).said).toBe("quiet");
  });
});

/* -------------------------------------------------------------- the owner */

/**
 * Two types in one file with a method of the same name each, and a free
 * function: `Policy.redirect` calls `helper`, `Tower.redirect` does not;
 * `Policy.check` calls its own `redirect`; the two `redirect`s take and
 * return different things.
 */
const OWNERS: Record<string, { file: string; source: string; sep: string }> = {
  python: {
    file: "src/redirect.py",
    sep: ".",
    source: [
      "class Attempt:",
      "    pass",
      "",
      "class Action:",
      "    pass",
      "",
      "def helper() -> None:",
      "    pass",
      "",
      "class Policy:",
      "    def redirect(self, attempt: Attempt) -> Action:",
      "        helper()",
      "        return Action()",
      "",
      "    def check(self) -> Action:",
      "        return self.redirect(Attempt())",
      "",
      "class Tower:",
      "    def redirect(self, code: int) -> int:",
      "        return code",
      "",
    ].join("\n"),
  },
  ts: {
    file: "src/redirect.ts",
    sep: ".",
    source: [
      "export class Attempt { n = 0; }",
      "export class Action { n = 0; }",
      "",
      "export function helper(): void {}",
      "",
      "export class Policy {",
      "  redirect(attempt: Attempt): Action {",
      "    helper();",
      "    return new Action();",
      "  }",
      "  check(): Action {",
      "    return this.redirect(new Attempt());",
      "  }",
      "}",
      "",
      "export class Tower {",
      "  redirect(code: number): number {",
      "    return code;",
      "  }",
      "}",
      "",
    ].join("\n"),
  },
  rust: {
    file: "src/redirect.rs",
    sep: "::",
    source: [
      "pub struct Attempt;",
      "pub struct Action;",
      "pub struct Policy;",
      "pub struct Tower;",
      "",
      "pub fn helper() {}",
      "",
      "impl Policy {",
      "    pub fn redirect(&self, attempt: Attempt) -> Action {",
      "        helper();",
      "        Action",
      "    }",
      "",
      "    pub fn check(&self) -> Action {",
      "        self.redirect(Attempt)",
      "    }",
      "}",
      "",
      "impl Tower {",
      "    pub fn redirect(&self, code: u16) -> u16 {",
      "        code",
      "    }",
      "}",
      "",
    ].join("\n"),
  },
};

const OWNER_LANGUAGES = Object.keys(OWNERS);

describe("a box written Type.method confirms only that type's method", () => {
  it.each(OWNER_LANGUAGES)("@takes and @returns at another type's method of that name are not green in %s", async (language) => {
    const { file, source, sep } = OWNERS[language]!;
    const files = { [file]: source };
    const takes = await said(files, `${file}#Attempt`, `${file}#Tower${sep}redirect`, "takes");
    const returns = await said(files, `${file}#Action`, `${file}#Tower${sep}redirect`, "returns");
    // Not green, and not red either: the plain name does read as confirmed,
    // and refuting stays on the plain reading (#409).
    expect(takes.said).toBe("quiet");
    expect(returns.said).toBe("quiet");
  });

  it.each(OWNER_LANGUAGES)("@takes and @returns at the owner's own method stay green in %s", async (language) => {
    const { file, source, sep } = OWNERS[language]!;
    const files = { [file]: source };
    expect((await said(files, `${file}#Attempt`, `${file}#Policy${sep}redirect`, "takes")).said).toBe("green");
    expect((await said(files, `${file}#Action`, `${file}#Policy${sep}redirect`, "returns")).said).toBe("green");
  });

  it.each(OWNER_LANGUAGES)("@calls from another type's method of that name is not green in %s", async (language) => {
    const { file, source, sep } = OWNERS[language]!;
    const files = { [file]: source };
    expect((await said(files, `${file}#Tower${sep}redirect`, `${file}#helper`, "calls")).said).toBe("quiet");
    expect((await said(files, `${file}#Policy${sep}redirect`, `${file}#helper`, "calls")).said).toBe("green");
  });

  it.each(OWNER_LANGUAGES)("@calls into another type's method of that name is not green in %s", async (language) => {
    const { file, source, sep } = OWNERS[language]!;
    const files = { [file]: source };
    expect((await said(files, `${file}#Policy${sep}check`, `${file}#Tower${sep}redirect`, "calls")).said).not.toBe("green");
    expect((await said(files, `${file}#Policy${sep}check`, `${file}#Policy${sep}redirect`, "calls")).said).toBe("green");
  });

  it.each(OWNER_LANGUAGES)("a plain name keeps the plain reading in %s", async (language) => {
    // No owner written: any `redirect` may be the one meant, as before.
    const { file, source } = OWNERS[language]!;
    expect((await said({ [file]: source }, `${file}#Attempt`, `${file}#redirect`, "takes")).said).toBe("green");
  });
});

describe("a class read through its base does not reach the base's method it replaces", () => {
  /*
   * aiohttp's shape: `Payload.write_with_length` calls `self.write`, and
   * `BytesPayload` declares both again. Read as the caller, `BytesPayload`
   * took the inherited `write_with_length` for its own code and "called"
   * `Payload.write` -- which on a `BytesPayload` is never what runs.
   */
  const FILES: Record<string, { file: string; source: string }> = {
    python: {
      file: "src/payload.py",
      source: [
        "class Payload:",
        "    def write(self, writer) -> None:",
        "        pass",
        "",
        "    def write_with_length(self, writer) -> None:",
        "        self.write(writer)",
        "",
        "class BytesPayload(Payload):",
        "    def write(self, writer) -> None:",
        "        writer.send(b\"\")",
        "",
        "    def write_with_length(self, writer) -> None:",
        "        writer.send(b\"\")",
        "",
      ].join("\n"),
    },
    ts: {
      file: "src/payload.ts",
      source: [
        "export class Payload {",
        "  write(writer: { send(b: string): void }): void {}",
        "  writeWithLength(writer: { send(b: string): void }): void { this.write(writer); }",
        "}",
        "",
        "export class BytesPayload extends Payload {",
        "  write(writer: { send(b: string): void }): void { writer.send(\"\"); }",
        "  writeWithLength(writer: { send(b: string): void }): void { writer.send(\"\"); }",
        "}",
        "",
      ].join("\n"),
    },
  };

  it.each(Object.keys(FILES))("is not green in %s", async (language) => {
    const { file, source } = FILES[language]!;
    expect((await said({ [file]: source }, `${file}#BytesPayload`, `${file}#Payload.write`, "calls")).said).not.toBe("green");
  });

  it.each(Object.keys(FILES))("the base's own method calling it stays green in %s", async (language) => {
    const { file, source } = FILES[language]!;
    const caller = language === "ts" ? "Payload.writeWithLength" : "Payload.write_with_length";
    expect((await said({ [file]: source }, `${file}#${caller}`, `${file}#Payload.write`, "calls")).said).toBe("green");
  });
});
