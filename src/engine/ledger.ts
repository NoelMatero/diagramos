/**
 * The coverage ledger: which files anything vouches for as source of this repo.
 *
 * A "wrong" verdict rests on having read the file, and until now nothing checked
 * that we had. The reader in `deps.ts` will happily parse anything with the right
 * extension -- a 13 MB generated bundle in `vendor/`, a build artifact under
 * `out/`, a helper script in a hidden directory -- and produce a confident list
 * of dependencies from it. Confident, and about something nobody wrote or
 * maintains. On this repository that is 183 files that clear every other gate.
 *
 * So a verdict needs a **second opinion that the file is source at all**, from
 * somewhere that is not our own reader. Two places already hold one, and a file
 * only has to satisfy either:
 *
 * - **Git**, asked what it knows about: everything tracked, plus everything
 *   untracked that no ignore rule covers. This is the authority that matters day
 *   to day, because it is right about a file one second after you create it.
 * - **Graphify's `manifest.json`**, which records every file it walked with an
 *   mtime and an AST hash. Built at commit time, so it lags -- but it is a walk
 *   with its own rules, and it covers a repository that is not a git checkout.
 *
 * **Either, not both, and the reason is a measurement.** The manifest alone
 * vouches for 70 of this repository's 92 source files: gate on it by itself and
 * the check goes quiet on 41 files somebody wrote, which are precisely the files
 * being worked on. A gate that switches itself off while you work is a gate
 * nobody keeps. Git alone would be enough here; the manifest is kept in the union
 * because it is the one that survives a checkout with no `.git`.
 *
 * **What this does not answer: freshness.** The ledger vouches that a file *is*
 * source, not that any index of it is current, and the two must not be confused.
 * Our own reader always reads the file on disk as it is right now, so a file
 * edited since graphify last ran is still perfectly readable. Gating on the hash
 * would mean the check switched itself off on every file you touched. Staleness
 * is a question about the *graph*, and `codegraph.ts` already answers it there.
 *
 * **Absent means off, not empty.** No manifest and no git, unparseable JSON, a
 * shape we do not recognise, a ledger vouching for nothing at all: every one of
 * those is `undefined`, and the gate does nothing. A second opinion nobody gave
 * is not a second opinion that said no. The primary evidence -- our own read of
 * the text -- is unchanged either way.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { licenceFor } from "./licence";
import type { Workspace } from "./workspace";

/** The files something vouches for as source, repo-relative, separators normalised. */
export interface Ledger {
  files: ReadonlySet<string>;
}

/** One row of graphify's manifest. Both fields are required to trust the row. */
interface ManifestEntry {
  mtime?: unknown;
  ast_hash?: unknown;
}

/**
 * Parse a manifest into a ledger.
 *
 * Strict on purpose, in the same way `loadCodeGraph` is strict: one row that is
 * not the shape we know how to read refuses the whole file. A ledger we half
 * understand is a ledger that would vouch for the wrong things, and vouching is
 * the only thing it does.
 */
export function loadLedger(manifest: unknown): Ledger | undefined {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return undefined;

  const files = new Set<string>();
  for (const [key, value] of Object.entries(manifest as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const entry = value as ManifestEntry;
    if (typeof entry.mtime !== "number" || typeof entry.ast_hash !== "string") return undefined;
    if (!key) return undefined;
    files.add(key.split("\\").join("/"));
  }

  // A ledger that vouches for nothing would silence every verdict on the board,
  // which is not what an empty file means. It means nothing ran.
  return files.size === 0 ? undefined : { files };
}

/**
 * Every file git knows about: tracked, plus untracked and not ignored.
 *
 * Both halves are needed and each covers the other's gap. `--cached` alone would
 * refuse a verdict on a file you created a minute ago and have not staged, which
 * is the file you are most likely to be drawing. `--others` alone would be every
 * scratch file in the tree. Together they are "what a `git status` would call
 * part of this repository", which is the question being asked -- and
 * `--exclude-standard` is what drops `out/`, `vendor/` and the dotted
 * directories, because somebody already wrote those rules down in `.gitignore`.
 *
 * `undefined` on any failure, including not being a git repository at all.
 *
 * Exported because the board page asks the same question for a different reason:
 * the panel that anchors a box to a file offers this list to pick from, so a ref
 * is chosen rather than typed. "Files this repository has" is one question, and
 * answering it twice would be two answers waiting to disagree.
 */
export function gitKnown(root: string): Set<string> | undefined {
  try {
    const listed = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    );
    const files = new Set<string>();
    for (const entry of listed.split("\0")) {
      const file = entry.trim();
      if (file) files.add(file.split("\\").join("/"));
    }
    return files.size === 0 ? undefined : files;
  } catch {
    return undefined;
  }
}

/** The manifest, if graphify has ever run here and wrote something we can read. */
function manifestLedger(root: string): Ledger | undefined {
  try {
    const manifest = path.join(root, "graphify-out", "manifest.json");
    return loadLedger(JSON.parse(readFileSync(manifest, "utf8")));
  } catch {
    return undefined;
  }
}

/**
 * The ledger for a repository: git and the manifest, unioned.
 *
 * `undefined` when neither authority answered, and the checker then behaves
 * exactly as it did before this module existed.
 */
export function createLedger(root: string): Ledger | undefined {
  const git = gitKnown(root);
  const manifest = manifestLedger(root);
  if (!git) return manifest;
  if (!manifest) return { files: git };
  return { files: new Set([...git, ...manifest.files]) };
}

/**
 * Whether a verdict may be built on this file.
 *
 * True when there is no ledger, because a gate with no authority behind it must
 * not be the thing that decides. See the header.
 */
export function vouchedFor(ledger: Ledger | undefined, file: string): boolean {
  return !ledger || ledger.files.has(file);
}

/**
 * Files the ledger names that a tree walk never offered, and that exist and can
 * be read.
 *
 * This is the ledger used the other way round, and the asymmetry is deliberate.
 * `needs` is a claim about two named files, so an unvouched file *subtracts* --
 * it withholds the verdict. `closed` is a claim about *every* file, so a file
 * the walk missed *adds*: `sourceFilesUnder` refuses to enter dotted and vendored
 * directories, and a script sitting in one of them can import straight into a
 * box that then goes green on a walk that never looked. The ledger says what is
 * in the places we will not go, without our having to go there.
 *
 * Only licensed files come back. A Python fixture cannot import a TypeScript
 * module, so counting it against the box would be pessimism with nothing behind
 * it -- and it is invisible to the walk today for the same reason. Files the
 * ledger names that no longer exist are dropped too: a deleted file imports
 * nothing, and treating a ledger built one commit ago as evidence of a hole
 * would make every `closed` box unprovable the moment somebody removed a file.
 */
export function ledgerAdditions(
  ledger: Ledger | undefined,
  walked: readonly string[],
  workspace: Workspace,
): string[] {
  if (!ledger) return [];
  const already = new Set(walked);
  const extra: string[] = [];
  for (const file of ledger.files) {
    if (already.has(file) || !licenceFor(file)) continue;
    const absolute = workspace.resolve(file);
    if (!absolute || workspace.stat(absolute) !== "file") continue;
    extra.push(file);
  }
  return extra.sort();
}
