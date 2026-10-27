/**
 * The call census keeps its compiler answers and a later run reuses them
 * (#481). Each run asked the compilers the same ~290,000 questions, an hour
 * per run, on both arms of every PR.
 *
 * What must hold: a reused run gives exactly the rows a fresh one does; an
 * answer is never reused once anything it rests on has changed; and a
 * question that failed is asked again rather than kept as "no answer".
 */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FORMAT, ProjectAnswers, keptAnswerOf } from "../scripts/lib/census-answers";

const REPO = path.resolve(__dirname, "..");

let scratch: string | undefined;
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});
const tmp = (): string => (scratch = mkdtempSync(path.join(os.tmpdir(), "census-reuse-")));

describe("kept answers", () => {
  const key = { commit: "abc", tree: "t1", root: "/r", libraries: "none", pins: "none", asking: "h", compiler: "typescript 5.9.3" };
  const earlier = (dir: string): string => {
    const kept = new ProjectAnswers();
    kept.keep("ts", key, "src/a.ts", "sha-a", 10, 13, { file: "src/b.ts", line: 4 });
    kept.keep("ts", key, "src/a.ts", "sha-a", 20, 23, "outside");
    kept.keep("ts", key, "src/a.ts", "sha-a", 30, 33, "none");
    const to = path.join(dir, "answers.json");
    kept.write(to);
    return to;
  };

  it("reuses an answer under the same key, file content and range", () => {
    const from = new ProjectAnswers(earlier(tmp()));
    expect(from.reuse("ts", key, "src/a.ts", "sha-a", 10, 13)).toEqual({ file: "src/b.ts", line: 4 });
    expect(from.reuse("ts", key, "src/a.ts", "sha-a", 20, 23)).toBe("outside");
    // The compiler's own "nothing here" is an answer, and is reused.
    expect(from.reuse("ts", key, "src/a.ts", "sha-a", 30, 33)).toBe("none");
  });

  it("asks again when anything the answer rests on has changed", () => {
    const from = new ProjectAnswers(earlier(tmp()));
    for (const part of Object.keys(key)) {
      expect(from.reuse("ts", { ...key, [part]: "changed" }, "src/a.ts", "sha-a", 10, 13), part).toBeUndefined();
    }
    expect(from.reuse("ts", { ...key, extra: "x" }, "src/a.ts", "sha-a", 10, 13)).toBeUndefined();
    expect(from.reuse("ts", key, "src/a.ts", "sha-edited", 10, 13)).toBeUndefined();
    expect(from.reuse("ts", key, "src/a.ts", "sha-a", 10, 14)).toBeUndefined();
    expect(from.reuse("ts", key, "src/c.ts", "sha-a", 10, 13)).toBeUndefined();
    expect(from.reuse("python", key, "src/a.ts", "sha-a", 10, 13)).toBeUndefined();
  });

  it("does not read answers kept in another format", () => {
    const dir = tmp();
    const to = earlier(dir);
    const file = JSON.parse(readFileSync(to, "utf8")) as { format: number };
    writeFileSync(to, JSON.stringify({ ...file, format: FORMAT + 1 }));
    expect(new ProjectAnswers(to).reuse("ts", key, "src/a.ts", "sha-a", 10, 13)).toBeUndefined();
  });

  it("keeps no answer for a question that failed", () => {
    const outside = (abs: string): boolean => abs.startsWith("/lib/");
    expect(keptAnswerOf({ failed: "textDocument/definition timed out" }, "/r", outside)).toBeUndefined();
    expect(keptAnswerOf({ none: true }, "/r", outside)).toBe("none");
    expect(keptAnswerOf({ at: { file: "/lib/x.py", line: 3 } }, "/r", outside)).toBe("outside");
    // 0-based from the server, 1-based in the census rows.
    expect(keptAnswerOf({ at: { file: "/r/src/b.py", line: 3 } }, "/r", outside)).toEqual({ file: "src/b.py", line: 4 });
  });
});

describe("a census run reusing an earlier one", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore" });
  const census = (corpus: string, out: string, ...more: string[]) => spawnSync(path.join(REPO, "node_modules/.bin/tsx"),
    [path.join(REPO, "scripts/measure-call-census.mts"), "--one=main/demo", `--out=${out}`, ...more],
    { encoding: "utf8", env: { ...process.env, CENSUS_MAIN_CORPUS: corpus } });
  const summary = (out: string) => JSON.parse(readFileSync(path.join(out, "main", "demo.json"), "utf8")) as { answers: { reused: number; asked: number } };

  it("writes the same rows without asking the compiler, and asks again once the tree changes", () => {
    const dir = tmp();
    const project = path.join(dir, "corpus", "demo");
    mkdirSync(path.join(project, "src"), { recursive: true });
    writeFileSync(path.join(project, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }));
    writeFileSync(path.join(project, "src", "b.ts"), "export function two(): number {\n  return 2;\n}\n");
    writeFileSync(path.join(project, "src", "a.ts"), [
      'import { two } from "./b";',
      "export function one(): number {",
      "  return two() + helper();",
      "}",
      "function helper(): number {",
      "  return Math.max(1, 2);",
      "}",
      "",
    ].join("\n"));
    git(project, "init", "-q");
    git(project, "add", ".");
    git(project, "commit", "-qm", "demo");

    const fresh = path.join(dir, "fresh");
    const first = census(path.join(dir, "corpus"), fresh);
    expect(first.status, first.stderr).toBe(0);
    const asked = summary(fresh).answers.asked;
    expect(asked).toBeGreaterThanOrEqual(3);
    expect(summary(fresh).answers.reused).toBe(0);

    const reused = path.join(dir, "reused");
    const second = census(path.join(dir, "corpus"), reused, `--reuse=${fresh}`);
    expect(second.status, second.stderr).toBe(0);
    expect(summary(reused).answers).toEqual({ reused: asked, asked: 0 });
    expect(readFileSync(path.join(reused, "main", "demo.jsonl"), "utf8")).toBe(readFileSync(path.join(fresh, "main", "demo.jsonl"), "utf8"));
    expect(readFileSync(path.join(reused, "run.log"), "utf8")).toContain(`answers: ${asked} reused, 0 asked`);

    // An edit nobody committed is still a different tree: every answer is asked again.
    writeFileSync(path.join(project, "src", "b.ts"), "export function two(): number {\n  return 3;\n}\n");
    const edited = path.join(dir, "edited");
    const third = census(path.join(dir, "corpus"), edited, `--reuse=${reused}`);
    expect(third.status, third.stderr).toBe(0);
    expect(summary(edited).answers).toEqual({ reused: 0, asked });
  }, 120_000);
});
