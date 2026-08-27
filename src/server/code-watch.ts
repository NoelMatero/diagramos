/**
 * Watching the code, so a board can react to it (#130).
 *
 * The board service has always watched one directory: the board's own. Code
 * changes reached the page only by accident -- the Stop hook rewrote the board
 * file at the end of a turn, the board watcher noticed *that*, and the page
 * refreshed. During the stretch where "the diagram shows progress" would mean
 * something, the board was a still picture.
 *
 * ## Why the whole tree, and not the files the board names
 *
 * `boardCoverage` can say exactly which files a board points at, and watching
 * only those would be cheaper and narrower. It would also miss the event this
 * exists for.
 *
 * A `planned` box points at a file that *is not there yet* -- that is what makes
 * it planned. `boardCoverage` records a ref only once it resolves, so the box
 * everybody is waiting on is precisely the one whose path cannot be watched.
 * Worse, a plan like `src/server/live/watch.ts` may have no existing parent
 * directory to watch in its place. The creation is unobservable from any set of
 * paths derived from the board.
 *
 * So the watch is the repository, minus the directories nobody edits by hand.
 * That list is `NOT_WALKED`, shared with board discovery -- `node_modules` alone
 * would cost more watch handles than the whole of the rest of a repo.
 *
 * ## Why this can afford to be indiscriminate
 *
 * Every event funnels into one debounced callback, and the caller's job on that
 * callback is a drift check, measured at 13-62ms on the boards in this
 * repository. A save storm during a refactor collapses into one check, and a
 * `README` edit costs one check that finds nothing. Filtering events by whether
 * the board "cares" would buy a few milliseconds and cost correctness: a new
 * import in a file no box names can change the answer for two boxes that are
 * named, and predicting that from a path is not possible.
 */
import { watch, type FSWatcher } from "node:fs";
import path from "node:path";

import { NOT_WALKED } from "../engine/drift";

/** How long the tree must be quiet before the callback runs. */
const SETTLE_MS = 300;

export interface CodeWatchOptions {
  /** Repository root. Watched recursively. */
  root: string;
  /**
   * Called once per burst of changes, after the tree has been quiet.
   *
   * Never called concurrently with itself: a burst arriving while one is still
   * running is held and delivered after it settles, so a slow check cannot
   * stack up behind a fast editor.
   */
  onSettled: () => void | Promise<void>;
  /** Overridable for tests, which cannot afford to wait out the real one. */
  settleMs?: number;
}

export interface CodeWatch {
  close(): void;
}

/**
 * Whether a path is one worth waking a check for.
 *
 * Board files are excluded, and that exclusion is load-bearing rather than an
 * optimisation. The service writes board files -- that is how a live promotion
 * reaches the page -- and this watcher covers the tree those files live in. A
 * board write would wake the check that produced it, which would write again.
 * Board changes have their own watcher; this one is only about code.
 */
function worthWaking(relative: string): boolean {
  if (relative === "" || relative.startsWith("..")) return false;
  const segments = relative.split(path.sep);
  if (segments.some((segment) => NOT_WALKED.has(segment))) return false;
  // Our own scratch files, which appear and vanish inside an atomic board write.
  if (segments[segments.length - 1]?.endsWith(".tmp")) return false;
  return !relative.endsWith(".excalidraw");
}

/**
 * Starts watching, or returns undefined if the platform will not.
 *
 * A failure is silence, matching every other optional channel here: without a
 * watcher the page still refreshes on focus, on a board write, and on its own
 * slow timer, so liveness degrades and nothing breaks. Recursive watching is
 * native on macOS and Windows and needs Node 20 on Linux; older Linux throws
 * ERR_FEATURE_UNAVAILABLE_ON_PLATFORM here and lands in that same silence.
 */
export function watchCode(options: CodeWatchOptions): CodeWatch | undefined {
  const settleMs = options.settleMs ?? SETTLE_MS;
  const root = path.resolve(options.root);

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let againWhenDone = false;
  let closed = false;

  const run = async () => {
    if (closed) return;
    if (running) {
      againWhenDone = true;
      return;
    }
    running = true;
    try {
      await options.onSettled();
    } catch {
      // A check that threw is not a reason to stop watching. The next change
      // gets its own attempt, and the page keeps its previous report.
    } finally {
      running = false;
      if (againWhenDone && !closed) {
        againWhenDone = false;
        schedule();
      }
    }
  };

  const schedule = () => {
    if (closed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, settleMs);
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, name) => {
      // No filename means the platform could not say what moved. Something did,
      // so check rather than guess it was uninteresting.
      if (name && !worthWaking(String(name))) return;
      schedule();
    });
  } catch {
    return undefined;
  }
  // A watcher that dies must not take the service with it.
  watcher.on("error", () => undefined);

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}
