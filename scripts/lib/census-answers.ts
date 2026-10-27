/**
 * The call census's raw compiler answers, kept so a later run can reuse them
 * (#481).
 *
 * A census asks pyright, the TypeScript compiler and rust-analyzer where each
 * of ~290,000 calls goes, and the answers do not depend on the checker: the
 * projects are pinned clones. So a run writes every answer it trusts under
 * `<run>/answers/<set>/<project>.json`, and `--reuse=<run>` reads them back,
 * leaving the compiler only the positions it has no kept answer for.
 *
 * An answer is reused only when everything it depends on is unchanged, or it
 * is asked again:
 *
 *   - the project: the clone's commit and the state of its working tree, the
 *     root the census read (a library checkout or the plain clone), and which
 *     libraries were installed and at what pins (`npm run bench:libraries`);
 *   - the compiler: its version, and the board-ai file that asks it -- the
 *     question and what counts as "outside" live there;
 *   - the file: the asking file's own content hash, and the end of the range
 *     asked about as well as its start.
 *
 * Those first two make one key per language (per crate for Rust, whose
 * toolchain can differ crate by crate). `FORMAT` is part of every key: bump it
 * when the census changes how it asks or what it records for an answer.
 *
 * A question that failed -- threw, timed out, a server that did not start or
 * never finished indexing -- has no answer to keep, so nothing is written for
 * it and the next run asks it again.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { LocationOutcome } from "../../src/engine/lsp-symbols";

export const FORMAT = 1;

/** One answer: the declaration's file (relative to the root) and 1-based line, `outside`, or `none` for the compiler's own "nothing here". */
export type KeptAnswer = { file: string; line: number } | "outside" | "none";

/** What a group of answers (a language, or one crate) depends on, apart from each file. */
export interface AnswerKey { [part: string]: string }

interface Group { key: AnswerKey; files: Record<string, { sha: string; answers: Record<string, [number, KeptAnswer]> }> }
interface AnswersFile { format: number; groups: Record<string, Group> }

/**
 * A compiler's outcome as the census records it: a place relative to the
 * root, `outside`, or `none` -- or undefined for a question that failed,
 * which has no answer to record or keep.
 */
export function keptAnswerOf(outcome: LocationOutcome, root: string, outside: (absolute: string) => boolean): KeptAnswer | undefined {
  if ("failed" in outcome) return undefined;
  if ("none" in outcome) return "none";
  return outside(outcome.at.file) ? "outside" : { file: path.relative(root, outcome.at.file), line: outcome.at.line + 1 };
}

export const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** The kept answers of one project: read from an earlier run, added to by this one, written at the end. */
export class ProjectAnswers {
  private readonly earlier: AnswersFile | undefined;
  private readonly kept: AnswersFile = { format: FORMAT, groups: {} };

  constructor(earlierPath?: string) {
    if (!earlierPath || !existsSync(earlierPath)) return;
    try {
      const parsed = JSON.parse(readFileSync(earlierPath, "utf8")) as AnswersFile;
      if (parsed.format === FORMAT) this.earlier = parsed;
    } catch { /* unreadable: nothing to reuse */ }
  }

  /** Whether the earlier run kept answers under exactly this key -- false sends every question in the group to the compiler. */
  matches(group: string, key: AnswerKey): boolean {
    const had = this.earlier?.groups[group];
    return had !== undefined && sameKey(had.key, { ...key, format: String(FORMAT) });
  }

  /** The earlier run's answer at `[start, end)` of a file with this content, if the group's key matched. */
  reuse(group: string, key: AnswerKey, file: string, sha: string, start: number, end: number): KeptAnswer | undefined {
    if (!this.matches(group, key)) return undefined;
    const kept = this.earlier!.groups[group]!.files[file];
    if (!kept || kept.sha !== sha) return undefined;
    const one = kept.answers[String(start)];
    return one && one[0] === end ? one[1] : undefined;
  }

  /** Keep an answer this run trusts, reused or asked. */
  keep(group: string, key: AnswerKey, file: string, sha: string, start: number, end: number, answer: KeptAnswer): void {
    const g = (this.kept.groups[group] ??= { key: { ...key, format: String(FORMAT) }, files: {} });
    const f = (g.files[file] ??= { sha, answers: {} });
    f.answers[String(start)] = [end, answer];
  }

  write(to: string): void {
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, JSON.stringify(this.kept));
  }
}

const sameKey = (a: AnswerKey, b: AnswerKey): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((one, i) => one === kb[i] && a[one] === b[one]);
};

/** Where a run keeps one project's answers. */
export const answersPath = (run: string, set: string, project: string): string => path.join(run, "answers", set, `${project}.json`);
