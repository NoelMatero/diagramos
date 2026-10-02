/**
 * Reading `bench:planted --details` back, so two runs can be compared arrow
 * for arrow (#403).
 *
 * A run is either a folder written by `bench-planted-runs.mts` (one
 * `<project>.txt` per project) or the output of one whole
 * `npm run bench:planted -- --details`, whose `  == <project>` lines say
 * where each project starts. Both read as the same list.
 *
 * An arrow is named by its project, its place in that project, its word and
 * its two ends. The place is what tells apart two claims on the same ends
 * with the same word, which the key does carry (a drawn claim and a plant can
 * coincide); two runs over the same keys line up one to one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface Arrow {
  id: string;
  project: string;
  outcome: string;
  truth: string;
  source: string;
  language: string;
  reason: string;
  word: string;
  from: string;
  to: string;
  /** What the checker said, without the time the check took -- which no two runs share. */
  detail: string;
}

export interface Run {
  arrows: Map<string, Arrow>;
  /** Projects present with no arrow lines: a run that died before printing any. */
  empty: string[];
}

const LINE = /^ {4}(red|not sure|green|silent)\s+(true|false)\s+(\S+)\s+(\S+)\s+\[(.*?)\] @(\S+) (.+?) -> (.+?) \| (.*)$/;
const PROJECT = /^ {2}== (\S+)$/;
/** The timing and gate columns #393 added to each line; the timing is noise between runs. */
const TIMING = / \| \d+ms \| gate: (.*)$/;

function parse(text: string, project: string | undefined, into: Map<string, Arrow>, counts: Map<string, number>): void {
  let current = project;
  for (const line of text.split("\n")) {
    const header = PROJECT.exec(line);
    if (header) { current = header[1]!; counts.set(current, counts.get(current) ?? 0); continue; }
    const match = LINE.exec(line);
    if (!match || current === undefined) continue;
    const [, outcome, truth, source, language, reason, word, from, to, rest] = match as unknown as string[];
    const timing = TIMING.exec(rest!);
    const detail = timing ? `${rest!.slice(0, timing.index)} | gate: ${timing[1]}` : rest!;
    const n = counts.get(current) ?? 0;
    counts.set(current, n + 1);
    const id = `${current}#${n} @${word} ${from} -> ${to}`;
    into.set(id, {
      id, project: current, outcome: outcome!, truth: truth!, source: source!, language: language!,
      reason: reason!, word: word!, from: from!, to: to!, detail,
    });
  }
}

/** A folder of per-project files, or one whole run's output. */
export function readRun(where: string): Run {
  if (!existsSync(where)) throw new Error(`${where}: no such file or folder`);
  const arrows = new Map<string, Arrow>();
  const counts = new Map<string, number>();
  if (statSync(where).isDirectory()) {
    for (const file of readdirSync(where).filter((one) => one.endsWith(".txt")).sort()) {
      const project = file.replace(/\.txt$/, "");
      counts.set(project, 0);
      parse(readFileSync(path.join(where, file), "utf8"), project, arrows, counts);
    }
  } else {
    parse(readFileSync(where, "utf8"), undefined, arrows, counts);
  }
  return { arrows, empty: [...counts].filter(([, n]) => n === 0).map(([project]) => project) };
}
