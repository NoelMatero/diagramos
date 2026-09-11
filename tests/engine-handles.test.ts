/**
 * Reading a dispatch's cases, one shape per test.
 *
 * A shape here is a distinct way a dispatch occurs in real source, not a branch
 * of the reader -- `AGENTS.md`'s item 2. `Method::Get`, `case "GET":`, a
 * discriminated union, a Python `match`, an `if`/`elif` chain and a table built
 * at run time are six different problems wearing one word, and a single test on
 * the easy one is how this ships half-done and reads as finished.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { initEngine, parseSource, type Language } from "../src/engine/parse";
import { findDispatches } from "../src/engine/handles";

beforeAll(async () => {
  await initEngine();
});

/** Every dispatch in a snippet, so a test can name the one it means. */
function read(source: string, language: Language) {
  const tree = parseSource(source, language);
  if (!tree) throw new Error(`no grammar for ${language}`);
  return findDispatches(tree, source, language);
}

const names = (cases: Array<{ name: string }>) => cases.map((c) => c.name);

describe("a Rust match on an enum", () => {
  /*
   * The shape #206 calls the strongest case. Note what is deliberately awkward
   * about it: the arms are paths (`Method::Get`), one arm carries two variants
   * behind a `|`, and the result of each arm is an integer that must not be
   * read as a case.
   */
  const SOURCE = `
enum Method { Get, Post, Delete, Put }

fn status(m: Method) -> u16 {
    match m {
        Method::Get => 200,
        Method::Post => 201,
        Method::Delete | Method::Put => 204,
    }
}`;

  it("names the subject and every variant, and no arm's result", () => {
    const [dispatch, ...rest] = read(SOURCE, "rust");
    expect(rest).toEqual([]);
    expect(dispatch.subject).toBe("m");
    expect(names(dispatch.cases)).toEqual(["Get", "Post", "Delete", "Put"]);
  });

  it("reports no catch-all, which is what makes the claim refutable", () => {
    expect(read(SOURCE, "rust")[0].catchAll).toBe(false);
  });

  it("reads every shape in it, so nothing counts against the claim", () => {
    expect(read(SOURCE, "rust")[0].unreadable).toEqual([]);
  });

  it("gives each case the line it is written on", () => {
    const [dispatch] = read(SOURCE, "rust");
    // `Method::Get => 200,` is the 6th line of SOURCE, which opens with a newline.
    expect(dispatch.cases[0].line).toBe(6);
    expect(dispatch.cases[3].line).toBe(8);
  });
});

describe("a TypeScript switch on string literals", () => {
  /*
   * Two things here that the Rust shape does not have: a fallthrough, where
   * `case "DELETE":` carries no body at all and the next case does the work,
   * and a `default:`, which the grammar spells as a node with a consequence
   * and no label rather than as a wildcard pattern.
   */
  const SOURCE = `
function status(m: string): number {
  switch (m) {
    case "GET": return 200;
    case "POST": return 201;
    case "DELETE":
    case "PUT": return 204;
    default: return 405;
  }
}`;

  it("reads the quoted labels without their quotes, fallthrough included", () => {
    const [dispatch, ...rest] = read(SOURCE, "ts");
    expect(rest).toEqual([]);
    expect(names(dispatch.cases)).toEqual(["GET", "POST", "DELETE", "PUT"]);
  });

  it("takes the parentheses off the subject, which Rust does not write", () => {
    expect(read(SOURCE, "ts")[0].subject).toBe("m");
  });

  it("reports the default as a catch-all, so the claim cannot be refuted", () => {
    expect(read(SOURCE, "ts")[0].catchAll).toBe(true);
  });

  it("never reads an arm's result as a case, which `value` would", () => {
    /*
     * `value` is the label on a `switch_case` and the arm's *result* on a Rust
     * `match_arm`, so a reader trusting that one field name is precise in one
     * language and wrong in the other. Both directions asserted, because the
     * bug is only visible from both.
     */
    expect(names(read(SOURCE, "ts")[0].cases)).not.toContain("200");
    const rust = read(`fn s(m: M) -> u16 { match m { M::Get => 200, M::Post => 201 } }`, "rust");
    expect(names(rust[0].cases)).toEqual(["Get", "Post"]);
  });

  it("reads the same shape in JavaScript, which declares no types", () => {
    const js = read(`
function status(m) {
  switch (m) {
    case "GET": return 200;
    case "POST": return 201;
  }
}`, "js");
    expect(names(js[0].cases)).toEqual(["GET", "POST"]);
    expect(js[0].catchAll).toBe(false);
  });
});

describe("a switch over a discriminated union", () => {
  /*
   * The shape #206 names beside the plain `switch`, and the one where the
   * subject is not a bare name. `a.kind` has to come back whole: a box says
   * `handles` about the routine and the subject is how a reader tells which
   * dispatch in the file was meant.
   */
  const SOURCE = `
type Action =
  | { kind: "add"; n: number }
  | { kind: "remove"; id: string }
  | { kind: "clear" };

function reduce(a: Action): number {
  switch (a.kind) {
    case "add": return a.n;
    case "remove": return 0;
  }
  return -1;
}`;

  it("keeps a member read as the subject rather than unwrapping it", () => {
    expect(read(SOURCE, "ts")[0].subject).toBe("a.kind");
  });

  it("reads the two cases written, and does not invent the third", () => {
    // `clear` is in the union and not in the switch. That gap is the bug this
    // word exists to catch, and it is not the reader's job to close it here:
    // this reads what the dispatch says, and the comparison happens above.
    const [dispatch] = read(SOURCE, "ts");
    expect(names(dispatch.cases)).toEqual(["add", "remove"]);
    expect(dispatch.catchAll).toBe(false);
  });
});

describe("a Python match statement", () => {
  /*
   * Python spells every part of this differently -- `subject` rather than
   * `value`, `case_clause` rather than `switch_case`, and a plain `block` for
   * the body, which is the same node a `for` loop uses. It also writes its
   * wildcard as `case _`, where TypeScript writes `default:`.
   */
  const SOURCE = `
def status(m):
    match m:
        case "GET":
            return 200
        case "POST" | "PUT":
            return 201
        case _:
            return 405`;

  it("reads the subject out of a differently named field", () => {
    expect(read(SOURCE, "python")[0].subject).toBe("m");
  });

  it("splits an alternation into one case each", () => {
    expect(names(read(SOURCE, "python")[0].cases)).toEqual(["GET", "POST", "PUT"]);
  });

  it("reads a Python string cleanly, which it did not before the `|` fix", () => {
    /*
     * Pinned because the names above were already right while `unreadable` was
     * quietly collecting `string_start` and `string_end` twice per case.
     * Asserting only the names is how that shipped green.
     */
    expect(read(SOURCE, "python")[0].unreadable).toEqual([]);
  });

  it("reads `case _` as the same catch-all TypeScript spells `default`", () => {
    expect(read(SOURCE, "python")[0].catchAll).toBe(true);
  });
});

describe("the one list, tested for completeness rather than contents", () => {
  /*
   * `reading-a-grammar.md`'s rule: a list that must exist gets a test that
   * every entry has an answer, so the two halves cannot drift. Four languages
   * because a single-language corpus turns a stale list into a confident wrong
   * answer, which has happened here several times.
   */
  const ONE_EACH: Array<[Language, string]> = [
    ["rust", `fn f(m: M) -> u8 { match m { M::A => 1, M::B => 2 } }`],
    ["ts", `function f(m: string) { switch (m) { case "a": return 1; case "b": return 2; } }`],
    ["tsx", `function f(m: string) { switch (m) { case "a": return 1; case "b": return 2; } }`],
    ["js", `function f(m) { switch (m) { case "a": return 1; case "b": return 2; } }`],
    ["python", `def f(m):\n    match m:\n        case "a":\n            return 1\n        case "b":\n            return 2`],
  ];

  it.each(ONE_EACH)("finds a dispatch of two cases in %s", (language, source) => {
    const found = read(source, language);
    expect(found).toHaveLength(1);
    expect(names(found[0].cases)).toEqual(["a", "b"].map((n) => (language === "rust" ? n.toUpperCase() : n)));
    expect(found[0].unreadable).toEqual([]);
  });
});

describe("an if/elif chain", () => {
  /*
   * The weakest of the shapes and the one #206 says so about: nothing enforces
   * exhaustiveness here, so the claim is about what is written rather than
   * about what is complete. It is still a closed set of cases somebody wrote
   * down, which is what the word asserts.
   */
  const PYTHON = `
def status(m):
    if m == "GET":
        return 200
    elif m == "POST":
        return 201
    elif m == "PUT":
        return 204
    else:
        return 405`;

  it("reads every link of a Python chain, and the trailing else as a catch-all", () => {
    const [dispatch, ...rest] = read(PYTHON, "python");
    expect(rest).toEqual([]);
    expect(dispatch.subject).toBe("m");
    expect(names(dispatch.cases)).toEqual(["GET", "POST", "PUT"]);
    expect(dispatch.catchAll).toBe(true);
  });

  it("reads the same chain in TypeScript, where `else if` is a nested if", () => {
    const [dispatch, ...rest] = read(`
function status(m: string): number {
  if (m === "GET") { return 200; }
  else if (m === "POST") { return 201; }
  else { return 405; }
}`, "ts");
    // One dispatch, not one per link: an `else if` is an `if` inside an
    // `else`, so a depth-first walk meets it twice.
    expect(rest).toEqual([]);
    expect(names(dispatch.cases)).toEqual(["GET", "POST"]);
    expect(dispatch.catchAll).toBe(true);
  });

  it("reads the same chain in Rust, where the operator is on a field", () => {
    const [dispatch] = read(
      `fn s(m: &str) -> u8 { if m == "GET" { 1 } else if m == "POST" { 2 } else { 0 } }`,
      "rust",
    );
    expect(names(dispatch.cases)).toEqual(["GET", "POST"]);
  });

  it("withholds when the links do not all ask about the same thing", () => {
    /*
     * The gate, and the reason this shape is read separately. Two unrelated
     * questions in sequence is ordinary control flow; calling it a two-case
     * dispatch would put a case set on a routine that never had one.
     */
    expect(read(`
function go(ready: boolean, count: number) {
  if (ready === true) { return 1; }
  else if (count === 3) { return 2; }
}`, "ts")).toEqual([]);
  });

  it("withholds on a comparison that is not equality", () => {
    expect(read(`
function go(n: number) {
  if (n > 3) { return 1; }
  else if (n > 1) { return 2; }
}`, "ts")).toEqual([]);
  });

  it("withholds on a single if, which is a condition and not a set", () => {
    expect(read(`function go(m: string) { if (m === "GET") { return 1; } }`, "ts")).toEqual([]);
  });
});

describe("a dispatch built at run time, which must withhold", () => {
  /*
   * #206's last required shape. A table of handlers is a real dispatch and its
   * cases are not written down anywhere a reader can enumerate -- they are
   * whatever was put in the map, possibly in another file, possibly in a loop.
   * There is no closed region, so there is nothing to claim.
   */
  it("says nothing about a handler table, because it is not a case list", () => {
    expect(read(`
const handlers: Record<string, () => number> = {};
export function register(name: string, fn: () => number) { handlers[name] = fn; }
export function dispatch(name: string) { return handlers[name](); }`, "ts")).toEqual([]);
  });

  it("names the shape it could not read rather than shortening the case list", () => {
    /*
     * A computed label inside a real `switch`. The cases it *can* read are
     * reported, and the one it cannot is named by node type -- which counts
     * against the claim rather than for it. A reader that silently skipped it
     * would report a two-case dispatch that has three.
     */
    const [dispatch] = read(`
const KEYS = ["a", "b"];
function f(m: string) {
  switch (m) {
    case "GET": return 1;
    case KEYS[0]: return 2;
    case "PUT": return 3;
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["GET", "PUT"]);
    expect(dispatch.unreadable).toEqual(["subscript_expression"]);
  });
});

describe("a case label that is not an identifier, found by running it on real code", () => {
  /*
   * Four labels came back unreadable across this repo and `rust-test`, and
   * every one was an ordinary constant whose text is simply not an identifier.
   * The reader was applying an identifier test -- right for an enum variant,
   * wrong for a string -- to both. Pinned here by the real shapes.
   */
  it("reads an LSIF label with a slash in it", () => {
    // scripts/lib/licence-rust.ts dispatches on exactly these.
    const [dispatch] = read(`
function on(label: string) {
  switch (label) {
    case "metaData": return 1;
    case "textDocument/hover": return 2;
    case "textDocument/definition": return 3;
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["metaData", "textDocument/hover", "textDocument/definition"]);
    expect(dispatch.unreadable).toEqual([]);
  });

  it("reads a Rust type name with colons and an ampersand in it", () => {
    // rust-test/.../response.rs dispatches on exactly these.
    const [dispatch] = read(`
fn set(&mut self, payload: P) {
    match type_of(&payload) {
        "serde_json::value::Value" => {}
        "&str" | "String" => {}
        _ => {}
    }
}`, "rust");
    expect(names(dispatch.cases)).toEqual(["serde_json::value::Value", "&str", "String"]);
    expect(dispatch.unreadable).toEqual([]);
    expect(dispatch.catchAll).toBe(true);
  });

  it("still refuses a template whose value is different on every call", () => {
    const [dispatch] = read(`
function f(k: string, id: number) {
  switch (k) {
    case "plain": return 1;
    case \`row-\${id}\`: return 2;
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["plain"]);
    expect(dispatch.unreadable).toEqual(["template_string"]);
  });
});

describe("a catch-all that is not the only thing in its branch", () => {
  /*
   * Found by running the reader over sixteen real trees, and the reason it
   * matters is the direction of the mistake: a `default:` misread as a
   * labelled case is reported as **no catch-all**, so a routine that quietly
   * swallows every unlisted case looks like one that enumerates them, and a
   * claim on it looks refutable when it is not. A false red.
   */
  it("still finds the catch-all when the default holds two statements", () => {
    // django/contrib/admin/static/admin/js/popup_response.js, reduced.
    const [dispatch] = read(`
function go(action, value) {
  switch (action) {
    case "change":
      dismissChange(window, value);
      break;
    default:
      dismissAdd(window, value);
      break;
  }
}`, "js");
    expect(names(dispatch.cases)).toEqual(["change"]);
    expect(dispatch.catchAll).toBe(true);
    expect(dispatch.unreadable).toEqual([]);
  });

  it("still finds it when a comment sits in the branch", () => {
    // packages/vite/src/node/build.ts, reduced.
    const [dispatch] = read(`
function log(level: string, message: string) {
  switch (level) {
    case "info":
      logger.info(message);
      return;
    default:
      // nothing to do
      return;
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["info"]);
    expect(dispatch.catchAll).toBe(true);
    expect(dispatch.unreadable).toEqual([]);
  });

  it("does not read a comment between the cases as a case", () => {
    const [dispatch] = read(`
function f(m: string) {
  switch (m) {
    case "a": return 1;
    // b is handled upstream
    case "c": return 2;
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["a", "c"]);
    expect(dispatch.catchAll).toBe(false);
    expect(dispatch.unreadable).toEqual([]);
  });
});

describe("a case read off an enum or a namespace", () => {
  /*
   * The commonest shape the reader could not name on real code: 271 of 4,905
   * cases across sixteen trees. The last segment is the case, which is the
   * answer Rust already gives for `Method::Get`, so a box's list means the
   * same thing in both languages.
   */
  it("reads a TypeScript enum member as its last segment", () => {
    const [dispatch] = read(`
enum Status { Active, Pending, Closed }
function label(s: Status): string {
  switch (s) {
    case Status.Active: return "on";
    case Status.Pending: return "wait";
  }
}`, "ts");
    expect(names(dispatch.cases)).toEqual(["Active", "Pending"]);
    expect(dispatch.unreadable).toEqual([]);
  });

  it("reads a Python attribute the same way", () => {
    const [dispatch] = read(`
def label(s):
    match s:
        case Status.ACTIVE:
            return "on"
        case Status.PENDING:
            return "wait"`, "python");
    expect(names(dispatch.cases)).toEqual(["ACTIVE", "PENDING"]);
    expect(dispatch.unreadable).toEqual([]);
  });

  it("agrees with Rust, which writes the same thing with colons", () => {
    const [dispatch] = read(
      `fn label(s: Status) -> u8 { match s { Status::Active => 1, Status::Pending => 2 } }`,
      "rust",
    );
    expect(names(dispatch.cases)).toEqual(["Active", "Pending"]);
  });
});
