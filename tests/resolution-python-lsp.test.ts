/**
 * `createPyrightLspReferee`'s own two questions (#235): where a receiver's
 * *type* is declared (`textDocument/typeDefinition`), and where the *method
 * actually called* is declared (`textDocument/definition`) -- distinct LSP
 * methods, confirmed different against a live server before any client code
 * was written. Asked at the *receiver's* own position, `definition` answers
 * a different question (where that variable was last assigned) than
 * `typeDefinition` does; these tests exist so a future edit cannot quietly
 * merge the two back into one without a real server disagreeing first.
 *
 * One server for the whole describe block, matching the module's own "one
 * per tree, many queries" design -- a fresh `pyright-langserver` per test
 * would multiply every test by pyright's own startup cost for no reason.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createPyrightLspReferee, isOutsideTree, memberRangeAfter, type PyrightLspReferee,
} from "../scripts/lib/resolution-python-lsp";

function write(root: string, relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

/** Byte range of `needle`'s first occurrence in `source`, for an LSP query. */
function rangeOf(source: string, needle: string): { start: number; end: number } {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
  return { start, end: start + needle.length };
}

describe("createPyrightLspReferee", () => {
  let repo: string;
  let referee: PyrightLspReferee;
  let useFile: string;
  let useSource: string;

  beforeAll(async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-python-lsp-"));
    write(repo, "pkg/decl.py", "class Config:\n    def load(self) -> \"Config\":\n        return self\n");
    useSource =
      "from pkg.decl import Config\n\n"
      + "def make() -> Config:\n"
      + "    c = Config()\n"
      + "    r = c.load()\n"
      + "    s = \"hello\".upper()\n"
      + "    return r\n\n"
      + "def take_str(w: str) -> None:\n"
      + "    w.upper()\n";
    write(repo, "pkg/use.py", useSource);
    useFile = path.join(repo, "pkg/use.py");

    referee = await createPyrightLspReferee(repo);
    const warm = rangeOf(useSource, "c.load");
    await referee.warmUp(useFile, useSource, warm.start);
  }, 30_000);

  afterAll(() => {
    referee?.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it("typeDeclarationAt follows a receiver to its type's own declaration, across files", async () => {
    const { start, end } = rangeOf(useSource, "c.load");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("pkg", "decl.py"));
    void end;
  });

  it("methodDeclarationAt, asked at the method's own position, reaches the method -- not the receiver's assignment", async () => {
    const receiverEnd = rangeOf(useSource, "c.load").start + 1; // just past `c`, before the `.`
    const member = memberRangeAfter(useSource, receiverEnd, "load");
    expect(member).toBeDefined();
    const declaring = await referee.methodDeclarationAt(useFile, useSource, member!.start, member!.end);
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("pkg", "decl.py"));
  });

  it("methodDeclarationAt, asked at the receiver's own position instead, answers a different question entirely", async () => {
    // The regression this file exists to catch: definition-on-the-receiver
    // does not reach the type. It reaches `c`'s own assignment, in the same
    // file -- proof the two LSP methods are not interchangeable.
    const { start } = rangeOf(useSource, "c.load");
    const declaring = await referee.methodDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring).toBe(useFile);
  });

  it("classifies a stdlib method's declaration as outside the tree", async () => {
    // A bound name, not a literal -- pyright answers no `typeDefinition` for
    // a position inside a string literal's own characters (confirmed live:
    // it returns `null` for `hover` there too, the same as for a comment),
    // so this asks about `w`, annotated `str`, in `w.upper()` instead.
    const start = rangeOf(useSource, "w.upper").start;
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring).toBeDefined();
    expect(isOutsideTree(declaring!, repo)).toBe(true);
  });

  it("returns undefined for a position with no real answer", async () => {
    const { start } = rangeOf(useSource, "return r");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, start + 1);
    expect(declaring).toBeUndefined();
  });
});

describe("memberRangeAfter", () => {
  it("finds the method name in a plain x.foo() receiver", () => {
    const source = "r = c.load()\n";
    const receiverEnd = source.indexOf("c") + 1;
    const range = memberRangeAfter(source, receiverEnd, "load");
    expect(range && source.slice(range.start, range.end)).toBe("load");
  });

  it("finds the method name after a field receiver, self.cache.foo()", () => {
    const source = "        self.cache.evict()\n";
    const receiverEnd = source.indexOf("self.cache") + "self.cache".length;
    const range = memberRangeAfter(source, receiverEnd, "evict");
    expect(range && source.slice(range.start, range.end)).toBe("evict");
  });

  it("tolerates whitespace around the dot", () => {
    const source = "c . load()\n";
    const receiverEnd = source.indexOf("c") + 1;
    const range = memberRangeAfter(source, receiverEnd, "load");
    expect(range && source.slice(range.start, range.end)).toBe("load");
  });

  it("withholds a range rather than guessing when the shape does not match", () => {
    const source = "c.load()\n";
    const receiverEnd = source.indexOf("c") + 1;
    // Wrong method name -- the text after the receiver does not say `save`.
    const range = memberRangeAfter(source, receiverEnd, "save");
    expect(range).toBeUndefined();
  });
});
