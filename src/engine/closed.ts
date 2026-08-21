/**
 * Whether a directory really is closed, and what got in if it is not.
 *
 * `needs` gave an arrow a direction, which is what let it be wrong. `closed`
 * does the same for a box, and it is the claim architecture diagrams actually
 * make: you draw a box round a subsystem and put the rest of the system outside
 * it, and what you mean is *the rest of the system does not reach in here*.
 * Until now that box meant nothing a check could read.
 *
 * The evidence is the same reader `needs` uses. What is different is the shape
 * of the claim, and the difference decides the whole design:
 *
 * **`needs` is about one pair of files. `closed` is about every file there is.**
 *
 * That makes the two halves of the answer wildly unequal, and they are treated
 * as unequal here:
 *
 * - **Refuting is cheap and sound.** One import from outside, read out of the
 *   source text, and the claim is false. Nothing else needs to be true; we saw
 *   the line. A breach is reported even if the rest of the repository could not
 *   be read at all.
 * - **Confirming is expensive and gated.** "No file outside reaches in" is a
 *   statement about every file, so it holds only if every file was read to the
 *   end. One unparseable file and the honest answer is *no breach found*, which
 *   is not the same sentence as *closed*.
 *
 * Getting that backwards is the failure mode worth naming: a walk that quietly
 * skipped what it could not read would report a green box for a subsystem it
 * never opened, which is the exact thing this tool exists not to do.
 */
import { readDependencies, type DynamicReason } from "./deps";
import { licenceFor } from "./licence";
import type { ConfigCache } from "./resolve";
import type { Workspace } from "./workspace";

/**
 * The escapes that can hide an import, which is not all of them.
 *
 * `computed-call` and `mutable-function` are about *calling* something, and no
 * call creates a module dependency that is not already declared somewhere in the
 * text -- you cannot import through `table[key]()`. So a file whose only escape
 * is one of those is completely readable for this question, even though `needs`
 * withholds on it. The two claims ask different things of the same flags, and
 * treating all four as equally blinding would cost a confirmation for no reason.
 */
const REACHES_IN = new Set<DynamicReason>(["dynamic-import", "eval"]);

/** One import from outside the box that no door allows. */
export interface ClosedBreach {
  /** The file outside that reached in, repo-relative. */
  file: string;
  /** The file inside the box it reached. */
  into: string;
  /** The specifier as written, so the report can quote it. */
  specifier: string;
  /** 1-based. */
  line: number;
}

export interface ClosedVerdict {
  /** Imports from outside that no door allows. Each one refutes the claim. */
  breaches: ClosedBreach[];
  /**
   * Breaches from test files, held apart rather than dropped.
   *
   * Tests reach into everything, and they have to: testing a private function
   * means importing it. Counting them would make `closed` unclaimable in every
   * repository that has a suite, which is a check nobody can ever switch on.
   *
   * But an exclusion you cannot see is an exclusion that rots, so these are
   * carried, counted and shown -- never filtered out upstream. Renaming a file
   * to `foo.test.ts` moves a breach from one list to the other, in public; it
   * does not make it disappear.
   */
  fromTests: ClosedBreach[];
  /**
   * Doors listed on the box that nothing came through.
   *
   * Not a failure -- a door nobody uses is a subsystem being tidier than it
   * promised. Reported because it is usually a door that *was* used, until the
   * import that needed it moved, and a stale door silently widens the claim.
   */
  unusedDoors: string[];
  /**
   * Files that could not support a statement of absence: half-parsed, reaching
   * out at runtime, or in a language nobody measured.
   *
   * Empty is what turns "no breaches" into "closed". Non-empty and the claim is
   * unproven rather than held, however many breaches were found.
   */
  unread: string[];
  /** True when the walk hit its cap. Then silence proves nothing at all. */
  capped: boolean;
}

/** Is `file` inside `directory`, as repo-relative paths? */
export function inside(file: string, directory: string): boolean {
  return file === directory || file.startsWith(`${directory}/`);
}

/**
 * Every file in the repository, asked whether it reaches into one directory.
 *
 * `files` is the whole source list, supplied by the caller so several closed
 * boxes on one board share a single walk. `isTest` is the caller's rule rather
 * than this module's, because the engine already answered that question once
 * for the coverage walk and two answers to it would be one too many.
 */
export function checkClosed(
  directory: string,
  doors: readonly string[],
  files: readonly string[],
  workspace: Workspace,
  isTest: (file: string) => boolean,
  cache: ConfigCache = new Map(),
  capped = false,
): ClosedVerdict {
  const allowed = new Set(doors);
  const breaches: ClosedBreach[] = [];
  const fromTests: ClosedBreach[] = [];
  const unread: string[] = [];
  const doorsUsed = new Set<string>();

  for (const file of files) {
    if (inside(file, directory)) continue;

    /*
     * An unreadable file is not skipped, it is recorded.
     *
     * Skipping is what makes a walk lie: the box goes green because nothing was
     * found in a file nothing looked at. Recorded, it costs the claim its
     * confirmation and costs nothing else -- any breach found elsewhere still
     * stands, because a breach never depended on this file.
     */
    if (!licenceFor(file)) {
      unread.push(file);
      continue;
    }
    const absolute = workspace.resolve(file);
    if (!absolute || workspace.stat(absolute) !== "file") {
      unread.push(file);
      continue;
    }
    const read = readDependencies(file, workspace.read(absolute), workspace, cache);
    if (!read) {
      unread.push(file);
      continue;
    }
    if (!read.complete || read.dynamic.some((reason) => REACHES_IN.has(reason))) {
      unread.push(file);
      // Its dependencies are still worth reading: what it declares in the text
      // is true whatever else it does at runtime. Only absence is lost.
    }

    for (const dependency of read.dependencies) {
      const target = dependency.file;
      if (!target || !inside(target, directory)) continue;
      if (allowed.has(target)) {
        doorsUsed.add(target);
        continue;
      }
      const breach: ClosedBreach = {
        file,
        into: target,
        specifier: dependency.specifier,
        line: dependency.line,
      };
      (isTest(file) ? fromTests : breaches).push(breach);
    }
  }

  return {
    breaches,
    fromTests,
    unusedDoors: doors.filter((door) => !doorsUsed.has(door)),
    unread,
    capped,
  };
}
