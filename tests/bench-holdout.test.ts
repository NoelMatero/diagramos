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
const HOLDOUT = path.join(REPO, "bench-holdout");
const projects = JSON.parse(readFileSync(path.join(HOLDOUT, "projects.json"), "utf8")) as HoldoutProject[];
const scopes = JSON.parse(readFileSync(path.join(HOLDOUT, "scopes.json"), "utf8")) as
  { project: string; language: string; topic: string; scope: string; ask: string }[];

describe("the holdout shares no project with what the checker was tuned on", () => {
  it("names no project of the main set", () => {
    const main = new Set(readdirSync(path.join(REPO, "bench/boards")));
    expect(projects.map((one) => one.project).filter((name) => main.has(name))).toEqual([]);
  });

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

describe("the holdout's lists agree", () => {
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
