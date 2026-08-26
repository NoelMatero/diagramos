/**
 * Arrows at function granularity.
 *
 * The case this exists for: the diagram says `handle_request -> log`, the
 * logging call is in `reset_connection`, and every file-level channel is
 * satisfied because they live in the same file. The arrow is wrong and nothing
 * says a word.
 *
 * The fixture below reproduces the shape of the Rust file this was measured
 * against -- a `lazy_static!` LOGGER, a `macro_rules! log_line`, and call sites
 * in some functions and not others. The two channel tests near the end are the
 * ones that shaped the design, and both come from measurements that went the
 * wrong way first.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard, type BoardFile } from "../src/engine/board-file";
import { bodyOf, callsIn, reaches } from "../src/engine/body";
import { loadCodeGraph } from "../src/engine/codegraph";
import { createDiagram } from "../src/engine/diagram";
import { checkDrift, type Workspace } from "../src/engine/drift";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

function fakeWorkspace(files: Record<string, string>): Workspace {
  return {
    resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
    stat: (target) => (files[target] === undefined ? "missing" : "file"),
    read: (target) => files[target] ?? "",
    list: () => [],
  };
}

/**
 * The same file map, with directories inferred from the paths.
 *
 * `fakeWorkspace` lists nothing, which is fine for TypeScript -- a specifier
 * resolves against the filesystem one lookup at a time. Rust needs a walk: the
 * module tree is built from the `Cargo.toml` files in the tree, and a workspace
 * that cannot list a directory has no crates and therefore no readable Rust.
 */
function treeWorkspace(files: Record<string, string>): Workspace {
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
        if (!file.startsWith(prefix)) continue;
        names.add(file.slice(prefix.length).split("/")[0]!);
      }
      return [...names];
    },
  };
}

const CARGO = '[package]\nname = "demo"\nedition = "2021"\n';

async function boardWith(
  nodes: Array<{ id: string; label: string; ref?: string; refs?: string[] }>,
  edges: Array<{ from: string; to: string }>,
): Promise<BoardFile> {
  return (await createDiagram(emptyBoard(), { name: "arch", nodes, edges })).board;
}

beforeAll(async () => {
  await boardWith([{ id: "warmup", label: "Warm up" }], []);
}, 60_000);

/**
 * Same shape as the real file: a static, a macro that uses it, and functions
 * that variously log directly, log only through a call, or never log at all.
 */
const RUST = [
  "use std::sync::Mutex;",
  "",
  "lazy_static! {",
  "    static ref LOGGER: Mutex<std::fs::File> = Mutex::new(open_log());",
  "}",
  "",
  "macro_rules! log_line {",
  "    ($($arg:tt)*) => {{",
  "        let msg = format!($($arg)*);",
  "        if let Ok(mut file) = LOGGER.lock() {",
  '            let _ = writeln!(file, "{}", msg);',
  "        }",
  "    }};",
  "}",
  "",
  "pub struct Client { pub id: usize }",
  "",
  "impl Client {",
  "    fn handle_request(&mut self, token: Token) {",
  '        log_line!("request {:?}", token);',
  "        self.get_client(token);",
  "    }",
  "",
  "    // Logs only through the call, which is what the one-hop channel is for.",
  "    fn readable(&mut self, token: Token) {",
  "        self.handle_request(token);",
  "    }",
  "",
  "    // Calls a *foreign* readable. Following that would be wrong.",
  "    fn register(&mut self, set: EventSet) -> usize {",
  "        let _ = EventSet::readable();",
  "        let _ = set.readable();",
  "        self.id",
  "    }",
  "",
  "    fn get_client(&mut self, token: Token) -> usize { token.0 }",
  "",
  "    fn send(&mut self) -> bool { true }",
  "}",
  "",
  "// Calls register *and* logs -- a shared-caller channel would use this to",
  "// bless the false arrow `register -> log`, which is why there isn't one.",
  "pub fn ready(client: &mut Client, set: EventSet) {",
  "    client.register(set);",
  '    log_line!("ready");',
  "}",
].join("\n");

describe("finding a function body", () => {
  it("takes the balanced extent of a method in an impl block", () => {
    const body = bodyOf(RUST, "handle_request", "rust")!;
    expect(body).toContain("log_line!");
    expect(body).toContain("self.get_client");
    // Stops at its own closing brace rather than running on into the next one.
    expect(body).not.toContain("fn readable");
  });

  it("is not fooled by braces in the parameter list", () => {
    const source = "export function f(options = { a: 1 }) {\n  return TARGET;\n}\n";
    expect(bodyOf(source, "f", "ts")).toContain("TARGET");
  });

  it("runs an expression statement to its semicolon", () => {
    const source = "export const f = (x: number) => x + TARGET;\n";
    expect(bodyOf(source, "f", "ts")).toContain("TARGET");
  });

  it("gives nothing for a signature with no body, rather than guessing", () => {
    // A trait method. The caller counts this and falls back; a guessed span
    // would be a loud wrong answer instead of a quiet one.
    const source = "trait Sink {\n    fn emit(&self);\n}\n";
    expect(bodyOf(source, "emit", "rust")).toBeUndefined();
  });

  it("gives nothing for a name that is not declared here at all", () => {
    expect(bodyOf(RUST, "nowhere", "rust")).toBeUndefined();
  });
});

describe("which calls a body is followed into", () => {
  it("takes bare calls, macro calls, and explicit self/this", () => {
    const calls = callsIn("fn f() { foo(1); log_line!(\"x\"); self.bar(); this.baz(); }", "rust");
    expect([...calls].sort()).toEqual(["bar", "baz", "foo", "log_line"]);
  });

  it("refuses a call through a type or another object", () => {
    // The measurement that forced this: bodies calling mio's
    // `EventSet::readable()` were read as calling the local `readable`, which
    // logs -- and two false arrows went quiet because of it.
    const calls = callsIn("fn f() { EventSet::readable(); other.readable(); set.readable(); }", "rust");
    expect(calls.has("readable")).toBe(false);
  });

  it("does not mistake control flow for a call", () => {
    const calls = callsIn("function g() { if (x) { while (y) { return f(); } } }", "ts");
    expect([...calls]).toEqual(["f"]);
  });
});

describe("does this function reach the logging", () => {
  const LOG = ["LOGGER", "log_line"];

  it("is quiet when the body logs directly", () => {
    expect(reaches(RUST, "handle_request", LOG, "rust")).toBe(true);
  });

  it("is quiet when the body logs only through a same-file call", () => {
    // The channel earning its place: extracting the logging into a helper is a
    // healthy refactor, and without the hop it becomes a false alarm.
    expect(reaches(RUST, "readable", LOG, "rust")).toBe(true);
  });

  it("flags a function that does not log, however close it sits", () => {
    for (const fn of ["register", "get_client", "send"]) {
      expect(reaches(RUST, fn, LOG, "rust"), fn).toBe(false);
    }
  });

  it("is not rescued by a caller that logs", () => {
    // `ready` calls `register` and also logs. A shared-caller channel would
    // bless `register -> log` on that basis -- the exact arrow this
    // granularity exists to catch. Measured, refused, and pinned here.
    expect(reaches(RUST, "ready", LOG, "rust")).toBe(true);
    expect(reaches(RUST, "register", LOG, "rust")).toBe(false);
  });

  it("refuses the question rather than answering it when the lexer bails", () => {
    expect(reaches("/* never closed\nfn f() { log_line!(); }", "f", LOG, "rust")).toBeUndefined();
  });
});

describe("an arrow between two symbol-anchored boxes", () => {
  const files = { "src/lib.rs": RUST };

  async function edge(fromRef: string, toRefs: string[]) {
    const board = await boardWith(
      [
        { id: "a", label: "caller", ref: fromRef },
        { id: "b", label: "log", ref: toRefs[0], refs: toRefs.slice(1) },
      ],
      [{ from: "a", to: "b" }],
    );
    return checkDrift(board, fakeWorkspace(files));
  }

  it("is quiet when the caller logs, in Rust, which the file check cannot read", () => {
    return edge("src/lib.rs#handle_request", ["src/lib.rs#LOGGER", "src/lib.rs#log_line"]).then(
      (report) => {
        expect(report.edges).toEqual([]);
        expect(report.edgesChecked).toBe(1);
        expect(report.edgesSkippedWhy).toEqual({});
      },
    );
  });

  it("flags the arrow the file-level channels cannot see is wrong", async () => {
    // Same file at both ends, so imports, shared importers and routes are all
    // satisfied. Only the body scope knows `register` never logs.
    const report = await edge("src/lib.rs#register", ["src/lib.rs#LOGGER", "src/lib.rs#log_line"]);
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].detail).toContain("worth a look");
    expect(report.edges[0].detail).toContain("LOGGER or log_line");
    // `from`/`to` are file paths (the evidence); `node` names the arrow itself,
    // in node ids, so a caller can reveal or edit the element the finding is
    // about. The board page's click-to-reveal reads exactly this.
    expect(report.edges[0].node).toBe("a -> b");
  });

  it("accepts any one of the symbols a feature box lists", async () => {
    // `send` is reached by nothing, so a box claiming only that is flagged...
    const alone = await edge("src/lib.rs#handle_request", ["src/lib.rs#send"]);
    expect(alone.edges).toHaveLength(1);
    // ...and adding a member that *is* reached settles the whole box. One
    // member is enough, which is concept membership needing no new code.
    const withMember = await edge("src/lib.rs#handle_request", [
      "src/lib.rs#send",
      "src/lib.rs#log_line",
    ]);
    expect(withMember.edges).toEqual([]);
  });

  it("reaches the macro's own dependencies through the hop", () => {
    // `handle_request` never writes `LOGGER`; it calls `log_line!`, whose body
    // does. That is the hop doing exactly its job, and it means a box anchored
    // on the static alone is still corroborated by a caller of the macro.
    return edge("src/lib.rs#handle_request", ["src/lib.rs#LOGGER"]).then((report) => {
      expect(report.edges).toEqual([]);
    });
  });

  it("counts the skip when neither end has a body that can be read", async () => {
    // Two trait methods: declared, no body anywhere. The question cannot be
    // asked, so it is not answered -- and the count says so rather than the
    // silence implying a pass.
    const trait = [
      "trait Sink {",
      "    fn emit(&self);",
      "    fn flush(&self);",
      "}",
    ].join("\n");
    const board = await boardWith(
      [
        { id: "a", label: "emit", ref: "src/sink.rs#emit" },
        { id: "b", label: "flush", ref: "src/sink.rs#flush" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, fakeWorkspace({ "src/sink.rs": trait }));
    expect(report.edgesSkippedWhy).toEqual({ "no-function-body": 1 });
    expect(report.edgesChecked).toBe(0);
  });
});

describe("what function granularity leaves alone", () => {
  it("falls back to the file channels when one end is only a file", async () => {
    const files = {
      "src/a.ts": 'import { b } from "./b";\nexport function callA() { return b; }\n',
      "src/b.ts": "export const b = 1;\n",
    };
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts#callA" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [{ from: "a", to: "b" }],
    );
    // Only one end names a symbol, so this is the import channel as before.
    const report = checkDrift(board, fakeWorkspace(files));
    expect(report.edges).toEqual([]);
    expect(report.edgesChecked).toBe(1);
  });

  it("skips a Rust arrow no crate declares, and says that rather than the language", async () => {
    // `src/lib.rs` here belongs to no crate, because nothing lists a
    // `Cargo.toml`. So `mod` and `crate::` have no root to resolve against and
    // the reader would find nothing -- which is not the same fact as "there is
    // nothing there", and the skip reason is the one that says so.
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/lib.rs" },
        { id: "b", label: "B", ref: "src/other.rs" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/lib.rs": RUST, "src/other.rs": "pub fn x() {}\n" }),
    );
    expect(report.edgesSkippedWhy).toEqual({ "outside-licence": 1 });
    expect(report.edgesChecked).toBe(0);
  });
});

/**
 * The arrow check asks `licence.ts` which languages it can read, the way the
 * direction check and the closure check already did.
 *
 * It used to ask a regex for TypeScript extensions instead, so a Rust board was
 * told "not TypeScript or JavaScript" about arrows between two files this
 * repository had measured a reader for -- 14 of 50 arrows on the board in issue
 * #131, a reason that was simply not true. The tests below are one per channel,
 * because "Rust works now" is not a claim any single one of them supports.
 */
describe("arrows between files in a language with a licence", () => {
  it("confirms one Rust file declaring the other", async () => {
    const files = {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod route;\n",
      "src/route.rs": "pub fn go() {}\n",
    };
    const board = await boardWith(
      [
        { id: "a", label: "lib", ref: "src/lib.rs" },
        { id: "b", label: "route", ref: "src/route.rs" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    expect(report.edgesSkippedWhy).toEqual({});
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
  });

  it("confirms an arrow drawn against the declaration, not with it", async () => {
    // Channel 2. The arrow points from `route` to `lib`; only `lib` declares
    // anything. Corroboration is symmetric on purpose -- it confirms a
    // connection and never a direction, which is `needs.ts`'s job.
    const files = {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod route;\n",
      "src/route.rs": "pub fn go() {}\n",
    };
    const board = await boardWith(
      [
        { id: "a", label: "route", ref: "src/route.rs" },
        { id: "b", label: "lib", ref: "src/lib.rs" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
  });

  it("confirms two Rust files a third one both reaches into", async () => {
    // Channel 3. Neither endpoint names the other; the crate root names both.
    const files = {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod request;\npub mod response;\n",
      "src/request.rs": "pub fn read() {}\n",
      "src/response.rs": "pub fn write() {}\n",
    };
    const board = await boardWith(
      [
        { id: "root", label: "lib", ref: "src/lib.rs" },
        { id: "a", label: "request", ref: "src/request.rs" },
        { id: "b", label: "response", ref: "src/response.rs" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toEqual([]);
  });

  it("flags an unconnected Rust arrow without claiming it read route strings", async () => {
    /*
     * The route channel is TypeScript's and was not widened with the gate. Both
     * files here write `"/users"`, which is exactly what that channel looks
     * for, and the arrow is still amber -- and the sentence names the three
     * channels that ran rather than the four a TypeScript arrow gets.
     *
     * A licence is per language. This channel has been measured on one.
     */
    const files = {
      "Cargo.toml": CARGO,
      "src/lib.rs": "pub mod alone;\npub mod other;\n",
      "src/alone.rs": 'pub fn a() { let _ = "/users"; }\n',
      "src/other.rs": 'pub fn b() { let _ = "/users"; }\n',
    };
    const board = await boardWith(
      [
        { id: "a", label: "alone", ref: "src/alone.rs" },
        { id: "b", label: "other", ref: "src/other.rs" },
      ],
      [{ from: "a", to: "b" }],
    );
    // No box for `src/lib.rs`, so it is not a shared-importer candidate and
    // channel 3 cannot rescue this the way the test above relies on.
    const report = checkDrift(board, treeWorkspace(files), { edges: true });
    expect(report.edgesChecked).toBe(1);
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].kind).toBe("unsupported-edge");
    expect(report.edges[0].detail).not.toContain("route string");
    expect(report.edges[0].detail).toContain("shares an importer with");
  });

  it("still names route strings for a TypeScript arrow", async () => {
    // The other half of the sentence above: the channel did not go away, it
    // only stopped claiming languages it was never measured on.
    const files = {
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    };
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(board, fakeWorkspace(files), { edges: true });
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].detail).toContain("shares a route string with");
  });

  it("stays silent about a language no licence names", async () => {
    // The gate is the licence, not "anything but TypeScript". Ruby has no
    // grammar and no corpus, so it gets the same silence it always did -- under
    // a name that is about the licence rather than about one regex.
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.rb" },
        { id: "b", label: "B", ref: "src/b.rb" },
      ],
      [{ from: "a", to: "b" }],
    );
    const report = checkDrift(
      board,
      fakeWorkspace({ "src/a.rb": "require_relative 'b'\n", "src/b.rb": "def go; end\n" }),
      { edges: true },
    );
    expect(report.edgesSkippedWhy).toEqual({ "unlicensed-language": 1 });
    expect(report.edges).toEqual([]);
  });
});

/**
 * Signatures that used to swallow the body.
 *
 * Both of these came out of running `scripts/audit-arrows.mts`, which checks
 * our verdicts against what the TypeScript compiler actually parses. Together
 * they were most of a 12.8% false-alarm rate on real call edges in this repo's
 * own `src/` -- calls that plainly exist, reported as absent.
 */
describe("reading a body past the signature", () => {
  it("does not mistake a generic return type for the body", () => {
    // `Array<{ ... }>` is a type. Reading it as the body meant every call in
    // the real body went unseen.
    const source = [
      "export function declarationsOf(",
      "  symbol: string,",
      "): Array<{ kind: string; body: string | undefined }> {",
      "  return [extentFrom(symbol)];",
      "}",
      "function extentFrom(s: string) { return s; }",
    ].join("\n");
    expect(bodyOf(source, "declarationsOf", "ts")).toContain("extentFrom");
    expect(reaches(source, "declarationsOf", ["extentFrom"], "ts")).toBe(true);
  });

  it("does not mistake a bare object return type for the body", () => {
    // `): { at: string } | undefined {` has two brace groups and only the
    // second is code. A type continues after `|`; a body does not.
    const source = [
      "export function chainBreak(",
      "  from: string,",
      "): { at: string; next: string } | undefined {",
      "  return names(from);",
      "}",
      "function names(s: string) { return { at: s, next: s }; }",
    ].join("\n");
    expect(bodyOf(source, "chainBreak", "ts")).toContain("names");
    expect(reaches(source, "chainBreak", ["names"], "ts")).toBe(true);
  });

  it("still reads an object literal assigned to a name as its value", () => {
    // The mirror of the above: here the braces really are the thing, and the
    // `;` after them is what says so.
    const source = "const shape = { corner: rounded() };\nfunction rounded() { return 1; }";
    expect(bodyOf(source, "shape", "ts")).toContain("rounded");
  });

  it("reads a method body past its first statement", () => {
    // The method pattern used to consume the opening brace, so extraction
    // began *inside* the body and stopped at the first semicolon. Anything
    // called on a later line looked absent.
    const source = [
      "export function makeWorkspace() {",
      "  return {",
      "    committed() {",
      "      const first = prepare();",
      "      return parseLater(first);",
      "    },",
      "  };",
      "}",
      "function prepare() { return 1; }",
      "function parseLater(n: number) { return n; }",
    ].join("\n");
    const body = bodyOf(source, "committed", "ts")!;
    expect(body).toContain("prepare");
    expect(body).toContain("parseLater");
    expect(reaches(source, "committed", ["parseLater"], "ts")).toBe(true);
  });
});

describe("deleted arrows — an arrow the code still supports was deleted", () => {
  const files = {
    "src/a.ts": 'import { b } from "./b";\nexport function a() { return b(); }\n',
    "src/b.ts": "export function b() { return 1; }\n",
  };

  async function boardWithEdge(fromRef: string, toRef: string) {
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: fromRef },
        { id: "b", label: "B", ref: toRef },
      ],
      [{ from: "a", to: "b" }],
    );
    return board;
  }

  it("reports a deleted arrow when the code still supports it", async () => {
    // Create a baseline board with an arrow
    const committedBoard = await boardWithEdge("src/a.ts", "src/b.ts");

    // Create a working board without the arrow
    const workingBoard = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [], // no edges
    );

    // Check with baseline
    const baseline = {
      committed: () => committedBoard,
    };

    const report = checkDrift(workingBoard, fakeWorkspace(files), {
      edges: true,
      baseline,
    });

    // Must unconditionally have deletedEdges
    expect(report.deletedEdges).toBeDefined();
    expect(report.deletedEdges).toHaveLength(1);
    expect(report.deletedEdges![0].from).toBe("src/a.ts");
    expect(report.deletedEdges![0].to).toBe("src/b.ts");
    // Should not affect clean/findings
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("stays silent when a deleted arrow had no corroboration anyway", async () => {
    // Create a baseline with an arrow between unconnected, unanchored files
    const unconnectedFiles = {
      "src/a.ts": "export function a() { return 1; }\n",
      "src/c.ts": "export function c() { return 1; }\n", // c does not import a
    };
    const committedBoard = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "c", label: "C", ref: "src/c.ts" },
      ],
      [{ from: "a", to: "c" }], // unconnected
    );

    const workingBoard = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "c", label: "C", ref: "src/c.ts" },
      ],
      [],
    );

    const baseline = {
      committed: () => committedBoard,
    };

    const report = checkDrift(workingBoard, fakeWorkspace(unconnectedFiles), {
      edges: true,
      baseline,
    });

    // Should not report since the deleted arrow had no support anyway
    expect(report.deletedEdges).toBeUndefined();
  });

  it("stays silent when arrow is still present on working board", async () => {
    const committedBoard = await boardWithEdge("src/a.ts", "src/b.ts");

    // Working board also has the arrow
    const workingBoard = await boardWithEdge("src/a.ts", "src/b.ts");

    const baseline = {
      committed: () => committedBoard,
    };

    const report = checkDrift(workingBoard, fakeWorkspace(files), {
      edges: true,
      baseline,
    });

    // Should not report since arrow is still there
    expect(report.deletedEdges).toBeUndefined();
  });
});

describe("dangling arrows — arrows that fail to resolve at one or both ends", () => {
  const files = {
    "src/a.ts": 'import { b } from "./b";\nexport function a() { return b(); }\n',
    "src/b.ts": "export function b() { return 1; }\n",
  };

  it("properly bound edges generate no strayArrows count", async () => {
    // When edges are properly declared/bound through diagram creation,
    // they resolve at both ends and generate no stray count
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [{ from: "a", to: "b" }],
    );

    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    // No strayArrows field when count is 0
    expect(report.strayArrows).toBeUndefined();
    // Should not affect clean
    expect(report.clean).toBe(true);
  });

  it("counts an arrow bound at neither end, floating in empty space", async () => {
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [{ from: "a", to: "b" }],
    );
    // A hand-drawn stroke: no bindings, no recorded edge, endpoints far from
    // every box, so neither binding nor proximity can resolve it.
    board.elements.push({
      id: "stray-floating",
      type: "arrow",
      x: 90_000,
      y: 90_000,
      width: 120,
      height: 0,
      points: [[0, 0], [120, 0]],
      startBinding: null,
      endBinding: null,
    });

    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.strayArrows).toBe(1);
    // An incomplete stroke is never a finding and never dirties the board.
    expect(report.clean).toBe(true);
    expect(report.findings).toHaveLength(0);
  });

  it("counts an arrow that resolves at one end only", async () => {
    const board = await boardWith(
      [
        { id: "a", label: "A", ref: "src/a.ts" },
        { id: "b", label: "B", ref: "src/b.ts" },
      ],
      [{ from: "a", to: "b" }],
    );
    // Start the stroke on top of box A (proximity resolves that end), and
    // leave the other end in empty space: still an incomplete stroke.
    const boxA = board.elements.find(
      (element) => element.type === "rectangle",
    )!;
    board.elements.push({
      id: "stray-one-end",
      type: "arrow",
      x: Number(boxA.x),
      y: Number(boxA.y),
      width: 90_000,
      height: 90_000,
      points: [[0, 0], [90_000, 90_000]],
      startBinding: null,
      endBinding: null,
    });

    const report = checkDrift(board, fakeWorkspace(files), { edges: true });

    expect(report.strayArrows).toBe(1);
    expect(report.clean).toBe(true);
  });

});

describe("code graph — the fifth corroboration channel", () => {
  /** A tiny graphify export, parsed through the real loader. */
  function fixtureGraph(
    nodes: Array<[id: string, file: string]>,
    links: Array<[source: string, target: string, relation?: string]>,
  ) {
    const graph = loadCodeGraph(
      {
        nodes: nodes.map(([id, source_file]) => ({ id, source_file })),
        links: links.map(([source, target, relation]) => ({
          source,
          target,
          relation: relation ?? "calls",
          confidence: "EXTRACTED",
        })),
      },
      "0.9.47",
    );
    expect(graph).toBeDefined();
    return graph!;
  }

  const files = {
    "src/a.ts": "export function callC() {}",
    "src/b.ts": "export function called() {}",
    "src/c.ts": "import { callC } from './a'; callC();",
  };

  async function arrowAB(fromRef = "src/a.ts", toRef = "src/b.ts") {
    return boardWith(
      [
        { id: "a", label: "A", ref: fromRef },
        { id: "b", label: "B", ref: toRef },
      ],
      [{ from: "a", to: "b" }],
    );
  }

  // A chain a → c → b: the dependency flows end to end through another file.
  const chain = () =>
    fixtureGraph(
      [["a_fn", "src/a.ts"], ["c_helper", "src/c.ts"], ["b_target", "src/b.ts"]],
      [["a_fn", "c_helper"], ["c_helper", "b_target"]],
    );

  it("corroborates an arrow no other channel can confirm", async () => {
    const board = await arrowAB();

    const without = checkDrift(board, fakeWorkspace(files), { edges: true });
    expect(without.edges).toHaveLength(1);
    expect(without.edges[0].kind).toBe("unsupported-edge");

    const withGraph = checkDrift(board, fakeWorkspace(files), {
      edges: true,
      codeGraph: { graph: chain(), modified: new Set() },
    });
    expect(withGraph.edges).toHaveLength(0);
    expect(withGraph.clean).toBe(true);
  });

  it("does not trust the graph for a file edited since it was built", async () => {
    const board = await arrowAB();
    const report = checkDrift(board, fakeWorkspace(files), {
      edges: true,
      codeGraph: { graph: chain(), modified: new Set(["src/a.ts"]) },
    });
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].kind).toBe("unsupported-edge");
  });

  it("stays exactly as before when no graph is given", async () => {
    const report = checkDrift(await arrowAB(), fakeWorkspace(files), { edges: true });
    expect(report.edges).toHaveLength(1);
    expect(report.edges[0].kind).toBe("unsupported-edge");
  });

  it("checks an arrow whose end is a directory", async () => {
    // src/sub is a directory; the graph knows a file inside it that b reaches.
    const workspace: Workspace = {
      resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
      stat: (target) =>
        target === "src/sub" ? "directory" : files[target as keyof typeof files] === undefined ? "missing" : "file",
      read: (target) => files[target as keyof typeof files] ?? "",
      list: () => [],
    };
    const graph = fixtureGraph(
      [["inner", "src/sub/inner.ts"], ["b_target", "src/b.ts"]],
      [["inner", "b_target"]],
    );
    const board = await arrowAB("src/sub", "src/b.ts");

    const without = checkDrift(board, workspace, { edges: true });
    expect(without.edgesSkippedWhy["directory-ref"]).toBe(1);

    const withGraph = checkDrift(board, workspace, {
      edges: true,
      codeGraph: { graph, modified: new Set() },
    });
    expect(withGraph.edgesSkippedWhy["directory-ref"]).toBeUndefined();
    expect(withGraph.edgesChecked).toBe(1);
    expect(withGraph.edges).toHaveLength(0);

    // Editing anything under the directory turns the graph off for it.
    const stale = checkDrift(board, workspace, {
      edges: true,
      codeGraph: { graph, modified: new Set(["src/sub/inner.ts"]) },
    });
    expect(stale.edgesSkippedWhy["directory-ref"]).toBe(1);
  });

  it("checks an arrow between files the channels cannot read", async () => {
    const pyFiles = {
      "src/x.py": "from y import go\ngo()\n",
      "src/y.py": "def go(): pass\n",
    };
    const graph = fixtureGraph(
      [["x", "src/x.py"], ["y_go", "src/y.py"]],
      [["x", "y_go", "imports"]],
    );
    const board = await arrowAB("src/x.py", "src/y.py");

    const without = checkDrift(board, fakeWorkspace(pyFiles), { edges: true });
    expect(without.edgesSkippedWhy["unlicensed-language"]).toBe(1);

    const withGraph = checkDrift(board, fakeWorkspace(pyFiles), {
      edges: true,
      codeGraph: { graph, modified: new Set() },
    });
    expect(withGraph.edgesSkippedWhy["unlicensed-language"]).toBeUndefined();
    expect(withGraph.edgesChecked).toBe(1);
    expect(withGraph.edges).toHaveLength(0);
  });

  it("never confirms an arrow whose two ends are the same file", async () => {
    // Two boxes on one file, drawn as an arrow between them. The graph holds
    // no edge between the endpoints -- there is nothing it could confirm --
    // but both ends expand to the same node set, which used to read as
    // "reaches". An honest amber must stay amber, and stay uncounted.
    const soloFiles = { "src/solo.ts": "function one() {}\nfunction two() {}\n" };
    const graph = fixtureGraph(
      [["one", "src/solo.ts"], ["two", "src/solo.ts"]],
      [["one", "two"]],
    );
    const board = await arrowAB("src/solo.ts", "src/solo.ts");

    const without = checkDrift(board, fakeWorkspace(soloFiles), { edges: true });
    expect(without.edges).toHaveLength(1);
    expect(without.edges[0].kind).toBe("unsupported-edge");

    const withGraph = checkDrift(board, fakeWorkspace(soloFiles), {
      edges: true,
      codeGraph: { graph, modified: new Set() },
    });
    expect(withGraph.edges).toHaveLength(1);
    expect(withGraph.edges[0].kind).toBe("unsupported-edge");
    expect(withGraph.edgesChecked).toBe(without.edgesChecked);
  });

  it("never confirms a subsystem arrow pointing at a file inside itself", async () => {
    // src/sub → src/sub/inner.ts, the everyday "subsystem and its part" shape.
    // The directory's node set contains the file's, so the walk would start on
    // its goal. The graph holds no edge between them, so this stays a skip.
    const workspace: Workspace = {
      resolve: (relative) => (relative.startsWith("../") ? undefined : relative),
      stat: (target) =>
        target === "src/sub"
          ? "directory"
          : target === "src/sub/inner.ts"
            ? "file"
            : files[target as keyof typeof files] === undefined ? "missing" : "file",
      read: () => "",
      list: () => [],
    };
    const graph = fixtureGraph(
      [["inner", "src/sub/inner.ts"], ["other", "src/sub/other.ts"]],
      [["other", "inner"]],
    );
    const board = await arrowAB("src/sub", "src/sub/inner.ts");

    const report = checkDrift(board, workspace, {
      edges: true,
      codeGraph: { graph, modified: new Set() },
    });
    expect(report.edgesSkippedWhy["directory-ref"]).toBe(1);
    expect(report.edgesChecked).toBe(0);
    expect(report.edges).toHaveLength(0);
  });

  it("a graph that proves nothing leaves the skip in place, never an alarm", async () => {
    const pyFiles = {
      "src/x.py": "print(1)\n",
      "src/y.py": "print(2)\n",
    };
    // The graph knows both files but no chain between them.
    const graph = fixtureGraph(
      [["x", "src/x.py"], ["y", "src/y.py"]],
      [],
    );
    const board = await arrowAB("src/x.py", "src/y.py");
    const report = checkDrift(board, fakeWorkspace(pyFiles), {
      edges: true,
      codeGraph: { graph, modified: new Set() },
    });
    expect(report.edgesSkippedWhy["unlicensed-language"]).toBe(1);
    expect(report.edges).toHaveLength(0);
    expect(report.clean).toBe(true);
  });
});
