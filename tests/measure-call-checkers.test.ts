/**
 * `checkerFor` (#254): "go to definition" at a call's name, asked of the real
 * checker each language has, so `measure:calls` can place the receiver calls
 * its text scan cannot.
 *
 * **TypeScript live, the other two by their own clients.** `tsc` answers in
 * process, so asking it here costs nothing. pyright and rust-analyzer are
 * language servers, and `resolution-python-lsp.test.ts` and
 * `resolution-rust-lsp.test.ts` each already hold one for the whole of their
 * own file -- where `methodDeclarationLocationAt`, the exact answer this
 * adapter forwards, is pinned against a live server. Starting a third
 * rust-analyzer here instead made the full suite fail on whichever of the
 * three lost the race: 30s of request budget spent waiting, an `undefined`
 * where a declaration should be, and a red that had nothing to do with the
 * change. Two runs to see it, one alone at 1.5s to know what it was.
 *
 * What is left here is what only this file can say: that the adapter picks a
 * checker per language at all, that it turns an answer into `{ file, line }`,
 * that it tells a repository's own routine from a language builtin, and that a
 * language with no checker comes back with a reason rather than silence.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { callSitesOn, checkerFor, type CallChecker } from "../scripts/lib/call-receivers";
import type { Language } from "../src/engine/parse";

function fixture(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "measure-call-checkers-")));
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

/** Ask at the receiver call of `name` on the line carrying `marker`. */
async function ask(
  checker: CallChecker, root: string, relative: string, source: string,
  marker: string, name: string, language: Language,
) {
  const line = source.slice(0, source.indexOf(marker)).split("\n").length;
  const [site] = callSitesOn(source, line, name, "receiver", language);
  if (!site) throw new Error(`fixture bug: no receiver call of ${name} on the ${marker} line`);
  const answer = await checker.definitionAt(path.join(root, relative), source, site);
  return answer && {
    file: path.relative(root, answer.file),
    line: answer.line,
    outside: !answer.file.startsWith(root),
  };
}

describe("checkerFor, TypeScript", () => {
  const use = "import * as util from './util';\nexport function run(): string {\n"
    + "  util.foo(); // UTIL\n  return ' x '.trim(); // TRIM\n}\n";
  let root: string;
  let checker: CallChecker;

  beforeAll(async () => {
    root = fixture({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", target: "es2022" } }),
      // Two routines in one file, so the line -- not just the file -- decides
      // which one the answer names. That is the whole reason `measure:calls`
      // needs a location rather than a path.
      "util.ts": "export function foo(): void {}\nexport function trim(): void {}\n",
      "use.ts": use,
    });
    const made = await checkerFor(root, "ts");
    if ("unavailable" in made) throw new Error(made.unavailable);
    checker = made;
  }, 120_000);

  afterAll(() => { checker?.close(); rmSync(root, { recursive: true, force: true }); });

  it("names the checker and its version, for the record beside the number", () => {
    expect(checker.label).toMatch(/^tsc \d+\.\d+/);
  });

  it("lands a namespace call on the repository's own routine, at its own line", async () => {
    expect(await ask(checker, root, "use.ts", use, "UTIL", "foo", "ts"))
      .toEqual({ file: "util.ts", line: 0, outside: false });
  });

  it("places a same-named library method outside the repository", async () => {
    // `trim` is declared in this repository too, one line below `foo`. The
    // call is `String.prototype.trim`, and only a real checker can say so --
    // this is the shape that made `@calls` confirm six calls it should not.
    const answer = await ask(checker, root, "use.ts", use, "TRIM", "trim", "ts");
    expect(answer?.outside).toBe(true);
  });
});

describe("checkerFor, a language with nothing to ask", () => {
  it("gives a reason rather than going quiet", async () => {
    const root = fixture({ "a.txt": "" });
    try {
      const made = await checkerFor(root, "unknown" as Language);
      expect(made).toEqual({ unavailable: "no checker for unknown" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
