/**
 * Compiler answers remembered across runs (`scripts/lib/compiler-memory.ts`).
 *
 * The bad outcomes these guard: a remembered answer that is not the one the
 * compiler would give now -- a "nothing here" that was really a timed-out
 * question, an answer about a file or tree that has changed since, two runs
 * that disagreed and one of them silently won; a question asked of a server
 * before it finished warming up because the warm-up was skipped; a server
 * started for a tree whose every question was answered before. No language
 * server is started: the clients here are fakes that count what they are asked.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CompilerMemory, memoryLine, memoryMode, remembered, type MemoryMode } from "../scripts/lib/compiler-memory";
import { refereePool } from "../src/engine/referee-pool";

let scratch: string;
let tree: string;
let store: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "compiler-memory-"));
  tree = path.join(scratch, "tree");
  store = path.join(scratch, "memory");
  execFileSync("git", ["init", "-q", tree]);
  writeFileSync(path.join(tree, "a.py"), "def f():\n    return g()\n");
  execFileSync("git", ["-C", tree, "add", "."]);
  execFileSync("git", ["-C", tree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"]);
});
afterEach(() => { rmSync(scratch, { recursive: true, force: true }); });

/** A fake pyright or rust-analyzer: answers from a table, counts what it is asked, fails on request. */
function fakeClient(answers: Record<string, unknown>, options: { failures?: number; warm?: boolean; primed?: boolean } = {}) {
  const log: string[] = [];
  let warmed = false;
  const answer = (method: string, start: number) => {
    log.push(`${method}@${start}${warmed ? "" : " (cold)"}`);
    return answers[`${method}@${start}`];
  };
  const client = {
    log,
    starts: 0,
    closed: false,
    warmUp: async (candidates?: unknown) => {
      log.push(`warmUp ${JSON.stringify(candidates ?? null)}`);
      await new Promise((resolve) => { setTimeout(resolve, 5); });
      warmed = options.warm ?? true;
    },
    warmedUp: () => warmed,
    primedCleanly: () => options.primed ?? true,
    failures: () => options.failures ?? 0,
    withheldNoType: () => 0,
    version: () => "fake 1",
    methodDeclarationLocationAt: async (_file: string, _source: string, start: number, _end?: number) => answer("definition", start),
    methodDeclarationOutcomeAt: async (_file: string, _source: string, start: number, _end?: number) =>
      answer("outcome", start) ?? { none: true },
    valueKindAt: async (_file: string, _source: string, start: number) => answer("kind", start),
    typePartsAt: async (_file: string, _source: string, start: number, _end?: number) => answer("parts", start),
    somethingNew: async () => "passed through",
    close: () => { client.closed = true; },
  };
  return client;
}

type Fake = ReturnType<typeof fakeClient>;

/** One run: a memory, a pool through it, and the fake it starts when it must. */
function run(mode: MemoryMode, fake: Fake, language: "python" | "rust" = "python") {
  const memory = new CompilerMemory(mode, { libraries: "test" }, store);
  const pool = refereePool<Fake>(undefined, memory.wrap);
  const get = () => pool.get(`${language}:${tree}`, async () => { fake.starts += 1; return fake; });
  return { memory, pool, get };
}

const file = () => path.join(tree, "a.py");
const SOURCE = "def f():\n    return g()\n";

describe("compiler memory", () => {
  it("answers a second run from the first, and starts no server for it", async () => {
    const first = fakeClient({ "definition@20": { file: "/x/b.py", line: 3 }, "kind@4": "function" });
    const one = run("on", first);
    const referee = (await one.get())!;
    await referee.warmUp([{ file: file(), source: SOURCE, start: 20 }]);
    expect(await referee.methodDeclarationLocationAt(file(), SOURCE, 20, 21)).toEqual({ file: "/x/b.py", line: 3 });
    expect(await referee.valueKindAt(file(), SOURCE, 4)).toBe("function");
    expect(await referee.valueKindAt(file(), SOURCE, 9)).toBeUndefined();
    one.pool.close();
    const counts = one.memory.flush();
    expect(first.starts).toBe(1);
    expect(counts).toMatchObject({ calls: 3, remembered: 0, asked: 3, kept: 3, started: 1, spared: 0 });

    const second = fakeClient({});
    const two = run("on", second);
    const again = (await two.get())!;
    await again.warmUp([{ file: file(), source: SOURCE, start: 20 }]);
    expect(await again.methodDeclarationLocationAt(file(), SOURCE, 20, 21)).toEqual({ file: "/x/b.py", line: 3 });
    expect(await again.valueKindAt(file(), SOURCE, 4)).toBe("function");
    expect(await again.valueKindAt(file(), SOURCE, 9)).toBeUndefined();
    two.pool.close();
    expect(two.memory.flush()).toMatchObject({ calls: 3, remembered: 3, asked: 0, kept: 0, started: 0, spared: 1 });
    expect(second.starts).toBe(0);
    expect(second.log).toEqual([]);
  });

  it("starts the server for a question it has no answer to, warmed first, once however many ask at once", async () => {
    const first = fakeClient({ "kind@4": "function" });
    const one = run("on", first);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    await referee.valueKindAt(file(), SOURCE, 4);
    one.pool.close();
    one.memory.flush();

    const second = fakeClient({ "kind@4": "function", "kind@9": "value", "kind@11": "class" });
    const two = run("on", second);
    const again = (await two.get())!;
    expect(second.starts).toBe(0);
    await again.warmUp(["candidates of this batch"]);
    const answers = await Promise.all([
      again.valueKindAt(file(), SOURCE, 4), again.valueKindAt(file(), SOURCE, 9), again.valueKindAt(file(), SOURCE, 11),
    ]);
    expect(answers).toEqual(["function", "value", "class"]);
    expect(second.starts).toBe(1);
    // Warmed with what the asker warmed this referee with, and nothing asked cold.
    expect(second.log[0]).toBe('warmUp ["candidates of this batch"]');
    expect(second.log.filter((one) => one.includes("(cold)"))).toEqual([]);
    expect(second.log.filter((one) => one.startsWith("warmUp"))).toHaveLength(1);
  });

  it("keeps a 'nothing here' only from a server that failed nothing and was warm", async () => {
    const failing = fakeClient({ "kind@4": "function" }, { failures: 1 });
    const one = run("on", failing);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    await referee.valueKindAt(file(), SOURCE, 4);
    await referee.valueKindAt(file(), SOURCE, 9); // undefined: perhaps the question that failed
    one.pool.close();
    expect(one.memory.flush()).toMatchObject({ kept: 1, notKept: 1 });

    const cold = fakeClient({ "kind@11": "class" }, { warm: false });
    const two = run("on", cold);
    const again = (await two.get())!;
    await again.warmUp([]);
    await again.valueKindAt(file(), SOURCE, 11);
    await again.valueKindAt(file(), SOURCE, 13);
    two.pool.close();
    expect(two.memory.flush()).toMatchObject({ kept: 1, notKept: 1 });

    // Both "nothing here" answers are asked again; the real answers are not.
    const third = fakeClient({ "kind@9": "value", "kind@13": "value" });
    const three = run("on", third);
    const last = (await three.get())!;
    await last.warmUp([]);
    expect(await last.valueKindAt(file(), SOURCE, 4)).toBe("function");
    expect(await last.valueKindAt(file(), SOURCE, 11)).toBe("class");
    expect(await last.valueKindAt(file(), SOURCE, 9)).toBe("value");
    expect(await last.valueKindAt(file(), SOURCE, 13)).toBe("value");
    expect(third.log.filter((one) => one.startsWith("kind"))).toEqual(["kind@9", "kind@13"]);
  });

  it("never keeps a failed outcome, and keeps nothing from a rust-analyzer that never said it was ready", async () => {
    const python = fakeClient({ "outcome@4": { failed: "timed out" }, "outcome@9": { at: { file: "/x", line: 1 } } });
    const one = run("on", python);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    expect(await referee.methodDeclarationOutcomeAt(file(), SOURCE, 4, 5)).toEqual({ failed: "timed out" });
    await referee.methodDeclarationOutcomeAt(file(), SOURCE, 9, 10);
    await referee.methodDeclarationOutcomeAt(file(), SOURCE, 11, 12); // { none: true }
    one.pool.close();
    expect(one.memory.flush()).toMatchObject({ kept: 2, notKept: 0 });

    const rust = fakeClient({ "definition@4": { file: "/x/lib.rs", line: 2 } }, { primed: false });
    const two = run("on", rust, "rust");
    const crate = (await two.get())!;
    await crate.warmUp();
    await crate.methodDeclarationLocationAt(file(), SOURCE, 4, 5);
    two.pool.close();
    expect(two.memory.flush()).toMatchObject({ kept: 0, notKept: 1 });
  });

  it("keeps nothing from a client that cannot count its failures", async () => {
    const old = fakeClient({ "kind@4": "function" }) as Partial<Fake>;
    delete old.failures;
    const one = run("on", old as Fake);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    await referee.valueKindAt(file(), SOURCE, 4);
    one.pool.close();
    expect(one.memory.flush()).toMatchObject({ kept: 0, notKept: 1 });
  });

  it("asks again when the file's text, or anything in the tree, has changed", async () => {
    const first = fakeClient({ "kind@4": "function" });
    const one = run("on", first);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    await referee.valueKindAt(file(), SOURCE, 4);
    one.pool.close();
    one.memory.flush();

    const second = fakeClient({ "kind@4": "class" });
    const two = run("on", second);
    const again = (await two.get())!;
    await again.warmUp([]);
    expect(await again.valueKindAt(file(), `${SOURCE}\n`, 4)).toBe("class"); // same position, other text
    two.pool.close();
    two.memory.flush();

    writeFileSync(path.join(tree, "untracked.py"), "x = 1\n");
    const third = fakeClient({ "kind@4": "value" });
    const three = run("on", third);
    const last = (await three.get())!;
    await last.warmUp([]);
    expect(await last.valueKindAt(file(), SOURCE, 4)).toBe("value"); // a new file in the tree: a new tree
    expect(third.starts).toBe(1);
    three.pool.close();
    three.memory.flush();

    writeFileSync(path.join(tree, "untracked.py"), "x = 2\n");
    const fourth = fakeClient({ "kind@4": "type" });
    const four = run("on", fourth);
    const other = (await four.get())!;
    await other.warmUp([]);
    expect(await other.valueKindAt(file(), SOURCE, 4)).toBe("type"); // the same name, other content
  });

  it("voids a question two kept files answer differently", async () => {
    const write = async (said: string) => {
      const memory = new CompilerMemory("on", { libraries: "test" }, path.join(scratch, `side-${said}`));
      const pool = refereePool<Fake>(undefined, memory.wrap);
      const fake = fakeClient({ "kind@4": said });
      const referee = (await pool.get(`python:${tree}`, async () => fake))!;
      await referee.warmUp([]);
      await referee.valueKindAt(file(), SOURCE, 4);
      pool.close();
      memory.flush();
    };
    await write("function");
    await write("class");
    // Both runs' files in one store, as two arms measured side by side leave them.
    for (const said of ["function", "class"]) {
      const side = path.join(scratch, `side-${said}`, "python");
      const group = readdirSync(side)[0]!;
      execFileSync("mkdir", ["-p", path.join(store, "python", group)]);
      for (const name of readdirSync(path.join(side, group))) {
        execFileSync("cp", [path.join(side, group, name), path.join(store, "python", group, name)]);
      }
    }
    const fake = fakeClient({ "kind@4": "value" });
    const one = run("on", fake);
    const referee = (await one.get())!;
    await referee.warmUp([]);
    expect(await referee.valueKindAt(file(), SOURCE, 4)).toBe("value");
    one.pool.close();
    expect(one.memory.flush()).toMatchObject({ conflicts: 1, remembered: 0, asked: 1 });
  });

  it("off asks everything and keeps nothing; verify asks everything and counts a contradiction", async () => {
    const first = fakeClient({ "kind@4": "function" });
    const one = run("off", first);
    const referee = (await one.get())!;
    await referee.valueKindAt(file(), SOURCE, 4);
    one.pool.close();
    expect(one.memory.flush()).toMatchObject({ calls: 0, kept: 0 });
    expect(() => readdirSync(store)).toThrow();

    const second = fakeClient({ "kind@4": "function" });
    const two = run("on", second);
    const kept = (await two.get())!;
    await kept.warmUp([]);
    await kept.valueKindAt(file(), SOURCE, 4);
    two.pool.close();
    two.memory.flush();

    const third = fakeClient({ "kind@4": "class" });
    const three = run("verify", third);
    const checked = (await three.get())!;
    await checked.warmUp([]);
    expect(await checked.valueKindAt(file(), SOURCE, 4)).toBe("class"); // the live answer, never the kept one
    three.pool.close();
    expect(three.memory.flush()).toMatchObject({ remembered: 0, asked: 1, mismatches: 1 });
  });

  it("passes a method it does not know to a real server; a Rust referee has only Rust's questions", async () => {
    const fake = fakeClient({});
    const one = run("on", fake, "rust");
    const referee = (await one.get())! as unknown as Record<string, unknown>;
    expect(await (referee.somethingNew as () => Promise<string>)()).toBe("passed through");
    expect("valueKindAt" in referee).toBe(false);
    expect((referee.version as () => string)()).toBe("fake 1");
  });

  it("starts the server as ever for a tree in no git checkout", async () => {
    const loose = mkdtempSync(path.join(os.tmpdir(), "compiler-memory-loose-"));
    try {
      const memory = new CompilerMemory("on", {}, store);
      const pool = refereePool<Fake>(undefined, memory.wrap);
      const fake = fakeClient({ "kind@4": "function" });
      const referee = (await pool.get(`python:${loose}`, async () => fake))!;
      expect(referee).toBe(fake);
    } finally {
      rmSync(loose, { recursive: true, force: true });
    }
  });

  it("remembers a referee's whole answer by its key, keeps only what may be kept, and checks it under verify", async () => {
    let worked = 0;
    const pairs = (list: string[]) => () => { worked += 1; return list; };
    const key = { tree: "t1", referee: "r1" };
    expect(await remembered("on", "pairs-x", key, pairs(["a", "b"]), (v) => v.length > 0, store)).toEqual({ value: ["a", "b"], remembered: false });
    expect(await remembered("on", "pairs-x", key, pairs(["c"]), () => true, store)).toEqual({ value: ["a", "b"], remembered: true });
    expect(worked).toBe(1);
    // Another tree is another key; a value that may not be kept is worked out every time.
    expect((await remembered("on", "pairs-x", { ...key, tree: "t2" }, pairs([]), (v) => v.length > 0, store)).remembered).toBe(false);
    expect((await remembered("on", "pairs-x", { ...key, tree: "t2" }, pairs(["d"]), (v) => v.length > 0, store)).remembered).toBe(false);
    // No key (no checkout to key on), or off: never read, never kept.
    expect((await remembered("on", "pairs-x", undefined, pairs(["e"]), () => true, store)).remembered).toBe(false);
    expect(await remembered("off", "pairs-x", key, pairs(["f"]), () => true, store)).toEqual({ value: ["f"], remembered: false });
    // Verify works it out again and says whether the kept one still holds.
    expect(await remembered("verify", "pairs-x", key, pairs(["a", "b"]), () => true, store)).toEqual({ value: ["a", "b"], remembered: false, contradicted: false });
    expect(await remembered("verify", "pairs-x", key, pairs(["a"]), () => true, store)).toEqual({ value: ["a"], remembered: false, contradicted: true });
  });

  it("reads its mode from the flags and the environment, and says what it did in one line", () => {
    expect(memoryMode([], {})).toBe("on");
    expect(memoryMode(["--no-memory"], {})).toBe("off");
    expect(memoryMode(["--memory=verify"], {})).toBe("verify");
    expect(memoryMode([], { BOARD_AI_COMPILER_MEMORY: "off" })).toBe("off");
    expect(() => memoryMode(["--memory=maybe"], {})).toThrow();
    expect(memoryLine("off", { calls: 0, remembered: 0, asked: 0, kept: 0, notKept: 0, started: 0, spared: 0, conflicts: 0, mismatches: 0 }))
      .toMatch(/^compiler memory: off/);
    expect(memoryLine("on", { calls: 200, remembered: 150, asked: 50, kept: 50, notKept: 0, started: 1, spared: 3, conflicts: 0, mismatches: 0 }, "/m"))
      .toBe("compiler memory: 150 of 200 answers remembered (75%), 50 asked; 1 server started, 3 not needed; 50 new answers kept (/m)");
  });
});
