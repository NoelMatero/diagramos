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
