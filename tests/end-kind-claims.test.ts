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
import { ACCUSING_EDGE_KINDS, checkDrift, type Workspace } from "../src/engine/drift";
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

/*
 * Not Rust. A Rust type's code is its `impl` blocks, which may be in any file
 * of the crate, so "this struct has no code" cannot be read off the struct --
 * `measure:parts` counts 1,068 structs the reader would have called bodiless
 * that are not. See the Rust tests at the bottom of this file.
 */
const WITH_CLASS_BODIES = LANGUAGES.filter((language) => language !== "rust");

describe("@calls and @builds from something with no code in it", () => {
  it.each(WITH_CLASS_BODIES)("is red in %s for @calls", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Client`, `${file}#helper`, "calls");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no body of code that runs");
    expect(report.clean).toBe(false);
  });

  it.each(WITH_CLASS_BODIES)("is red in %s for @builds", async (language) => {
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
    const board = await boardOf(`${file}#Buffer`, `${file}#Client`, "takes");
    const { report, finding } = wrongKind(board, language);

    expect(finding?.detail).toContain("no parameters or return type");
    expect(report.clean).toBe(false);
  });

  it.each(LANGUAGES)("is red in %s for @returns", async (language) => {
    const { file } = SOURCES[language]!;
    const board = await boardOf(`${file}#Buffer`, `${file}#Client`, "returns");
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
  it.each(WITH_CLASS_BODIES)("is red in %s when the reader has no body", async (language) => {
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
    // `Buffer` is a struct, and in Rust only a trait can be implemented: the
    // right-way-round Rust `@conforms` is in the #345 block below.
    const languages = claim === "conforms" ? LANGUAGES.filter((one) => one !== "rust") : LANGUAGES;
    it.each(languages)(`says nothing about @${claim} in %s`, async (language) => {
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

describe("a Rust type's code lives in its impl blocks", () => {
  /*
   * The two false reds #301's test set found (ripgrep's `GlobSet` and `Core`).
   * A Rust struct's methods are written in `impl GlobSet { ... }`, outside the
   * struct and possibly in another file, so reading the struct alone and
   * calling it "no code" is a red on an arrow that is true.
   */
  it("does not say a struct with methods has no code", async () => {
    const source = [
      "pub struct Strategy;",
      "pub struct GlobSet { strats: Vec<Strategy> }",
      "impl GlobSet {",
      "    pub fn new() -> GlobSet { GlobSet { strats: vec![Strategy] } }",
      "}",
      "",
    ].join("\n");
    const board = await boardOf("src/lib.rs#GlobSet", "src/lib.rs#Strategy", "builds");
    const report = checkDrift(board, fakeWorkspace({ "src/lib.rs": source }), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "end-lacks-part")).toEqual([]);
  });

  it("does not say it when the impl is in another file either", async () => {
    const files = {
      "src/lib.rs": "pub struct Strategy;\npub struct GlobSet { strats: Vec<Strategy> }\n",
      "src/build.rs": "use crate::*;\nimpl GlobSet { pub fn new() -> GlobSet { GlobSet { strats: vec![Strategy] } } }\n",
    };
    const board = await boardOf("src/lib.rs#GlobSet", "src/lib.rs#Strategy", "builds");
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.edges.filter((edge) => edge.kind === "end-lacks-part")).toEqual([]);
  });
});

describe("the other end: a function where a type should be", () => {
  /*
   * #301's test set plants the wrong-kind mistake on the end #297 did not
   * list: `@holds` *into* a function, `@takes` *from* one. Same question the
   * reader already answers -- a declaration with parameters is never a type --
   * so it is the same red with one more line in `NEEDS` per word.
   */
  const intoAFunction: Array<[ArrowClaim, string, string]> = [
    ["takes", "helper", "receive"],
    ["returns", "helper", "receive"],
    ["holds", "Client", "helper"],
    ["conforms", "Client", "helper"],
    ["builds", "receive", "helper"],
  ];

  for (const [claim, from, to] of intoAFunction) {
    it.each(LANGUAGES)(`is red in %s for @${claim} with a function at the wrong end`, async (language) => {
      const { file } = SOURCES[language]!;
      const board = await boardOf(`${file}#${from}`, `${file}#${to}`, claim);
      const { report, finding } = wrongKind(board, language);

      if (claim === "takes" || claim === "returns") {
        // Red before #297 too: the signature is readable and does not name
        // `helper`. Either sentence is a true one; the arrow must not pass.
        expect(report.edges.some((edge) => edge.kind === "signature-absent" || edge.kind === "end-lacks-part"))
          .toBe(true);
      } else if (claim === "conforms") {
        // #345: what `@conforms` asks of its head is something a type can
        // implement or extend, and a function is not that in any language.
        expect(finding?.detail).toContain("a function cannot be implemented");
      } else if (claim === "builds" && language === "ts") {
        /*
         * #363: in a language with JSX a function may be a component, which is
         * exactly what `@builds` points at, and only a compiler can tell. With
         * none running the arrow is left alone; builds-component.test.ts has
         * the red with one.
         */
        expect(finding).toBeUndefined();
        return;
      } else {
        expect(finding?.detail).toContain("a function is not a type");
      }
      expect(report.garbledClaims ?? []).toEqual([]);
      expect(report.clean).toBe(false);
    });
  }

  /*
   * Where the new line is the only thing that can speak: a signature the
   * reader refuses to judge, because a name in it may stand for another.
   */
  const aliased: Record<string, { file: string; source: string }> = {
    rust: {
      file: "src/lib.rs",
      source: "pub struct Buffer;\ntype B = Buffer;\npub fn receive(b: B) -> B { b }\npub fn helper() {}\n",
    },
    python: {
      file: "src/client.py",
      source: "class Buffer:\n    pass\n\ndef receive(b: \"Buffer\") -> \"Buffer\":\n    return b\n\ndef helper():\n    pass\n",
    },
    ts: {
      file: "src/client.ts",
      source: "export class Buffer {}\ntype B = Buffer;\nexport function receive(b: B): B { return b; }\nexport function helper() {}\n",
    },
  };

  for (const claim of ["takes", "returns"] as const) {
    it.each(LANGUAGES)(`says a function is not a type in %s when @${claim}'s signature cannot be judged`, async (language) => {
      const { file, source } = aliased[language]!;
      const board = await boardOf(`${file}#helper`, `${file}#receive`, claim);
      const report = checkDrift(board, fakeWorkspace({ [file]: source }), { edges: true });

      const finding = report.edges.find((edge) => edge.kind === "end-lacks-part");
      expect(finding?.detail).toContain("a function is not a type");
      expect(report.clean).toBe(false);
    });
  }
});

describe("Rust structs are not accused of having no code", () => {
  for (const [claim, from, to, label] of [
    ["calls", "Client", "helper", undefined],
    ["builds", "Client", "Buffer", undefined],
    ["accesses", "Client", "Buffer", "bytes"],
  ] as Array<[ArrowClaim, string, string, string | undefined]>) {
    it(`stays quiet on @${claim} from a struct`, async () => {
      const { file } = SOURCES.rust!;
      const board = await boardOf(`${file}#${from}`, `${file}#${to}`, claim, label ? { label } : {});
      const { finding } = wrongKind(board, "rust");

      expect(finding).toBeUndefined();
    });
  }
});

describe("an arrow into a constant (#307)", () => {
  /*
   * 87 of the 94 wrong-kind mistakes #301's test set plants that #297 did not
   * catch are this: `@calls` or `@builds` into a constant. #297 left every
   * constant alone because one may hold a function -- and a value written out
   * in full cannot, which is the half that can be said.
   */
  const files: Record<string, { file: string; source: string }> = {
    rust: {
      file: "src/lib.rs",
      source: [
        "pub const LIMIT: usize = 4;",
        "pub const MAKER: fn() -> usize = build;",
        "pub fn build() -> usize { LIMIT }",
        "",
      ].join("\n"),
    },
    python: {
      file: "src/limits.py",
      source: [
        "LIMIT = 4",
        "MAKER = build",
        "",
        "def build():",
        "    return LIMIT",
        "",
      ].join("\n"),
    },
    ts: {
      file: "src/limits.ts",
      source: [
        "export const LIMIT = 4;",
        "export const MAKER = build;",
        "export function build() { return LIMIT; }",
        "",
      ].join("\n"),
    },
  };

  const reportFor = async (language: string, to: string, claim: ArrowClaim) => {
    const { file, source } = files[language]!;
    const board = await boardOf(`${file}#build`, `${file}#${to}`, claim);
    return checkDrift(board, fakeWorkspace({ [file]: source }), { edges: true });
  };

  it.each(Object.keys(files))("is red in %s for @calls into a number", async (language) => {
    /*
     * Red in all three, and not always by this check: where `calls.ts` can read
     * a routine's whole call set it already refutes the arrow (`calls-refuted`,
     * ts and python only). Both sentences are true and the arrow fails either
     * way; what this check adds is the languages and the shapes that reader
     * cannot close -- a macro, a dynamic call, a name it cannot place.
     */
    const report = await reportFor(language, "LIMIT", "calls");

    expect(report.edges.some((edge) => edge.kind === "end-lacks-part" || edge.kind === "calls-refuted"))
      .toBe(true);
    expect(report.clean).toBe(false);
  });

  it("says which end it is where @calls cannot close the call set", async () => {
    /*
     * The sentence this check exists for, on a body the call reader cannot
     * enumerate: a macro can expand to anything, so the call set never
     * closes and `calls-refuted` cannot fire. What is left is this check,
     * and it is the more useful of the two answers anyway -- "that end is a
     * value, point the arrow at the routine" is something to do, where
     * "every call was checked and none reaches there" is something to know.
     *
     * It used to be pinned on plain Rust, on the grounds that Rust could
     * never refute from a call set. #324 measured that square and turned it
     * on, so the premise is gone and the trivially-closed body now refutes
     * in all three languages. The check itself did not change; what changed
     * is which arrows reach it.
     */
    const board = await boardOf("src/lib.rs#build", "src/lib.rs#LIMIT", "calls");
    const report = checkDrift(board, fakeWorkspace({
      "src/lib.rs": [
        "pub const LIMIT: usize = 4;",
        "pub fn build() -> usize { println!(\"{}\", LIMIT); LIMIT }",
        "",
      ].join("\n"),
    }), { edges: true });
    const finding = report.edges.find((edge) => edge.kind === "end-lacks-part");

    expect(finding?.detail).toContain("holds data, and cannot be called");
    expect(finding?.detail).toContain("Point the arrow at the routine that is called, or drop the claim.");
  });

  it.each(Object.keys(files))("is red in %s for @builds into a number", async (language) => {
    const report = await reportFor(language, "LIMIT", "builds");
    const finding = report.edges.find((edge) => edge.kind === "end-lacks-part");

    expect(finding?.detail).toContain("is not a type");
    expect(report.clean).toBe(false);
  });

  it.each(Object.keys(files))("stays quiet in %s when the constant holds a function", async (language) => {
    const report = await reportFor(language, "MAKER", "calls");

    expect(report.edges.filter((edge) => edge.kind === "end-lacks-part")).toEqual([]);
  });

  it("is red for @calls into a field whose type is written on it", async () => {
    // clap's `settings: ArgFlags`, the shape #337 found on 40 of the missed
    // arrows: nothing is assigned, so the value rule above never sees it, and
    // the type beside the name is the whole of what settles it.
    const board = await boardOf("src/lib.rs#build", "src/lib.rs#settings", "calls");
    const report = checkDrift(board, fakeWorkspace({
      "src/lib.rs": [
        "pub struct Command {",
        "    pub(crate) settings: ArgFlags,",
        "}",
        "",
        "pub fn build(command: &Command) -> usize { command.settings.bits() }",
        "",
      ].join("\n"),
    }), { edges: true });
    const finding = report.edges.find((edge) => edge.kind === "end-lacks-part");

    expect(finding?.detail).toContain("holds data, and cannot be called");
    // A field writes no keyword before its name. It used to be named "a type"
    // for want of one, which made the sentence contradict itself (#343).
    expect(finding?.detail).toContain("anchored at `settings`, a value,");
  });

  it("is red for @builds into a field, and quiet when the field could hold a function", async () => {
    /*
     * The two halves stand on different footings, and the same declaration
     * shows both: a TypeScript field named by another type is certainly not a
     * type itself, and might still be callable, because `type Runner = () =>
     * void` is a thing somebody can write and nothing here follows a name.
     */
    const files = {
      "src/query.ts": [
        "export class Query {",
        "  status: QueryStatus",
        "}",
        "export function build(query: Query) { return query.status; }",
        "",
      ].join("\n"),
    };
    const builds = checkDrift(await boardOf("src/query.ts#build", "src/query.ts#status", "builds"),
      fakeWorkspace(files), { edges: true });
    expect(builds.edges.find((edge) => edge.kind === "end-lacks-part")?.detail).toContain("is not a type");

    const calls = checkDrift(await boardOf("src/query.ts#build", "src/query.ts#status", "calls"),
      fakeWorkspace(files), { edges: true });
    expect(calls.edges.filter((edge) => edge.kind === "end-lacks-part")).toEqual([]);
  });
});

describe("a Rust @conforms whose head is not a trait (#345)", () => {
  /*
   * In Rust only a trait can be implemented, so `CompactFormatter @conforms
   * Formatter` drawn the wrong way round -- or `Command @conforms MKeyMap` --
   * is wrong whatever the rest of the crate says. `@conforms` withholds on
   * Rust because an `impl` may sit in any file, and "is a type" is all #297
   * asked of the head, which a struct is. Shapes from serde_json and clap.
   */
  const file = "src/ser.rs";
  const source = [
    "pub trait Formatter {",
    "    fn begin(&mut self) {}",
    "}",
    "",
    "pub unsafe trait Sealed: Formatter {}",
    "",
    "pub struct CompactFormatter;",
    "",
    "pub struct MKeyMap {",
    "    keys: Vec<String>,",
    "}",
    "",
    "pub struct Pair(u8, u8);",
    "",
    "pub enum Category {",
    "    Io,",
    "    Syntax,",
    "}",
    "",
    "pub struct Command {",
    "    name: String,",
    "}",
    "",
  ].join("\n");
  const ACCUSING = new Set<string>(ACCUSING_EDGE_KINDS);
  const check = async (from: string, to: string) => {
    const report = checkDrift(await boardOf(`${file}#${from}`, `${file}#${to}`, "conforms"),
      fakeWorkspace({ [file]: source }), { edges: true });
    return { report, finding: report.edges.find((edge) => edge.kind === "end-lacks-part") };
  };

  it("is red when the head is a struct with fields", async () => {
    const { report, finding } = await check("Command", "MKeyMap");

    expect(finding?.detail).toContain("a struct cannot be implemented");
    expect(report.clean).toBe(false);
  });

  it("is red when the head is a unit struct, which has no body field at all", async () => {
    // `pub struct CompactFormatter;` -- the shape every other part leaves
    // unsure, because there is no field list to read. The word is still there.
    const { report, finding } = await check("Formatter", "CompactFormatter");

    expect(finding?.detail).toContain("a struct cannot be implemented");
    expect(finding?.detail).toContain("in Rust, only a trait");
    expect(report.clean).toBe(false);
  });

  it("is red when the head is a tuple struct or an enum", async () => {
    expect((await check("Command", "Pair")).finding?.detail).toContain("a struct cannot be implemented");
    expect((await check("Command", "Category")).finding?.detail).toContain("an enum cannot be implemented");
  });

  it("says nothing when the head is a trait, however the trait opens", async () => {
    // The right way round. `impl Formatter for CompactFormatter` may be in any
    // file of the crate, so the arrow stays unread -- never red.
    for (const head of ["Formatter", "Sealed"]) {
      const { report, finding } = await check("CompactFormatter", head);

      expect(finding).toBeUndefined();
      expect(report.edges.filter((edge) => ACCUSING.has(edge.kind))).toEqual([]);
    }
  });
});
