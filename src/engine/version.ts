/**
 * What drew this board, recorded in the board.
 *
 * A board is a long-lived file in somebody's repository and, until now, it said
 * nothing about the tool that produced it. That is fine right up until the day
 * the meaning of something on a board changes, at which point a board drawn
 * last year and a board drawn today are byte-for-byte identical and need
 * opposite treatment (#134).
 *
 * Two numbers, because they answer two different questions and change at wildly
 * different rates.
 *
 * - `version` is the npm package version. It changes on every release, says
 *   nothing about meaning, and is here for forensics: *which build wrote this*,
 *   when a bug report arrives with a board attached.
 * - `schema` is the one that carries meaning. It is bumped only when what a
 *   board *says* changes -- three or four times in a tool's life, not weekly --
 *   so it stays quiet in diffs and a reader learns something from a difference.
 *
 * ## Absence is a reading, not a gap
 *
 * Every board drawn before this existed carries no stamp, and no amount of
 * writing one now can reach them. So the absence has to mean something chosen
 * rather than something left over: **an unstamped board is schema 1**, the
 * meaning in force the day stamping began. That is free, it is correct for all
 * of them, and it is why nothing here ever backfills a stamp onto a board it
 * merely read.
 *
 * That last part is the rule worth guarding. The stamp records *generation*, so
 * it is written by `createDiagram` and nowhere else. If `readBoard` applied it
 * as a default, then opening an old board and saving it would relabel it as
 * current, which is precisely the confusion the stamp exists to prevent -- and
 * it would do it silently, to every board anybody touched.
 */
import pkg from "../../package.json";

/**
 * The npm version of the tool doing the drawing.
 *
 * Read from `package.json` rather than restated, because a version written down
 * twice is a version that disagrees with itself: `src/mcp/server.ts` announced
 * `0.1.0` to every MCP client for the whole of the 0.2 line by doing exactly
 * that. esbuild inlines this at build time, so the published bundle carries the
 * version it was built from and does not go looking for a file at runtime.
 */
export const TOOL_VERSION: string = pkg.version;

/**
 * What a board written today *means*.
 *
 * Bump this only for a change to the meaning of something already on a board --
 * and, per `claim.ts`, only a change that makes a board *louder* actually needs
 * the bump. A new claim word does not; a check going quiet does not. Adding a
 * number here that nothing reads differently is how a version field becomes
 * decoration.
 */
export const BOARD_SCHEMA = 1;

/** The stamp a generated board carries at its top level. */
export interface BoardStamp {
  /** The npm version of the tool that generated it. Informational. */
  version: string;
  /** What the board means. Absent on a board older than stamping: read as 1. */
  schema: number;
}

/** The stamp to write onto a board being generated now. */
export function currentStamp(): BoardStamp {
  return { version: TOOL_VERSION, schema: BOARD_SCHEMA };
}

/**
 * What a board means, whether or not it says so.
 *
 * The whole point of the default: a board with no stamp is not unknown, it is
 * schema 1. Callers get a number every time and never have to decide what
 * nothing means.
 */
export function schemaOf(stamp: BoardStamp | undefined): number {
  return typeof stamp?.schema === "number" ? stamp.schema : 1;
}

/**
 * Semver ordering, enough of it to answer "is that board newer than me".
 *
 * Hand-written rather than a dependency because one question is asked of it:
 * whether a version string from somewhere else is ahead of this build's. The
 * prerelease rule is the part worth having and the part a naive string compare
 * gets wrong -- `0.2.0-rc.10` sorts before `0.2.0-rc.9` as text, and
 * `0.2.0-rc.5` sorts *after* `0.2.0` as text when it precedes it in fact. This
 * whole line has shipped as `-rc.N`, so both mistakes were live.
 *
 * Anything unparseable compares equal to everything, which is the safe answer:
 * "newer" is what unlocks an excuse, and a version nobody can read should not
 * earn one.
 */
function parts(version: string): { release: number[]; pre: string[] } | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(version.trim());
  if (!match) return undefined;
  return {
    release: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** -1, 0 or 1, and 0 whenever either side cannot be read. */
export function compareVersions(left: string, right: string): number {
  const a = parts(left);
  const b = parts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return a.release[index] < b.release[index] ? -1 : 1;
  }
  // A prerelease precedes the release it leads to: 0.2.0-rc.5 < 0.2.0.
  if (a.pre.length === 0 || b.pre.length === 0) {
    if (a.pre.length === b.pre.length) return 0;
    return a.pre.length === 0 ? 1 : -1;
  }
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const one = a.pre[index];
    const two = b.pre[index];
    // A shorter set of identifiers precedes a longer one with the same prefix.
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    if (one === two) continue;
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two);
    if (numeric) return Number(one) < Number(two) ? -1 : 1;
    // Numeric identifiers rank below alphanumeric ones, per semver.
    if (/^\d+$/.test(one)) return -1;
    if (/^\d+$/.test(two)) return 1;
    return one < two ? -1 : 1;
  }
  return 0;
}

/**
 * Whether a board was drawn by a build ahead of this one.
 *
 * The question `claim.ts` cannot answer on its own. The claim whitelist is
 * closed, and falling off it is loud on purpose -- but "this word is not a
 * claim" and "this word is not a claim *yet, here*" are different facts, and an
 * old build shipping the first about a board that deserves the second invents a
 * red on a diagram that is completely fine (#181).
 *
 * An unstamped board is not newer: stamping began mid-line, so absence means
 * old, exactly as `schemaOf` reads it.
 */
export function boardIsNewer(stamp: BoardStamp | undefined): boolean {
  const written = typeof stamp?.version === "string" ? stamp.version : undefined;
  if (!written) return false;
  return compareVersions(written, TOOL_VERSION) > 0;
}

/**
 * What to say about a word this build does not have, on a board a newer build
 * drew.
 *
 * `shown` is the word as its own vocabulary spells it -- `@needs` for an arrow,
 * `closed` for a box -- because a reader matching the message against the board
 * should not have to know that one of them carries the `@` and the other does
 * not.
 *
 * Still a finding, and still loud: nothing checked the claim, and that remains
 * true whoever's fault it is. What changes is the diagnosis. "This is not a
 * word" told an author to go and fix a board that was already correct; this
 * tells them their tool is behind, which is both true and the thing they can
 * act on.
 */
export function newerBuildClaimError(shown: string, stamp: BoardStamp | undefined): string {
  return `"${shown}" is not a word this build knows, but this board was drawn by diagramos `
    + `${stamp?.version} and you are running ${TOOL_VERSION}. It is almost certainly a claim added `
    + `since. Nothing checked it here — update diagramos rather than changing the board.`;
}
