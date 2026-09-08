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
  createPyrightLspReferee, isOutsideTree, memberRangeAfter, typeAnchorFor, type PyrightLspReferee,
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
    write(
      repo,
      "pkg/decl.py",
      "class Config:\n    def load(self) -> \"Config\":\n        return self\n\n"
      + "class Builder:\n"
      + "    def step(self) -> \"Builder\":\n"
      + "        return self\n"
      + "    def finish(self) -> Config:\n"
      + "        return Config()\n",
    );
    useSource =
      "from pkg.decl import Builder, Config\n\n"
      + "def make() -> Config:\n"
      + "    c = Config()\n"
      + "    r = c.load()\n"
      + "    s = \"hello\".upper()\n"
      + "    return r\n\n"
      + "def take_str(w: str) -> None:\n"
      + "    w.upper()\n\n"
      // `self.cache` here is what item 17's real bug looked like: the
      // receiver is a field, not a plain name, and its declared type
      // (Config, in pkg/decl.py) is not the class this method lives on
      // (Holder, right here in pkg/use.py).
      + "class Holder:\n"
      + "    def __init__(self) -> None:\n"
      + "        self.cache: Config = Config()\n"
      + "    def use_field(self) -> None:\n"
      + "        self.cache.load()\n\n"
      // The exact shape #235's own measurement found wrong on infrarouter:
      // a multi-call chain where the receiver for the *last* call spans
      // everything before it, and the first token of that range (`self`)
      // is not what the chain evaluates to.
      + "class Runner:\n"
      + "    def _make(self) -> Builder:\n"
      + "        return Builder()\n"
      + "    def run(self) -> Config:\n"
      + "        return self._make().step().finish()\n";
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

  /**
   * #235's own bug, found by a real disagreement rather than by reading the
   * grammar first: `typeDeclarationAt` used to ask about `[start, end)`'s
   * *first* character, which is the right token for a plain name but the
   * *wrong* one for a field (`self.cache` -- `self`, not `cache`) or a chain
   * (`self._make().step()` -- `self`, not what `.step()` actually returns).
   * `typeAnchorFor` fixed it by anchoring on the range's *last* identifier
   * instead. These two tests are the shapes that found the bug.
   */
  it("typeDeclarationAt on a field receiver follows the field's own type, not the enclosing class", async () => {
    const { start, end } = rangeOf(useSource, "self.cache");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, end);
    // Before the fix this returned `useFile` -- `self`'s own type, Holder,
    // declared right here -- instead of Config's file.
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("pkg", "decl.py"));
  });

  it("typeDeclarationAt on a chained call's receiver follows the chain's actual type, not the enclosing method's `self`", async () => {
    const { start, end } = rangeOf(useSource, "self._make().step()");
    const declaring = await referee.typeDeclarationAt(useFile, useSource, start, end);
    // Before the fix this returned `useFile` -- `self`'s own type, Runner --
    // instead of following `.step()` to where it (and Builder) are declared.
    expect(declaring && path.relative(repo, declaring)).toBe(path.join("pkg", "decl.py"));
  });
});

describe("typeAnchorFor", () => {
  it("anchors a plain name on itself", () => {
    const source = "x.foo()";
    const range = typeAnchorFor(source, 0, 1);
    expect(range && source.slice(range.start, range.end)).toBe("x");
  });

  it("anchors a field access on the field, not the object it's read off of", () => {
    const source = "self.cache";
    const range = typeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("cache");
  });

  it("anchors a call chain on its last callee name, past the matching parens", () => {
    const source = "self._make().step()";
    const range = typeAnchorFor(source, 0, source.length);
    expect(range && source.slice(range.start, range.end)).toBe("step");
  });

  it("withholds rather than guessing when the range ends in a subscript", () => {
    const source = "table[key]";
    expect(typeAnchorFor(source, 0, source.length)).toBeUndefined();
  });

  it("withholds rather than guessing on unbalanced brackets", () => {
    // Ends in `)` with no matching `(` inside the range -- an extra close
    // paren, the shape the depth count is there to catch.
    const source = "foo(bar))";
    expect(typeAnchorFor(source, 0, source.length)).toBeUndefined();
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
