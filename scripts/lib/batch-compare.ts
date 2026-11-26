/**
 * Reading two measurement runs side by side, for `measure:batch`.
 *
 * Three kinds of output, each read the way the batch chains under
 * `~/bench-*` read them by hand until now:
 *
 * - **A study set's per-claim dump** (`bench:planted --dump`): one JSON line
 *   per scored claim. Compared claim by claim -- outcome, reason and the
 *   checker's own sentence -- and counted.
 * - **A score-only set's report** (holdout-c, holdout-d): only the tables
 *   are read, and the safety sections (FALSE REDS, GREEN ON A FALSE CLAIM)
 *   are compared line for line without a single line of them leaving this
 *   file: the answer is "identical" or how many lines are only on one side.
 *   Its arrows are never printed (`~/bench-477/safety-c.py`, the rule).
 * - **A compiler-true report**: the word table and every red.
 *
 * Timing never counts as a difference: the `ms` field, the header's run time,
 * its pause and machine lines.
 *
 * Measurement only. Nothing in `src/` uses this.
 */
import { existsSync, readFileSync } from "node:fs";

export interface DumpRow {
  set: string; project: string; topic: string; cid: string; word: string; from: string; to: string;
  truth: string; source: string; language: string; outcome: string; reason: string; detail: string;
  gate?: string; ms?: number;
}

const keyOf = (row: DumpRow) => `${row.project}|${row.topic}|${row.cid}`;

/** A dump as claim -> row. A file holding several runs appended keeps the last row per claim. */
export function loadDump(file: string): Map<string, DumpRow> {
  const rows = new Map<string, DumpRow>();
  if (!existsSync(file)) return rows;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as DumpRow;
    rows.set(keyOf(row), row);
  }
  return rows;
}

export interface Score { caught: number; falseReds: number; wrongGreens: number; trueGreens: number; planted: number; correct: number }

export function scoreOfDump(rows: Map<string, DumpRow>): Score {
  const score: Score = { caught: 0, falseReds: 0, wrongGreens: 0, trueGreens: 0, planted: 0, correct: 0 };
  for (const row of rows.values()) {
    if (row.truth === "false") {
      score.planted += 1;
      if (row.outcome === "red") score.caught += 1;
      if (row.outcome === "green") score.wrongGreens += 1;
    } else if (row.truth === "true") {
      score.correct += 1;
      if (row.outcome === "red") score.falseReds += 1;
      if (row.outcome === "green") score.trueGreens += 1;
    }
  }
  return score;
}

export interface Changed { key: string; base?: DumpRow; branch?: DumpRow }

/** Every claim whose outcome, reason or checker sentence differs, or that is on one side only. */
export function changedClaims(base: Map<string, DumpRow>, branch: Map<string, DumpRow>): Changed[] {
  const out: Changed[] = [];
  for (const key of new Set([...base.keys(), ...branch.keys()])) {
    const a = base.get(key);
    const b = branch.get(key);
    if (!a || !b || a.outcome !== b.outcome || a.reason !== b.reason || a.detail !== b.detail) {
      out.push({ key, ...(a ? { base: a } : {}), ...(b ? { branch: b } : {}) });
    }
  }
  return out;
}

/** One changed claim, for a study set only. */
export function changedLine(change: Changed): string {
  const row = change.branch ?? change.base!;
  const side = (one: DumpRow | undefined) => (one ? `${one.outcome} [${one.reason}]` : "absent");
  const detail = change.base && change.branch && change.base.outcome === change.branch.outcome && change.base.reason === change.branch.reason
    ? " (only the checker's sentence changed)" : "";
  return `${row.project}/${row.topic} · ${row.truth} ${row.language} @${row.word} ${row.from} -> ${row.to}: ${side(change.base)} -> ${side(change.branch)}${detail}`;
}

/* ---------------------------------------------------------- a report's text */

/** The `ALL` row of a table that starts with `title`: claims, red, not sure, green, silent. */
function allRow(text: string, title: string): number[] | undefined {
  const at = text.indexOf(`  ${title}`);
  if (at < 0) return undefined;
  const match = /\n\s+ALL\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(text.slice(at));
  return match ? match.slice(1, 6).map(Number) : undefined;
}

/** The four numbers from a report's own tables, for a set whose arrows are not dumped. */
export function scoreOfReport(text: string): Score | undefined {
  const planted = allRow(text, "FALSE CLAIMS -- ");
  const correct = allRow(text, "TRUE CLAIMS -- ");
  if (!planted || !correct) return undefined;
  return {
    caught: planted[1]!, wrongGreens: planted[3]!, planted: planted[0]!,
    falseReds: correct[1]!, trueGreens: correct[3]!, correct: correct[0]!,
  };
}

/** The lines of a safety section (FALSE REDS, GREEN ON A FALSE CLAIM), for comparing -- never for printing. */
function section(text: string, title: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim().startsWith(title));
  if (start < 0) return [];
  const out: string[] = [lines[start]!.trim()];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "") break;
    out.push(line.trim());
  }
  return out;
}

export interface SafetySame { title: string; base: number; branch: number; identical: boolean; onlyBase: number; onlyBranch: number }

/** Whether a score-only set's safety lines are the same, in counts only (`~/bench-477/safety-c.py`). */
export function safetyCompare(baseText: string, branchText: string): SafetySame[] {
  return ["FALSE REDS", "GREEN ON A FALSE CLAIM"].map((title) => {
    const a = section(baseText, title);
    const b = section(branchText, title);
    const setA = new Set(a);
    const setB = new Set(b);
    return {
      title, base: a.length, branch: b.length,
      identical: a.length === b.length && a.every((line, i) => line === b[i]),
      onlyBase: [...setA].filter((line) => !setB.has(line)).length,
      onlyBranch: [...setB].filter((line) => !setA.has(line)).length,
    };
  });
}

/** A score table's rows (word, language, kind), as text with no arrow in it, for a score-only set's identity line. */
export function scoreTables(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("  FALSE CLAIMS -- "));
  const end = lines.findIndex((line, i) => i > start && /^\s+(FALSE REDS|GREEN ON A FALSE CLAIM)/.test(line));
  if (start < 0) return [];
  return lines.slice(start, end < 0 ? undefined : end).filter((line) => !/@\w+ \S+ -> /.test(line));
}

/**
 * A report with its timing taken out, for "is everything else identical":
 * the per-claim `| 123ms |`, the header's run time, pause and machine lines,
 * and how many answers came from the compiler memory -- how they were got,
 * not what they were.
 */
export function withoutTiming(text: string): string[] {
  const lines = text.split("\n")
    .filter((line) => !/^\s*(pauses|machine|compiler memory|referee memory):/.test(line) && !/^gate: /.test(line) && !/^> /.test(line))
    .map((line) => line
      .replace(/ \| \d+ms \| gate: /, " | gate: ")
      .replace(/(claims scored, \d+ left out as undecidable), in \d+s/, "$1"));
  // `npm run` writes a header and blank lines before the report; a report started without npm has none.
  while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
  while (lines.length > 0 && lines.at(-1)!.trim() === "") lines.pop();
  return lines;
}

/**
 * The lines that differ between two reports, timing taken out, as pairs --
 * only those holding no arrow (no `@word`, no `->`), so a score-only set's
 * header and table lines can be shown and its arrows never are. `hidden`
 * counts the differing lines left out.
 */
export function differingLines(a: string, b: string): { shown: Array<[string | undefined, string | undefined]>; hidden: number } {
  const la = withoutTiming(a);
  const lb = withoutTiming(b);
  const shown: Array<[string | undefined, string | undefined]> = [];
  let hidden = 0;
  const arrow = (line?: string) => line !== undefined && (/@\w+/.test(line) || line.includes("->"));
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] === lb[i]) continue;
    if (arrow(la[i]) || arrow(lb[i])) hidden += 1;
    else shown.push([la[i], lb[i]]);
  }
  return { shown, hidden };
}

/** How many lines differ between two reports once timing is taken out: 0 is the same report. */
export function textDifference(a: string, b: string): number {
  const la = withoutTiming(a);
  const lb = withoutTiming(b);
  let differ = Math.abs(la.length - lb.length);
  for (let i = 0; i < Math.min(la.length, lb.length); i++) if (la[i] !== lb[i]) differ += 1;
  return differ;
}

/** Why a report cannot be compared with another run, if it cannot: empty when it can. */
export function reportProblems(text: string): string[] {
  const out: string[] = [];
  if (/NOT VALID/.test(text)) out.push("NOT VALID (see its header)");
  if (/NOT MEASURED/.test(text)) out.push("a project was not measured");
  if (/machine: SHARED/.test(text)) out.push("machine: SHARED");
  const pauses = /^\s*pauses: (.*)$/m.exec(text)?.[1];
  if (pauses && !/^none seen; power log: no sleep/.test(pauses)) out.push(`pauses: ${pauses}`);
  return out;
}

/* ------------------------------------------------------------ compiler-true */

export interface CompilerTrue { words: Map<string, number[]>; reds: string[] }

/** The word table (pairs, compiler-only, red live, red off, green live) and every red line. */
export function readCompilerTrue(text: string): CompilerTrue {
  const words = new Map<string, number[]>();
  const lines = text.split("\n");
  const head = lines.findIndex((line) => /^\s+word\s+pairs\s+compiler-only/.test(line));
  for (const line of head < 0 ? [] : lines.slice(head + 1)) {
    const match = /^\s+([a-z]+)\s+(\d+)(?:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+))?\s*$/.exec(line);
    if (!match) break;
    words.set(match[1]!, match.slice(2).filter((one) => one !== undefined).map(Number));
  }
  const reds: string[] = [];
  let inReds = false;
  for (const line of lines) {
    if (/^\s+RED, /.test(line)) { inReds = true; continue; }
    if (inReds && line.trim() === "") { inReds = false; continue; }
    if (inReds && !/^\s+\.\.\. \d+ more/.test(line)) reds.push(line.trim());
  }
  return { words, reds };
}
