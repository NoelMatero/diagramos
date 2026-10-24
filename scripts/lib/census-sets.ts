/**
 * The 42 projects a census reads, and which of their files it reads (#467).
 *
 * Shared by `measure-call-census.mts` and `measure-box-lookup.mts`, so the two
 * count over the same files and a compare between them means something.
 *
 * holdout-c is not here on purpose: it is the score-only set, and a census
 * reads every file of a project.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CensusSet { corpus: string; libraries: string; projects: () => string[] }

export function censusSets(repo: string): Record<string, CensusSet> {
  const projectsOfScopes = (folder: string, corpus: string) => (): string[] => {
    const scopes = path.join(repo, folder, "scopes.json");
    if (existsSync(scopes)) {
      const rows = JSON.parse(readFileSync(scopes, "utf8")) as Array<{ project: string }>;
      return [...new Set(rows.map((one) => one.project))].sort();
    }
    return readdirSync(corpus).filter((one) => !one.startsWith(".")).sort();
  };
  const main = process.env.CENSUS_MAIN_CORPUS ?? "/Users/noelmatero/board-ai/.corpus";
  const holdout = (letter: string): CensusSet => {
    const base = path.join(os.homedir(), `.board-ai-holdout${letter}`);
    return {
      corpus: path.join(base, "corpus"),
      libraries: path.join(base, ".corpus-libs"),
      projects: projectsOfScopes(`bench-holdout${letter}`, path.join(base, "corpus")),
    };
  };
  return {
    main: { corpus: main, libraries: path.join(path.dirname(main), ".corpus-libs"), projects: projectsOfScopes("bench", main) },
    holdout: holdout(""),
    "holdout-b": holdout("-b"),
  };
}

export const CENSUS_SET_ORDER = ["main", "holdout", "holdout-b"];

const TEST_DIRS = new Set(["test", "tests", "__tests__", "__test__", "testing", "spec", "__mocks__", "__testfixtures__", "__fixtures__", "fixtures"]);
/**
 * Folders that hold bundles, vendored copies and documentation sites rather
 * than a project's own source: zx's `build/*.cjs`, MobX's `docs/assets`, a
 * Django app's `static/` jQuery, pip's `_vendor` copies of other libraries. No bench board draws from them, and in the
 * first run they made a quarter of holdout-b's TypeScript calls.
 */
const GENERATED_DIRS = new Set(["build", "docs", "static", "assets", "_vendor"]);

/** Tests, bundles, docs, `.d.ts` and minified files: read by no census. */
export const isTestPath = (rel: string): boolean => {
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1]!;
  if (parts.slice(0, -1).some((one) => TEST_DIRS.has(one) || GENERATED_DIRS.has(one))) return true;
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) || /^test_.*\.py$|_test\.py$|^conftest\.py$/.test(base)
    || /(^|_)tests?\.rs$/.test(base) || base.endsWith(".d.ts") || /\.min\.[cm]?js$/.test(base);
};
