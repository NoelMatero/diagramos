/**
 * Calls the text already settles, read as what they are (#460, map pattern 3).
 *
 * A wrong `@calls` arrow goes red only when every call in the tail was
 * placed and none is the head. One call left unplaced keeps the whole body
 * "not sure" -- right as a rule, wrong where the language itself says what
 * the call is. Each block here is one such language fact, with the shapes
 * that must stay a doubt beside it.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { callsBetween, type CallSide, type CallsVerdict } from "../src/engine/calls";
import { initEngine, type Language } from "../src/engine/parse";

beforeAll(async () => { await initEngine(); }, 120_000);

type Files = Record<string, { source: string; language: Language; imports?: Array<[string, string?]> }>;

function ask(files: Files, from: { file: string; routine: string }, to: { file: string; names: string[] }): string {
  const sideOf = (file: string): CallSide => {
    const one = files[file]!;
    const imports = (one.imports ?? []).map(([specifier, target]) => ({ specifier, ...(target ? { file: target } : {}) }));
    return {
      file, source: one.source, language: one.language, imports,
      open: (wanted) => {
        const other = files[wanted];
        return other ? { source: other.source, language: other.language, imports: (other.imports ?? [])
          .map(([specifier, target]) => ({ specifier, ...(target ? { file: target } : {}) })) } : undefined;
      },
    };
  };
  const verdict: CallsVerdict = callsBetween({ ...sideOf(from.file), routine: from.routine }, { ...sideOf(to.file), names: to.names });
  return verdict.verdict === "withheld" ? `withheld/${verdict.why}` : verdict.verdict;
}

/*
 * A function written and called on the spot -- `((t) => ...)(x)`,
 * `(function* (d) { ... })(x)`, `(lambda y: ...)(x)`, `(|y| ...)(x)` -- runs
 * the body written right there, whose calls are already the routine's own
 * (drizzle's `buildSelectQuery`, zx's `retry`). Read as a call of a value it
 * stopped the body as though it could run anything.
 */
describe("a function written and called on the spot runs what is written there", () => {
  const ts = (body: string) => ask({
    "src/a.ts": { source: `function helper(n: number) { return n; }\nexport function run(x: number) {\n${body}\n}\n`, language: "ts" },
    "src/b.ts": { source: "export function other() { return 1; }\n", language: "ts" },
  }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["other"] });

  it("refutes past an arrow function called on the spot (TypeScript)", () => {
    expect(ts("  return ((t: number) => helper(t))(x);")).toBe("refuted");
    expect(ts("  return (async () => helper(x))();")).toBe("refuted");
  });

  it("refutes past a generator written and called on the spot (TypeScript)", () => {
    expect(ts("  return (function* (d: number) { while (true) yield helper(d); })(x);")).toBe("refuted");
  });

  it("refutes past a lambda called on the spot (Python)", () => {
    expect(ask({
      "app/a.py": { source: "def helper(n):\n    return n\n\ndef run(x):\n    return (lambda y: helper(y))(x) + (lambda: 1)()\n", language: "python" },
      "app/b.py": { source: "def other():\n    return 1\n", language: "python" },
    }, { file: "app/a.py", routine: "run" }, { file: "app/b.py", names: ["other"] })).toBe("refuted");
  });

  it("refutes past a closure called on the spot (Rust)", () => {
    expect(ask({
      "src/a.rs": { source: "fn helper(n: u32) -> u32 { n }\n\nfn run(x: u32) -> u32 {\n    (|y: u32| helper(y))(x)\n}\n", language: "rust" },
      "src/b.rs": { source: "pub fn other() -> u32 { 1 }\n", language: "rust" },
    }, { file: "src/a.rs", routine: "run" }, { file: "src/b.rs", names: ["other"] })).toBe("refuted");
  });

  it("confirms when the function written on the spot calls the head", () => {
    expect(ask({
      "src/a.ts": { source: 'import { other } from "./b";\nexport function run(x: number) {\n  return ((t: number) => other(t))(x);\n}\n', language: "ts", imports: [["./b", "src/b.ts"]] },
      "src/b.ts": { source: "export function other(n: number) { return n; }\n", language: "ts" },
    }, { file: "src/a.ts", routine: "run" }, { file: "src/b.ts", names: ["other"] })).toBe("confirmed");
  });

  it("stays quiet when the value called is not written on the spot", () => {
    expect(ts("  return (pick(x))(x);")).not.toBe("refuted");
    expect(ts("  const f = (globalThis as any).f;\n  return (f)(x);")).not.toBe("refuted");
  });
});

