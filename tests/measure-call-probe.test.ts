/**
 * The referee `measure:parts --compiler` licenses #343 with: write the call,
 * ask a checker whether it compiles (`scripts/lib/call-probe.ts`).
 *
 * Every shape below is one that fooled the referee on the corpus -- not the
 * reader. A referee that says "accepted" where nobody checked the line makes a
 * right reading look wrong, and one that says "refused" where it misread the
 * output would make a wrong reading look right. Each case pins the checker's
 * own answer, or the referee's refusal to give one.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { probeCallsPython, probeCallsTs, probeKey } from "../scripts/lib/call-probe";
import { mypyCommand } from "../scripts/lib/resolution-python-mypy";

let tree: string;

function write(relative: string, contents: string): string {
  const full = path.join(tree, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

/** The 0-based line `text` starts on. */
const lineOf = (source: string, text: string) => source.slice(0, source.indexOf(text)).split("\n").length - 1;

beforeEach(() => {
  // Outside the worktree: a scratch source file inside one is read by the
  // dependency tests as though it belonged to this repository.
  tree = mkdtempSync(path.join(tmpdir(), "call-probe-"));
});

afterEach(() => {
  rmSync(tree, { recursive: true, force: true });
});

describe("TypeScript", () => {
  const SOURCE = [
    "export class Box { count = 0; #hidden = [1]; }",
    "export function run(callback: () => void, loose: any) {",
    "  const list = [1, 2];",
    "  const again = callback;",
    "  const whatever = loose;",
    "  return [list, again, whatever];",
    "}",
    "export type Options = { angle: number; onDone?: () => void };",
    "",
  ].join("\n");

  const ask = (file: string, source: string, text: string, name: string) =>
    probeCallsTs([{ file, line: lineOf(source, text), name }]).get(probeKey(file, lineOf(source, text), name));

  it("hears the compiler refuse a call on an array, and accept one on a function", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    const file = write("a.ts", SOURCE);
    expect(ask(file, SOURCE, "const list", "list")?.callable).toBe("lacks");
    expect(ask(file, SOURCE, "const again", "again")?.callable).toBe("has");
  });

  it("says nothing about an `any`, which the compiler accepts any call on", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    const file = write("a.ts", SOURCE);
    expect(ask(file, SOURCE, "const whatever", "whatever")?.callable).toBe("unknown");
  });

  it("reaches a class field, a #private one, and a member of an anonymous type", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    const file = write("a.ts", SOURCE);
    expect(ask(file, SOURCE, "count = 0", "count")?.callable).toBe("lacks");
    expect(ask(file, SOURCE, "#hidden", "#hidden")?.callable).toBe("lacks");
    expect(ask(file, SOURCE, "angle: number", "angle")?.callable).toBe("lacks");
    expect(ask(file, SOURCE, "angle: number", "onDone")?.callable).toBe("has");
  });

  it("still judges a file marked // @ts-nocheck, which reports nothing unless told otherwise", () => {
    write("tsconfig.json", JSON.stringify({ compilerOptions: { strict: true, target: "ES2022" } }));
    const source = `// @ts-nocheck\n${SOURCE}`;
    const file = write("a.ts", source);
    expect(ask(file, source, "const list", "list")?.callable).toBe("lacks");
  });
});

/** mypy and pyright are both needed; a machine without them skips this half. */
const hasMypy = mypyCommand() !== undefined;
const hasPython = (() => {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
})();

describe.skipIf(!hasMypy || !hasPython)("Python", () => {
  const SOURCE = [
    "from typing import TypedDict, no_type_check",
    "",
    "",
    "class Base:",
    "    def __call__(self):",
    "        return 1",
    "",
    "",
    "class Meta(TypedDict):",
    "    tags: list[str]",
    "",
    "",
    "class Plain:",
    "    size: int",
    "",
    "",
    "def run(xs: list[int]) -> None:",
    "    table = {'a': 1}",
    "    handler = Base()",
    "    names = [str(x) for x in xs]",
    "",
    "",
    "@no_type_check",
    "def unchecked() -> None:",
    "    skipped = {'a': 1}",
    "",
  ].join("\n");

  const answersFor = (sites: [string, string][]) => {
    const file = write("m.py", SOURCE);
    // `pretty = true` is what hid every refusal in Flask; the referee has to
    // read through it.
    write("pyproject.toml", "[tool.mypy]\npretty = true\n");
    const asked = sites.map(([text, name]) => ({ file, line: lineOf(SOURCE, text), name }));
    const { answers } = probeCallsPython(tree, asked);
    return asked.map((site) => answers.get(probeKey(site.file, site.line, site.name))?.callable);
  };

  it("hears a refusal on a dict and acceptance on an instance with __call__, through a pretty config", () => {
    expect(answersFor([["table =", "table"], ["handler =", "handler"]])).toEqual(["lacks", "has"]);
  });

  it("reaches a comprehension's own binding", () => {
    expect(answersFor([["names =", "x"]])).toEqual(["lacks"]);
  });

  it("reaches a class attribute declared with no value, and a TypedDict key", () => {
    expect(answersFor([["size: int", "size"], ["tags: list", "tags"]])).toEqual(["lacks", "lacks"]);
  });

  it("gives no answer inside @no_type_check, where a checker reveals types and reports nothing", () => {
    expect(answersFor([["skipped =", "skipped"]])).toEqual(["unknown"]);
  });
}, 300_000);
