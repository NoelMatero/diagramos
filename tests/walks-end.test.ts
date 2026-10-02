/**
 * Every walk that follows links back has to end (#407).
 *
 * `a` calls `b` and `b` calls `a`, and the board says `a calls a`. The walk
 * that rules out a red reached `a` again, gave the start a link back to `b`,
 * and rebuilding the route went `a <- b <- a <- b ...` for ever: a one-arrow
 * board never came back, in TypeScript, Python and Rust alike.
 *
 * Each check runs in a child process under a timeout. The loop never yields,
 * so a vitest timeout in this process would never fire -- the suite would hang
 * rather than fail.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { initEngine } from "../src/engine/parse";
import { createPyrightLspReferee } from "../src/engine/referee-python-lsp";

const CHILD = path.join(__dirname, "helpers", "check-in-a-child.ts");
/** Seconds a check that ends gets. A cold child takes ~2s; one that hangs takes for ever. */
const LIMIT_MS = 30_000;

function inAChild<T>(question: object): T {
  const run = spawnSync(process.execPath, ["--import", "tsx", CHILD], {
    input: JSON.stringify(question),
    encoding: "utf8",
    timeout: LIMIT_MS,
    killSignal: "SIGKILL",
  });
  if (run.signal) throw new Error(`the check did not end within ${LIMIT_MS / 1000}s (${run.signal})`);
  if (run.status !== 0) throw new Error(`the check failed: ${run.stderr}`);
  return JSON.parse(run.stdout) as T;
}

interface BoardAnswer { edges: Array<[kind: string, detail: string]>; calls: number; confirmed: number }

const board = (files: Record<string, string>, ref: string) => inAChild<BoardAnswer>({ files, board: ref });

const CARGO = '[package]\nname = "rec"\nversion = "0.1.0"\nedition = "2021"\n';

/** `a` reaching itself through `b`, the issue's repro, per language. */
const THROUGH_ONE = {
  typescript: [{
    "src/rec.ts": "export function a(n: number): number { return n > 0 ? b(n - 1) : 0; }\n"
      + "export function b(n: number): number { return a(n); }\n",
  }, "src/rec.ts#a"],
  python: [{
    "app/rec.py": "def a(n):\n    return b(n - 1) if n > 0 else 0\n\n\ndef b(n):\n    return a(n)\n",
  }, "app/rec.py#a"],
  rust: [{
    "Cargo.toml": CARGO,
    "src/lib.rs": "pub fn a(n: u32) -> u32 { if n > 0 { b(n - 1) } else { 0 } }\n"
      + "pub fn b(n: u32) -> u32 { a(n) }\n",
  }, "src/lib.rs#a"],
} as const;

/** `a -> b -> c -> a`. */
const THROUGH_TWO = {
  typescript: [{
    "src/rec.ts": "export function a(n: number): number { return n > 0 ? b(n - 1) : 0; }\n"
      + "export function b(n: number): number { return c(n); }\n"
      + "export function c(n: number): number { return a(n); }\n",
  }, "src/rec.ts#a"],
  python: [{
    "app/rec.py": "def a(n):\n    return b(n - 1) if n > 0 else 0\n\n\n"
      + "def b(n):\n    return c(n)\n\n\ndef c(n):\n    return a(n)\n",
  }, "app/rec.py#a"],
  rust: [{
    "Cargo.toml": CARGO,
    "src/lib.rs": "pub fn a(n: u32) -> u32 { if n > 0 { b(n - 1) } else { 0 } }\n"
      + "pub fn b(n: u32) -> u32 { c(n) }\n"
      + "pub fn c(n: u32) -> u32 { a(n) }\n",
  }, "src/lib.rs#a"],
} as const;

/** `a` calling itself, with nothing in between. */
const DIRECT = {
  typescript: [{ "src/rec.ts": "export function a(n: number): number { return n > 0 ? a(n - 1) : 0; }\n" }, "src/rec.ts#a"],
  python: [{ "app/rec.py": "def a(n):\n    return a(n - 1) if n > 0 else 0\n" }, "app/rec.py#a"],
  rust: [{ "Cargo.toml": CARGO, "src/lib.rs": "pub fn a(n: u32) -> u32 { if n > 0 { a(n - 1) } else { 0 } }\n" }, "src/lib.rs#a"],
} as const;

const LANGUAGES = ["typescript", "python", "rust"] as const;

describe("an arrow from a routine to itself, reached through another one", () => {
  for (const language of LANGUAGES) {
    it(`ends, and says it gets there one level up (${language})`, () => {
      const [files, ref] = THROUGH_ONE[language];
      const answer = board(files, ref);
      // The note, not a red and not silence.
      expect(answer.edges.map(([kind]) => kind)).toEqual(["calls-one-level-up"]);
      expect(answer.edges[0]![1]).toContain("in 2 steps, through a -> b -> a.");
      expect(answer.confirmed).toBe(0);
    }, LIMIT_MS + 10_000);
  }
});

describe("an arrow from a routine to itself, reached through two others", () => {
  for (const language of LANGUAGES) {
    it(`ends, and names the whole circle (${language})`, () => {
      const [files, ref] = THROUGH_TWO[language];
      const answer = board(files, ref);
      expect(answer.edges.map(([kind]) => kind)).toEqual(["calls-one-level-up"]);
      expect(answer.edges[0]![1]).toContain("in 3 steps, through a -> b -> c -> a.");
    }, LIMIT_MS + 10_000);
  }
});

describe("an arrow from a routine to itself, which it calls directly", () => {
  for (const language of LANGUAGES) {
    it(`is confirmed (${language})`, () => {
      const [files, ref] = DIRECT[language];
      const answer = board(files, ref);
      expect(answer.edges).toEqual([]);
      expect(answer.calls).toBe(1);
      expect(answer.confirmed).toBe(1);
    }, LIMIT_MS + 10_000);
  }

  it("ends when the cross-file walk is asked it too, and names the one step", () => {
    /*
     * The board confirms this one before the walk is ever asked, so only a
     * direct ask reaches it -- and the start gets a link to itself, which went
     * round on the spot. `measure:reach` asks the walk directly.
     */
    const [files] = DIRECT.typescript;
    const verdict = inAChild<{ verdict: string; via?: string[]; hops?: unknown[] }>({ files, reach: ["src/rec.ts", "a"] });
    expect(verdict.verdict).toBe("reached");
    expect(verdict.via).toEqual(["a", "a"]);
    expect(verdict.hops).toHaveLength(1);
  }, LIMIT_MS + 10_000);
});

describe("a Python class whose bases lead back to it", () => {
  /*
   * The other walk that could not end, found while sweeping for this one.
   * Asking whether a value can be called reads its class's bases through
   * pyright, and kept each class's answer as a promise before it was settled.
   * Two files whose classes derive from each other handed `CB` the unsettled
   * answer for `CA`, which was waiting on `CB`: the question never came back,
   * and the live check awaits every one. Not a loop, so no CPU -- just a check
   * that never finishes.
   *
   * Python refuses this at import time, but the text is what gets read, and
   * pyright places both bases. Within one file it does not (a base named
   * before its class is unbound), so two files are the shape.
   */
  it("answers that it cannot tell, rather than never answering", async () => {
    await initEngine();
    const repo = mkdtempSync(path.join(tmpdir(), "walks-end-"));
    writeFileSync(path.join(repo, "ca.py"), "from cb import CB\n\n\nclass CA(CB):\n    pass\n");
    writeFileSync(path.join(repo, "cb.py"), "from ca import CA\n\n\nclass CB(CA):\n    pass\n");
    const source = "from ca import CA\n\n\nclass Plain:\n    pass\n\n\nplain = Plain()\nloop = CA()\n";
    writeFileSync(path.join(repo, "values.py"), source);
    const pyright = await createPyrightLspReferee(repo);
    try {
      const ask = async (name: string) => {
        const at = source.search(new RegExp(`^${name} =`, "m"));
        return Promise.race([
          pyright.valueKindAt(path.join(repo, "values.py"), source, at),
          new Promise<"never">((resolve) => { setTimeout(() => resolve("never"), 30_000).unref(); }),
        ]);
      };
      // Asked first so pyright has read the tree; it also shows the referee is answering.
      expect(await ask("plain")).toEqual({ callable: false, type: false });
      const loop = await ask("loop");
      expect(loop).not.toBe("never");
      // Neither base is placed in a way that ends, so callable is left open: never `false`.
      expect((loop as { callable?: boolean }).callable).toBeUndefined();
    } finally {
      pyright.close();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);
});
