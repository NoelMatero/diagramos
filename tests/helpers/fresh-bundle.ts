/**
 * Refuse to test against a stale CLI bundle.
 *
 * The service suites spawn `out/cli/diagramos.mjs` — a build artifact. When it
 * falls behind the sources, the spawned service can die on a file that does
 * not exist yet, and every test that waited for it fails as a 60-second
 * timeout: 41 tests, ~7 minutes of failing slowly, reading like broken code
 * on a machine where the only problem was a day-old bundle (#77).
 *
 * `npm test` rebuilds the bundle first (the `pretest` script, ~0.3s). This
 * guard covers the other way in — `npx vitest run` on one file — by failing
 * in milliseconds with the one command to run. Mtime comparison is a
 * heuristic: a false alarm costs a 0.3-second rebuild, and the false-negative
 * case (a checkout that regresses mtimes) is caught by pretest on the next
 * full run.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "../..");
const BUNDLE_DIR = path.join(REPO, "out/cli");
/** Everything the bundle is built from. */
const SOURCE_DIRS = ["src", "scripts"];

function newestMtime(directory: string): number {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(target));
    } else if (/\.(ts|tsx|mjs|mts)$/.test(entry.name)) {
      newest = Math.max(newest, statSync(target).mtimeMs);
    }
  }
  return newest;
}

export function assertFreshCliBundle(): void {
  let bundleBuiltAt = Infinity;
  try {
    for (const entry of readdirSync(BUNDLE_DIR)) {
      bundleBuiltAt = Math.min(bundleBuiltAt, statSync(path.join(BUNDLE_DIR, entry)).mtimeMs);
    }
  } catch {
    bundleBuiltAt = 0;
  }
  if (bundleBuiltAt === Infinity) bundleBuiltAt = 0;

  const sourcesChangedAt = Math.max(...SOURCE_DIRS.map((dir) => newestMtime(path.join(REPO, dir))));
  if (bundleBuiltAt >= sourcesChangedAt) return;

  throw new Error(
    "out/cli is older than the sources — these tests spawn that bundle, and a stale one "
      + "fails as a wall of timeouts. Run `npm run build:cli` (0.3s) and try again; "
      + "`npm test` does this on its own.",
  );
}
