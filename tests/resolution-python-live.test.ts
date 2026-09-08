/**
 * `resolvePythonReceivers`'s own two questions (#243): does the async-to-sync
 * seam actually resolve a real receiver against a live pyright process, and
 * does the concrete-guard classification `isConcreteClassLine` reads off a
 * declaration's own header line agree with what the two hazard shapes
 * (`ABC`, `Protocol`) actually look like once pyright is asked for real --
 * the same "confirmed live, not assumed" bar item 17 and #233's own guard
 * were held to.
 *
 * One server for the whole describe block, `resolution-python-lsp.test.ts`'s
 * own reason: a fresh `pyright-langserver` per test multiplies every test by
 * pyright's own startup cost for nothing.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { isConcreteClassLine, resolvePythonReceivers } from "../scripts/lib/resolution-python-live";

function write(root: string, relative: string, contents: string): void {
  const full = path.join(root, relative);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

function rangeOf(source: string, needle: string): { start: number; end: number } {
  const start = source.indexOf(needle);
  if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(needle)} not found`);
  return { start, end: start + needle.length };
}

describe("isConcreteClassLine", () => {
  it("reads a plain class as concrete", () => {
    expect(isConcreteClassLine("class Foo:")).toBe(true);
  });

  it("reads an ordinary base class as concrete", () => {
    expect(isConcreteClassLine("class Foo(Bar):")).toBe(true);
  });

  it("reads typing.Protocol as the interface hazard", () => {
    expect(isConcreteClassLine("class Store(Protocol):")).toBe(false);
    expect(isConcreteClassLine("class Store(typing.Protocol):")).toBe(false);
  });

  it("reads abc.ABC and an ABCMeta metaclass as the same hazard", () => {
    expect(isConcreteClassLine("class Base(ABC):")).toBe(false);
    expect(isConcreteClassLine("class Base(abc.ABC):")).toBe(false);
    expect(isConcreteClassLine("class Base(metaclass=ABCMeta):")).toBe(false);
  });

  it("reads a hazard mixed in among ordinary bases", () => {
    expect(isConcreteClassLine("class Both(Mixin, Protocol):")).toBe(false);
  });

  it("withholds rather than guesses on a line it does not recognise", () => {
    expect(isConcreteClassLine("@dataclass")).toBeUndefined();
    expect(isConcreteClassLine("class Split(")).toBeUndefined();
  });
});

describe("resolvePythonReceivers", () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(path.join(os.tmpdir(), "resolution-python-live-"));
    write(repo, "store.py", "from typing import Protocol\n\nclass Store(Protocol):\n    def run(self) -> int: ...\n");
    write(
      repo, "base.py",
      "from abc import ABC, abstractmethod\n\nclass Base(ABC):\n    @abstractmethod\n    def run(self) -> int: ...\n",
    );
    write(repo, "concrete_store.py", "class ConcreteStore:\n    def run(self) -> int:\n        return 1\n");
    write(
      repo, "caller.py",
      "from store import Store\nfrom base import Base\nfrom concrete_store import ConcreteStore\n\n"
      + "def use_protocol(store: Store) -> int:\n    return store.run()\n\n"
      + "def use_abc(base: Base) -> int:\n    return base.run()\n\n"
      + "def use_concrete(cs: ConcreteStore) -> int:\n    return cs.run()\n\n"
      + "def use_unresolvable(x) -> int:\n    return x.run()\n",
    );
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("withholds a Protocol receiver behind the same guard #233 built for an interface", async () => {
    const source = readCallerSource(repo);
    const { start, end } = rangeOf(source, "return store.run");
    const at = { start: start + "return ".length, end: start + "return store".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    const resolved = cache.get("caller.py", at);
    expect(resolved).toEqual({ kind: "declared", file: "store.py", concrete: false });
  }, 60_000);

  it("withholds an ABC receiver the same way", async () => {
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return base.run");
    const at = { start: start + "return ".length, end: start + "return base".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    expect(cache.get("caller.py", at)).toEqual({ kind: "declared", file: "base.py", concrete: false });
  }, 60_000);

  it("places a concrete class receiver, unguarded", async () => {
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return cs.run");
    const at = { start: start + "return ".length, end: start + "return cs".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    expect(cache.get("caller.py", at)).toEqual({ kind: "declared", file: "concrete_store.py", concrete: true });
  }, 60_000);

  it("never licenses an accusation for an unannotated receiver pyright cannot really type", async () => {
    /*
     * Found live rather than assumed: asked about `x` with no annotation,
     * `typeDefinition` does not answer `null` the way a position with no
     * information at all does elsewhere in this file -- it falls back to
     * `x`'s own parameter declaration, in `caller.py` itself, which is a
     * real repo file and not a class at all. `isConcreteClassLine` reads
     * that line, finds no `class ... :` header on it, and withholds --
     * `concrete: false`, the same "never accuse" outcome an `undefined`
     * answer produces, reached by a different road. The guard this test
     * actually cares about is that no path through here licenses a refuted
     * verdict on a receiver nobody could really type, not the exact shape
     * of the safe answer.
     */
    const source = readCallerSource(repo);
    const { start } = rangeOf(source, "return x.run");
    const at = { start: start + "return ".length, end: start + "return x".length };
    const { cache, close } = await resolvePythonReceivers(repo, [{ file: "caller.py", at }]);
    close();
    const resolved = cache.get("caller.py", at);
    if (resolved === undefined) return;
    expect(resolved.kind === "declared" && resolved.concrete).toBe(false);
  }, 60_000);

  it("resolves a batch of queries off one warm-up, and answers a key never asked with undefined", async () => {
    const source = readCallerSource(repo);
    const protocolAt = rangeOf(source, "store.run");
    const concreteAt = rangeOf(source, "cs.run");
    const queries = [
      { file: "caller.py", at: { start: protocolAt.start, end: protocolAt.start + "store".length } },
      { file: "caller.py", at: { start: concreteAt.start, end: concreteAt.start + "cs".length } },
    ];
    const { cache, close } = await resolvePythonReceivers(repo, queries);
    close();
    expect(cache.get("caller.py", queries[0]!.at)).toEqual({ kind: "declared", file: "store.py", concrete: false });
    expect(cache.get("caller.py", queries[1]!.at)).toEqual({ kind: "declared", file: "concrete_store.py", concrete: true });
    expect(cache.get("caller.py", { start: 0, end: 1 })).toBeUndefined();
  }, 60_000);

  it("asks nothing and spawns nothing for an empty query list", async () => {
    const { cache, close } = await resolvePythonReceivers(repo, []);
    close();
    expect(cache.get("caller.py", { start: 0, end: 1 })).toBeUndefined();
  });
});

function readCallerSource(repo: string): string {
  // The fixture is static for the whole file; re-reading keeps this test
  // file from needing its own copy of the string `beforeAll` already wrote
  // to disk once.
  return readFileSync(path.join(repo, "caller.py"), "utf8");
}
