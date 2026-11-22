/**
 * An arrow from a class or struct to a name that is also one of that class's
 * own fields: bat's `Input --@calls--> input.rs#description`.
 *
 * The bad outcome: `Input` has a field `description` and a method
 * `description()`, and the arrow's far end names `description` in the same
 * file. The board does not say which one it means. The answer key reads a
 * name declared inside the tail as the tail's own (#428's rule for a
 * routine's locals, which #346 extended to a class tail), so to the key the
 * arrow points at the field, which nothing calls -- false. The checker read
 * `self.description()`, placed it in that file under that name, and said
 * green. Since #499 made class tails checkable this was the one new
 * confirmation the key calls false on the study sets' class-tail arrows (1 of
 * 392 greens), and the same shape -- a field named like a routine in its file,
 * the getter pattern -- is common in Rust.
 *
 * A call is placed by file and name, so it cannot tell the two apart. The
 * honest answer is "not sure", and never red: the class may well call the
 * routine.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { emptyBoard } from "../src/engine/board-file";
import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import type { CompiledCrate } from "../src/engine/compiled-calls";
import { createDiagram } from "../src/engine/diagram";
import { ACCUSING_EDGE_KINDS, checkDrift, type Workspace } from "../src/engine/drift";
import { initEngine, type Language } from "../src/engine/parse";
import { installExcalifontMeasurer } from "./helpers/excalifont";

installExcalifontMeasurer();

beforeAll(async () => { await initEngine(); }, 120_000);

interface FileSpec { source: string; language: Language }

function ask(file: string, spec: FileSpec, from: string, to: string[], crate?: string[]): CallsVerdict {
  const side: CallSide = {
    file,
    source: spec.source,
    language: spec.language,
    imports: [],
    open: () => undefined,
    ...(crate ? { compiled: (): CompiledCrate => ({ files: new Set(crate), root: crate[0]!, byImpl: new Map(), byName: new Map() }) } : {}),
  };
  return callsBetween({ ...side, routine: from }, { ...side, names: to });
}

const RED = new Set(["refuted", "wrong-routine", "backwards"]);
const said = (verdict: CallsVerdict): "red" | "green" | "not sure" =>
  verdict.verdict === "confirmed" ? "green" : RED.has(verdict.verdict) ? "red" : "not sure";

const RUST_GETTER: FileSpec = {
  language: "rust",
  source: [
    "pub struct Input {",
    "    description: String,",
    "}",
    "",
    "impl Input {",
    "    pub fn description(&self) -> &str {",
    "        &self.description",
    "    }",
    "",
    "    pub fn show(&self) -> usize {",
    "        self.description().len()",
    "    }",
    "}",
    "",
  ].join("\n"),
};

const RUST_FREE_FN: FileSpec = {
  language: "rust",
  source: [
    "pub struct ErrorImpl {",
    "    vtable: u32,",
    "}",
    "",
    "fn vtable(n: u32) -> u32 {",
    "    n",
    "}",
    "",
    "impl ErrorImpl {",
    "    pub fn go(&self) -> u32 {",
    "        vtable(self.vtable)",
    "    }",
    "}",
    "",
  ].join("\n"),
};

const TS_FIELD: FileSpec = {
  language: "ts",
  source: [
    "export function handler(n: number) { return n; }",
    "",
    "export class Router {",
    "  handler = 0;",
    "  route() { return handler(this.handler); }",
    "}",
    "",
  ].join("\n"),
};

const PY_FIELD: FileSpec = {
  language: "python",
  source: [
    "def handler(n):",
    "    return n",
    "",
    "",
    "class Router:",
    "    handler = 0",
    "",
    "    def route(self):",
    "        return handler(self.handler)",
    "",
  ].join("\n"),
};

describe("the far end names one of the class's own fields and a routine both: not sure, never green", () => {
  it("Rust: a field and its getter method (bat's Input.description)", () => {
    expect(said(ask("src/input.rs", RUST_GETTER, "Input", ["description"], ["src/lib.rs", "src/input.rs"]))).toBe("not sure");
  });

  it("Rust: a field and a free function of that name (anyhow's ErrorImpl.vtable)", () => {
    expect(said(ask("src/error.rs", RUST_FREE_FN, "ErrorImpl", ["vtable"], ["src/lib.rs", "src/error.rs"]))).toBe("not sure");
  });

  it("TypeScript: a class property and a function of that name", () => {
    expect(said(ask("src/router.ts", TS_FIELD, "Router", ["handler"]))).toBe("not sure");
  });

  it("TypeScript: a constructor parameter that is also a property, and a function of that name", () => {
    const source = TS_FIELD.source.replace("  handler = 0;\n", "  constructor(private handler: number) {}\n");
    expect(said(ask("src/router.ts", { ...TS_FIELD, source }, "Router", ["handler"]))).toBe("not sure");
  });

  it("Python: a class attribute and a function of that name", () => {
    expect(said(ask("app/router.py", PY_FIELD, "Router", ["handler"]))).toBe("not sure");
  });
});

describe("what keeps its answer", () => {
  it("Rust: the same calls, to a routine no field of the class is named like, stay green", () => {
    const source = RUST_GETTER.source.replace("description: String", "text: String").replace("&self.description", "&self.text");
    expect(said(ask("src/input.rs", { ...RUST_GETTER, source }, "Input", ["description"], ["src/lib.rs", "src/input.rs"]))).toBe("green");
  });

  it("TypeScript: a method of the class named like a function of the file stays green (a method is not a field)", () => {
    const source = TS_FIELD.source.replace("  handler = 0;\n", "  handler() { return 0; }\n").replace("handler(this.handler)", "this.handler()");
    expect(said(ask("src/router.ts", { ...TS_FIELD, source }, "Router", ["handler"]))).toBe("green");
  });

  it("TypeScript: a constructor whose parameter is not a property leaves the class green", () => {
    const source = TS_FIELD.source.replace("  handler = 0;\n", "  constructor(handler: number) {}\n").replace("handler(this.handler)", "handler(1)");
    expect(said(ask("src/router.ts", { ...TS_FIELD, source }, "Router", ["handler"]))).toBe("green");
  });

  it("a routine at the tail is untouched: a parameter or local named like the far end is not a field", () => {
    const source = "export function handler(n: number) { return n; }\nexport function route(handler2: number) { return handler(handler2); }\n";
    expect(said(ask("src/router.ts", { source, language: "ts" }, "route", ["handler"]))).toBe("green");
  });
});

describe("in a whole check, the arrow is neither green nor red", () => {
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

  for (const [name, file, spec, tail, head] of [
    ["Rust getter", "src/input.rs", RUST_GETTER, "Input", "description"],
    ["TypeScript property", "src/router.ts", TS_FIELD, "Router", "handler"],
    ["Python attribute", "app/router.py", PY_FIELD, "Router", "handler"],
  ] as const) {
    it(name, async () => {
      const { board } = await createDiagram(emptyBoard(), {
        name: "arch",
        nodes: [
          { id: "tail", label: tail, ref: `${file}#${tail}` },
          { id: "head", label: head, ref: `${file}#${head}` },
        ],
        edges: [{ from: "tail", to: "head", claim: "calls" }],
      });
      const report = checkDrift(board, fakeWorkspace({ [file]: spec.source }), { edges: true });
      expect(report.edges.filter((edge) => (ACCUSING_EDGE_KINDS as readonly string[]).includes(edge.kind))).toEqual([]);
      expect(report.claims.callsConfirmed).toBe(0);
    });
  }
});
