/**
 * Every file under a tree that a measurement should read.
 *
 * Walked a directory at a time, and a skipped directory is never entered. The
 * version this replaces listed the whole tree with `find` and filtered the
 * list afterwards, so an installed `node_modules` was listed in full before
 * being thrown away. On `~/mundane` (126,863 files) and `~/infrarouter` that
 * overflowed `execFileSync`'s output buffer, a blanket `catch` read the
 * `ENOBUFS` as "no files here", and `measure:calls` went on reporting seven
 * trees while it read five (#254). The same walk `resolution-ts.ts` and
 * `licence.ts` already use.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { languageOf } from "../../src/engine/parse";

/** Build output, dependencies and tooling, never source a diagram points at. */
const SKIPPED = new Set(["target", "node_modules", ".git", "dist", "out", "vendor", ".venv", ".claude"]);

export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    let entries: string[];
    try { entries = readdirSync(directory); } catch { return; }
    for (const entry of entries.sort()) {
      if (SKIPPED.has(entry)) continue;
      const full = path.join(directory, entry);
      let info;
      try { info = statSync(full); } catch { continue; }
      if (info.isDirectory()) walk(full);
      else if (info.isFile() && languageOf(full) !== undefined) found.push(full);
    }
  };
  walk(root);
  return found;
}
