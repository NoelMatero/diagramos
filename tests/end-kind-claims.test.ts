/**
 * An arrow whose end is the wrong kind of thing for its claim (#297).
 *
 * `Client --@feeds--> handle_request` where `Client` is a struct is not a
 * claim the code can disagree with -- it is a claim nothing could ever
 * confirm, because a struct has no result. Every reader met arrows like that
 * on its own terms, found nothing, and withheld, so the one mistake on the
 * board a person could fix in a second read as "not sure".
 *
 * A test per claim and per language, because the whole point is that the
 * reading is structural: if a red appears in Rust and not in Python, the
 * reader has a list in it somewhere. `engine-parts.test.ts` covers the reader
 * itself; this is what reaches a report.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
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

async function boardOf(
  fromRef: string,
  toRef: string,
  claim: ArrowClaim,
  extra: { label?: string; state?: "planned" } = {},
): Promise<BoardFile> {
  const { label, ...edge } = extra;
  const { board } = await createDiagram(emptyBoard(), {
    name: "arch",
    nodes: [
      { id: "tail", label: fromRef.split("#")[1] ?? fromRef, ref: fromRef },
      { id: "head", label: toRef.split("#")[1] ?? toRef, ref: toRef },
    ],
    edges: [{ from: "tail", to: "head", claim, ...(label ? { label } : {}), ...edge }],
  });
  return board;
}

/**
 * The same three shapes in each language: a data type with a field, a routine
 * that uses it, and a second routine for the far end of a call.
 */
const SOURCES: Record<string, { file: string; source: string }> = {
  rust: {
    file: "src/lib.rs",
    source: [
      "pub struct Buffer {",
      "    pub bytes: Vec<u8>,",
      "}",
      "",
      "pub struct Client {",
      "    pub buffer: Buffer,",
      "}",
      "",
      "pub fn receive(client: &Client) -> Buffer {",
      "    helper();",
      "    Buffer { bytes: client.buffer.bytes.clone() }",
      "}",
      "",
      "pub fn helper() {}",
      "",
    ].join("\n"),
  },
  python: {
    file: "src/client.py",
    source: [
      "class Buffer:",
      "    bytes: bytes = b\"\"",
      "",
      "class Client:",
      "    buffer: Buffer",
      "",
      "def receive(client: Client) -> Buffer:",
      "    helper()",
      "    return client.buffer",
      "",
      "def helper():",
      "    pass",
      "",
    ].join("\n"),
  },
  ts: {
    file: "src/client.ts",
    source: [
      "export class Buffer {",
      "  bytes: Uint8Array = new Uint8Array();",
      "}",
      "",
      "export class Client {",
      "  buffer: Buffer | undefined;",
      "}",
      "",
      "export function receive(client: Client): Buffer {",
      "  helper();",
      "  return client.buffer;",
      "}",
      "",
      "export function helper() {}",
      "",
    ].join("\n"),
  },
};

const LANGUAGES = Object.keys(SOURCES);

/** The one finding this file is about, or nothing. */
function wrongKind(board: BoardFile, language: string) {
  const { file, source } = SOURCES[language]!;
  const report = checkDrift(board, fakeWorkspace({ [file]: source }), { edges: true });
  return {
    report,
    finding: report.edges.find((edge) => edge.kind === "end-lacks-part"),
  };
}

describe("@feeds from something with no result", () => {
  it.each(LANGUAGES)("is red in %s, and says so in plain words", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#receive`, "feeds");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no result");
    expect(finding?.detail).toContain("Client");
    expect(report.clean).toBe(false);
  });
});

describe("@calls and @builds from something with no code in it", () => {
  it.each(LANGUAGES)("is red in %s for @calls", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#helper`, "calls");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no body of code that runs");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("is red in %s for @builds", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#Buffer`, "builds");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no body of code that runs");
    expect(report.clean).toBe(false);
  });
});

describe("@takes and @returns into something with no signature", () => {
  it.each(LANGUAGES)("is red in %s for @takes", async (language) => {
    const { file } = SOURCES[language]!;
    // The declaration both words read sits at the head of the arrow, so this
    // says "Client's parameters take receive" -- of a type that has none.
    const board = await boardOf(`${file}#receive`, `${file}#Client`, "takes");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no parameters or return type");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("is red in %s for @returns", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#receive`, `${file}#Client`, "returns");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no parameters or return type");
    expect(report.clean).toBe(false);
  });
});

describe("@holds and @conforms from a function", () => {
  it.each(LANGUAGES)("is red in %s for @holds", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#receive`, `${file}#Buffer`, "holds");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no fields");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("is red in %s for @conforms", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#receive`, `${file}#Buffer`, "conforms");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no base types");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("says it in the language's own word in %s", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#receive`, "feeds");
    const { finding } = wrongKind(board, language);
    // The keyword the source itself writes before the name, not a table of
    // node types: `struct` in Rust, `class` in the other two.
    expect(finding?.detail).toContain(language === "rust" ? "a struct" : "a class");
  });
});

describe("@accesses, whose two ends want different things", () => {
  it.each(LANGUAGES)("is red in %s when the reader has no body", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#Buffer`, "accesses", { label: "bytes" });
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no body of code that runs");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("is red in %s when the member is read off a function", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#receive`, `${file}#helper`, "accesses", { label: "bytes" });
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no fields");
    expect(report.clean).toBe(false);
  });
});

describe("an end of the right kind is left alone", () => {
  const rightWayRound: Array<[ArrowClaim, string, string, string | undefined]> = [
    ["feeds", "receive", "helper", undefined],
    ["calls", "receive", "helper", undefined],
    ["builds", "receive", "Buffer", undefined],
    ["takes", "Client", "receive", undefined],
    ["returns", "Client", "receive", undefined],
    ["holds", "Client", "Buffer", undefined],
    ["conforms", "Client", "Buffer", undefined],
    ["accesses", "receive", "Client", "buffer"],
  ];

  for (const [claim, from, to, label] of rightWayRound) {
    it.each(LANGUAGES)(`says nothing about @${claim} in %s`, async (language) => {
      const { file } = SOURCES[language]!;
      const board = await boardOf(`${file}#${from}`, `${file}#${to}`, claim, label ? { label } : {});
      const { finding } = wrongKind(board, language);

      expect(finding).toBeUndefined();
    });
  }
});

describe("what the red must never do", () => {
  it.each(LANGUAGES)("never accuses a plan in %s", async (language) => {
    // Sketching next week's structure is what a plan is for, and every other
    // accusation here exempts one.
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#receive`, "feeds", { state: "planned" });
    const { report, finding } = wrongKind(board, language);

    expect(finding).toBeUndefined();
    expect(report.clean).toBe(true);
  });

  it.each(LANGUAGES)("counts the arrow once in %s, as red and not as unanswered", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#receive`, `${file}#Buffer`, "holds");
    const { report } = wrongKind(board, language);

    expect(report.edges.filter((edge) => edge.kind === "end-lacks-part")).toHaveLength(1);
    expect(Object.values(report.claims.holdsWithheld)).toEqual([]);
    expect(report.garbledClaims ?? []).toEqual([]);
  });
});

describe("a class body that does run code is not accused", () => {
  /*
   * The half of this that is not true of a struct. Python runs a class body at
   * import and TypeScript runs a field initialiser at construction, so
   * `class Client { buffer = new Buffer() }` really does call something, and a
   * red saying it has no code in it would be a false one -- the shape
   * `docs/reading-a-grammar.md` exists to prevent, arriving from the other
   * direction. Rust has no such shape: a field list cannot call anything.
   */
  const running: Record<string, string> = {
    python: [
      "class Buffer:",
      "    bytes: bytes = b\"\"",
      "",
      "class Client:",
      "    buffer: Buffer = Buffer()",
      "",
      "def helper():",
      "    pass",
      "",
    ].join("\n"),
    ts: [
      "export class Buffer {",
      "  bytes: Uint8Array = new Uint8Array();",
      "}",
      "",
      "export class Client {",
      "  buffer: Buffer = new Buffer();",
      "}",
      "",
      "export function helper() {}",
      "",
    ].join("\n"),
  };

  it.each(Object.keys(running))("stays quiet in %s", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#helper`, "calls");
    const report = checkDrift(board, fakeWorkspace({ [file]: running[language]! }), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "end-lacks-part")).toEqual([]);
  });
});
