/**
 * Which build a running board service is, and whether it is still this one.
 *
 * The board service is spawned detached so it survives the terminal and the
 * session that started it (`daemon.ts`), which is the whole point of it. What
 * nothing recorded was *what started it*. So a service left running by an older
 * install kept serving after the package moved on, and its failure mode was not
 * a missing feature — it was a red on a board that was completely fine.
 *
 * Measured, on a live process: a board carrying `@takes` and `@returns` served
 * seven `garbledClaims` and `clean: false`, while a fresh process on the same
 * file reported nothing wrong (#181). The old build has no such words in its
 * whitelist, so it took valid claims for typos — correct behaviour for a typo,
 * and an invented accusation here. The penalty lands precisely on the release
 * that adds a word, which is the worst possible moment, because the author has
 * just written the claim and is looking at the board to see whether it took.
 *
 * ## Two things make a service stale, and one is not enough
 *
 * `version` alone misses the case that was actually reported. That service was
 * a local build of `out/cli/serve.mjs`; the file on disk had since been rebuilt
 * and *did* know `takes`, but a rebuild does not bump `package.json`, so both
 * sides said the same number while running opposite code. Every stale-artefact
 * bug in this repository's history (#77, #116, PR #87) is that shape.
 *
 * `builtAt` alone misses the published case, where two installs of different
 * versions sit in different directories and neither has changed since it
 * started.
 *
 * ## Why this cannot thrash
 *
 * The tempting design — each caller computes its own identity and restarts
 * anything that differs — has a failure nobody would enjoy: a globally
 * installed CLI and a source checkout would take turns killing each other's
 * service, and the board would die under the user every time they switched.
 *
 * So the staleness test is deliberately *self-referential*. A service records
 * the directories it was loaded from and how new they were at the time; a
 * caller re-reads those same directories and asks whether they have moved since.
 * Two different callers get the same answer about the same service, because
 * neither answer involves the caller at all. The only test that does compare
 * across is `version`, which is stable for a given install.
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TOOL_VERSION } from "../engine/version";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** What a service records about the build it is running. */
export interface BuildIdentity {
  /** The npm version. Catches a different release; blind to a rebuild. */
  version: string;
  /**
   * Absolute directories holding the code it loaded. Recorded rather than
   * re-derived so a caller of another flavour re-reads *its* directories
   * instead of comparing them against its own, which is what would thrash.
   */
  builtFrom: string[];
  /** Newest mtime under those directories, in ms, when the service started. */
  builtAt: number;
}

/**
 * The newest file under a directory, by mtime, ignoring what cannot be read.
 *
 * Mtime is a heuristic, and the established one here — `tests/helpers/
 * fresh-bundle.ts` already refuses a stale bundle this way. The two error
 * directions are not close: a false alarm costs a one-second service restart,
 * and a false negative is the invented red this file exists to stop.
 */
/**
 * How long a directory reading is reused.
 *
 * `findServing` is called in a 100ms poll loop while a service starts, so an
 * uncached walk of `src` would stat a few hundred files a hundred and fifty
 * times per start. A second of staleness cannot hide anything that matters:
 * the thing being detected is a rebuild, and no rebuild finishes and gets
 * asked about inside one.
 */
const READING_TTL_MS = 1000;
const readings = new Map<string, { at: number; mtime: number }>();

function newestMtimeCached(directory: string): number {
  const hit = readings.get(directory);
  const now = Date.now();
  if (hit && now - hit.at < READING_TTL_MS) return hit.mtime;
  const mtime = newestMtime(directory);
  readings.set(directory, { at: now, mtime });
  return mtime;
}

function newestMtime(directory: string): number {
  let newest = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    try {
      if (entry.isDirectory()) newest = Math.max(newest, newestMtime(target));
      else if (/\.(ts|tsx|mjs|mts|js)$/.test(entry.name)) newest = Math.max(newest, statSync(target).mtimeMs);
    } catch {
      // A file that vanished mid-walk is a build in progress, not a reading.
    }
  }
  return newest;
}

/**
 * Where the code this process is running actually lives.
 *
 * Mirrors `serviceCommand` in `daemon.ts` and for the same reason: built, we
 * are a bundle in out/cli and that is the whole of us; from source we are
 * TypeScript spread across src and scripts, and the entry file's own mtime says
 * nothing about whether the engine underneath it moved.
 */
function buildDirs(): string[] {
  const packaged = import.meta.url.includes("/out/cli/");
  return packaged ? [path.join(ROOT, "out/cli")] : [path.join(ROOT, "src"), path.join(ROOT, "scripts")];
}

/** This build, as a service should record it. */
export function buildIdentity(): BuildIdentity {
  const builtFrom = buildDirs();
  return {
    version: TOOL_VERSION,
    builtFrom,
    builtAt: Math.max(0, ...builtFrom.map(newestMtimeCached)),
  };
}

/**
 * Why a recorded service is no longer the build to trust, or nothing.
 *
 * The sentence is for a person, so it names the harm rather than the mechanism:
 * somebody who has just been told their board is being restarted wants to know
 * that the alternative was wrong answers.
 *
 * A service registered before any of this existed has no `build` at all. That
 * absence is read as stale, not as unknown — it can only have been written by a
 * build that predates the check, which is exactly the situation being fixed.
 */
export function staleService(recorded: BuildIdentity | undefined): string | undefined {
  const current = buildIdentity();
  if (!recorded || typeof recorded.version !== "string") {
    return "it was started by a build from before board services recorded which build they are";
  }
  if (recorded.version !== current.version) {
    return `it is running ${recorded.version} and this is ${current.version}`;
  }
  const dirs = Array.isArray(recorded.builtFrom) ? recorded.builtFrom.filter((dir) => typeof dir === "string") : [];
  if (dirs.length === 0 || typeof recorded.builtAt !== "number") {
    return "it did not record what it was built from";
  }
  /*
   * Strictly newer, not merely different. An equal mtime is the same build, and
   * a directory whose mtime went *backwards* — a checkout, a restore — is not
   * evidence the running service is behind anything.
   */
  const now = Math.max(0, ...dirs.map(newestMtimeCached));
  if (now > recorded.builtAt) {
    return "the code behind it has been rebuilt since it started, and a running service keeps the copy it loaded";
  }
  return undefined;
}
