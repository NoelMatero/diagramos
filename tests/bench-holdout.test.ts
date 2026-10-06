/**
 * The guards on the holdout set (bench-holdout/README.md).
 *
 * The set is worth something only while nobody has tuned on it, so the first
 * guard is that none of its projects is also a main-set project or a corpus a
 * licence was measured on. The rest keep its three lists in step: every board
 * belongs to a listed project, every project has boards, and every project's
 * libraries can be installed.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { HoldoutProject } from "../scripts/lib/bench-set";

const REPO = path.resolve(__dirname, "..");
/** Every holdout set: `bench-holdout`, `bench-holdout-b`, ... */
const SETS = readdirSync(REPO).filter((name) => /^bench-holdout(-[a-z])?$/.test(name)).sort();
const listOf = (set: string) =>
  JSON.parse(readFileSync(path.join(REPO, set, "projects.json"), "utf8")) as HoldoutProject[];

describe("no project is in two sets", () => {
  it("names no project, or repository, twice across the main set and every holdout", () => {
    const seen = new Map<string, string>();
    for (const project of readdirSync(path.join(REPO, "bench/boards"))) seen.set(project, "bench");
    const twice: string[] = [];
    for (const set of SETS) {
      for (const { project, repo } of listOf(set)) {
        const key = new URL(repo).pathname.slice(1).toLowerCase().replace("/", "-");
        for (const name of new Set([project.toLowerCase(), key])) {
          const was = [...seen.entries()].find(([one]) => one.toLowerCase() === name);
          if (was) twice.push(`${set}: ${project} is already in ${was[1]}`);
          seen.set(name, set);
        }
      }
    }
    expect(twice).toEqual([]);
  });
});

for (const SET of SETS) {
  const HOLDOUT = path.join(REPO, SET);
  const projects = listOf(SET);
  const scopes = JSON.parse(readFileSync(path.join(HOLDOUT, "scopes.json"), "utf8")) as
    { project: string; language: string; topic: string; scope: string; ask: string }[];

  describe(`${SET} shares no project with what the checker was tuned on`, () => {

    it("names no repository a licence cites", () => {
      const licences = readdirSync(path.join(REPO, "src/engine"))
        .filter((file) => file.startsWith("licence"))
        .map((file) => readFileSync(path.join(REPO, "src/engine", file), "utf8"))
        .join("\n");
      // By clone name or by owner/name: a bare `requests` or `pip` is an ordinary word.
      const cited = projects.filter(({ project, repo }) =>
        licences.includes(project) || licences.includes(new URL(repo).pathname.slice(1)));
      expect(cited.map((one) => one.project)).toEqual([]);
    });
  });

  describe(`${SET}'s lists agree`, () => {
    it("pins every project to a full commit", () => {
      for (const one of projects) expect(one.pin, one.project).toMatch(/^[0-9a-f]{40}$/);
    });

    it("draws boards only for listed projects, and some for each, in the project's language", () => {
      const listed = new Map(projects.map((one) => [one.project, one.language]));
      for (const scope of scopes) {
        expect(listed.has(scope.project), scope.project).toBe(true);
        expect(scope.language.replace("tsx", "ts"), `${scope.project}/${scope.topic}`).toBe(listed.get(scope.project));
      }
      for (const one of projects) expect(scopes.some((scope) => scope.project === one.project), one.project).toBe(true);
    });

    it("can install every project's libraries", () => {
      for (const one of projects) {
        if (one.language === "python") expect(existsSync(path.join(HOLDOUT, "libraries", `${one.project}.txt`)), one.project).toBe(true);
        // A TypeScript project with no dependencies (zod) has no install command at all.
        if (one.install) expect(one.install.length, one.project).toBeGreaterThan(0);
      }
    });

    it("keeps boards and keys only for listed scopes", () => {
      const boards = path.join(HOLDOUT, "boards");
      if (!existsSync(boards)) return;
      const wanted = new Set(scopes.map((scope) => `${scope.project}/${scope.topic}`));
      for (const project of readdirSync(boards)) {
        for (const file of readdirSync(path.join(boards, project))) {
          expect(wanted.has(`${project}/${file.replace(/\.(answers\.json|excalidraw)$/, "")}`), `${project}/${file}`).toBe(true);
        }
      }
    });
  });
}
