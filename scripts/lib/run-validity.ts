/**
 * Whether a measurement run could really check what it scored, stated in
 * its header, and a failure when it could not.
 *
 * ## The bad outcome
 *
 * On 2026-11-22, on a new machine, no Rust crate's dependencies had been
 * downloaded. The checker builds `--offline`, so every Rust build failed, the
 * Rust compiler answered nothing, and every arrow that needed it came back
 * "not sure" -- the safe answer, as designed. But `measure:compiler-true
 * --language=rust` printed 0 pairs and exited 0, and a bench run would have
 * printed a lower Rust score that looked exactly like a real one. Nothing in
 * either output said the compiler had been off. The review of the Fonseca
 * 2017 paper counted about 22 earlier cases of this shape, each fixed alone
 * by one more warning line in one more script.
 *
 * ## What this does
 *
 * - `CompilerTally` adds up, over a run, how many questions each compiler was
 *   asked and how many it answered, per language and per project, and which
 *   Rust crates built. The counts come from the checks themselves
 *   (`RefereeNote.questions`, `RefereeNote.crates`), never from settings.
 * - `tally.problems()` is the robust half of the rule: a compiler asked a
 *   real number of questions that answered none, or a Rust compiler that
 *   built none of the crates it was asked for, makes the run NOT VALID.
 * - Canaries (`judgeCanaries`) are the sanity checks from the paper: a few
 *   arrows per language that are wrong on purpose and that only a compiler
 *   catches. They are asked first, in the real environment, and a language
 *   whose canaries do not go red stops the run with the most likely reason.
 * - `judgeCompilerTrue` is the same rule for the correctness check: 0 pairs,
 *   or too many projects that measured nothing, is a failure.
 *
 * None of this changes what counts as caught or missed. It only says whether
 * the run had the chance to catch anything.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { RefereeNote } from "../../src/engine/referee-live";
import type { CrateOutcome } from "../../src/engine/referee-rustc";

/** The names a check reports its compilers by, and the language each one answers for. */
const LANGUAGE_OF: Record<string, string> = { typescript: "ts", python: "python", rust: "rust", rustc: "rust" };
const NAME_OF: Record<string, string> = {
  typescript: "the TypeScript compiler",
  python: "pyright",
  rust: "rust-analyzer",
  rustc: "the Rust compiler",
};
/** The order a header lists them in. */
const REFEREES = ["typescript", "python", "rust", "rustc"];

/** A claim's language as the bench writes it, folded to the language a compiler answers: `tsx` is TypeScript. */
export const languageGroup = (language: string): string => (language === "tsx" ? "ts" : language);

/**
 * Fewer questions than this, all unanswered, is not taken as a broken
 * compiler: a run narrowed to one small project can ask a handful that
 * nothing could answer. A whole run asks hundreds per language.
 */
export const MIN_ASKED = 10;

const thousands = (n: number) => n.toLocaleString("en-US");

interface Count { asked: number; answered: number }

export class CompilerTally {
  /** referee -> project -> counts. */
  private readonly questions = new Map<string, Map<string, Count>>();
  /** project -> manifest -> the last outcome seen. A build can finish between two checks. */
  private readonly crates = new Map<string, Map<string, CrateOutcome>>();
  /** referee -> projects where it was needed and did not start. */
  private readonly silent = new Map<string, Set<string>>();
  /** Checks whose first pass settled everything, so nothing was asked. */
  nothingToAsk = 0;
  checks = 0;

  add(project: string, note: Pick<RefereeNote, "silent" | "nothingToAsk" | "questions" | "crates">): void {
    this.checks += 1;
    if (note.nothingToAsk) this.nothingToAsk += 1;
    for (const [referee, count] of Object.entries(note.questions ?? {})) {
      const byProject = this.questions.get(referee) ?? new Map<string, Count>();
      const row = byProject.get(project) ?? { asked: 0, answered: 0 };
      row.asked += count.asked;
      row.answered += count.answered;
      byProject.set(project, row);
      this.questions.set(referee, byProject);
    }
    for (const referee of note.silent) {
      const where = this.silent.get(referee) ?? new Set<string>();
      where.add(project);
      this.silent.set(referee, where);
    }
    for (const crate of note.crates ?? []) {
      const byManifest = this.crates.get(project) ?? new Map<string, CrateOutcome>();
      // A crate seen built once stays built: a later check that ran out of
      // time before reading it is not a failed build.
      // One package may have a library and programs: each target is a crate of its own.
      const key = crate.target ? `${crate.manifest}#${crate.target}` : crate.manifest;
      if (!byManifest.get(key)?.built) byManifest.set(key, crate);
      this.crates.set(project, byManifest);
    }
  }

  /** Everything this tally holds, so a child process can hand it to its parent. */
  toJSON(): TallyData {
    return {
      checks: this.checks,
      nothingToAsk: this.nothingToAsk,
      questions: Object.fromEntries([...this.questions].map(([referee, byProject]) => [referee, Object.fromEntries(byProject)])),
      crates: Object.fromEntries([...this.crates].map(([project, byManifest]) => [project, [...byManifest.values()]])),
      silent: Object.fromEntries([...this.silent].map(([referee, where]) => [referee, [...where]])),
    };
  }

  merge(data: TallyData): void {
    const projects = new Set([
      ...Object.values(data.questions).flatMap((byProject) => Object.keys(byProject)),
      ...Object.keys(data.crates),
      ...Object.values(data.silent).flat(),
    ]);
    for (const project of projects) {
      this.add(project, {
        nothingToAsk: false,
        questions: Object.fromEntries(Object.entries(data.questions)
          .filter(([, byProject]) => byProject[project]).map(([referee, byProject]) => [referee, byProject[project]!])),
        crates: data.crates[project] ?? [],
        silent: Object.entries(data.silent).filter(([, where]) => where.includes(project)).map(([referee]) => referee),
      });
    }
    // `add` counted one check per project; the data carries its own count.
    this.checks += data.checks - projects.size;
    this.nothingToAsk += data.nothingToAsk;
  }

  /** Totals for one compiler over the run, or for one project. */
  count(referee: string, project?: string): Count {
    const byProject = this.questions.get(referee);
    if (!byProject) return { asked: 0, answered: 0 };
    const rows = project === undefined ? [...byProject.values()] : [byProject.get(project) ?? { asked: 0, answered: 0 }];
    return rows.reduce((sum, row) => ({ asked: sum.asked + row.asked, answered: sum.answered + row.answered }), { asked: 0, answered: 0 });
  }

  /** The crates that had something to build, per project, or for one project. */
  cratesOf(project?: string): Array<CrateOutcome & { project: string }> {
    return [...this.crates]
      .filter(([name]) => project === undefined || name === project)
      .flatMap(([name, byManifest]) => [...byManifest.values()].map((crate) => ({ ...crate, project: name })))
      .filter((crate) => !crate.nothingToBuild);
  }

  /** The projects a compiler was asked in, and the ones where it answered nothing. */
  private projectsOf(referee: string): { asked: string[]; none: string[] } {
    const byProject = this.questions.get(referee) ?? new Map<string, Count>();
    const asked = [...byProject].filter(([, row]) => row.asked > 0).map(([project]) => project).sort();
    const none = [...byProject].filter(([, row]) => row.asked > 0 && row.answered === 0).map(([project]) => project).sort();
    return { asked, none };
  }

  /**
   * The header lines: per language, which compiler answered how many of the
   * questions it was asked, and for Rust which crates built. A compiler that
   * was never asked anything says so rather than being left out, because an
   * absent line and a compiler that was off look the same.
   */
  lines(languages: Iterable<string>): string[] {
    const wanted = new Set(languages);
    const out = ["compilers, as counted in this run's checks (not read from settings):"];
    for (const language of ["ts", "python", "rust"].filter((one) => wanted.has(one))) {
      const parts: string[] = [];
      const notes: string[] = [];
      for (const referee of REFEREES.filter((one) => LANGUAGE_OF[one] === language)) {
        const { asked, answered } = this.count(referee);
        const projects = this.projectsOf(referee);
        if (referee === "rustc") {
          const crates = this.cratesOf();
          const built = crates.filter((crate) => crate.built).length;
          parts.push(crates.length === 0
            ? `${NAME_OF[referee]} was never asked for a crate`
            : `${NAME_OF[referee]} built ${built} of ${crates.length} crates (${thousands(answered)} of ${thousands(asked)} files placed)`);
          for (const crate of crates.filter((one) => !one.built)) notes.push(`not built: ${crate.project} ${crate.manifest}: ${crate.why ?? "no reason recorded"}`);
          continue;
        }
        parts.push(asked === 0
          ? `${NAME_OF[referee]} was never asked`
          : `${NAME_OF[referee]} answered ${thousands(answered)} of ${thousands(asked)} questions in ${projects.asked.length} project${projects.asked.length === 1 ? "" : "s"}`);
        for (const project of projects.none) notes.push(`${NAME_OF[referee]} answered none in ${project} (asked ${this.count(referee, project).asked})`);
        const silentIn = [...(this.silent.get(referee) ?? [])].sort();
        if (silentIn.length > 0) notes.push(`${NAME_OF[referee]} did not start in ${silentIn.join(", ")}`);
      }
      out.push(`  ${language.padEnd(7)} ${parts.join("; ")}`);
      for (const note of notes) out.push(`          ${note}`);
    }
    return out;
  }

  /**
   * What makes the run NOT VALID: a compiler asked at least `MIN_ASKED`
   * questions in it that answered none, or a Rust compiler that built none
   * of the crates it was asked for. Each is one sentence naming the language,
   * empty when the run could check.
   */
  problems(languages: Iterable<string>, minAsked = MIN_ASKED): string[] {
    const wanted = new Set(languages);
    const out: string[] = [];
    for (const referee of REFEREES.filter((one) => wanted.has(LANGUAGE_OF[one]!))) {
      const language = LANGUAGE_OF[referee]!;
      if (referee === "rustc") {
        const crates = this.cratesOf();
        if (crates.length > 0 && crates.every((crate) => !crate.built)) {
          out.push(`${language}: ${NAME_OF[referee]} built none of the ${crates.length} crates it was asked for -- ${mostCommon(crates.map((crate) => crate.why ?? "no reason recorded"))}`);
        }
        continue;
      }
      const { asked, answered } = this.count(referee);
      if (asked >= minAsked && answered === 0) {
        const silentIn = this.silent.get(referee)?.size ?? 0;
        out.push(`${language}: ${NAME_OF[referee]} was asked ${thousands(asked)} questions and answered none`
          + (silentIn > 0 ? ` -- it did not start in ${silentIn} project${silentIn === 1 ? "" : "s"}` : ""));
      }
    }
    return out;
  }
}

export interface TallyData {
  checks: number;
  nothingToAsk: number;
  questions: Record<string, Record<string, Count>>;
  crates: Record<string, CrateOutcome[]>;
  silent: Record<string, string[]>;
}

function mostCommon(reasons: string[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const [reason, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  return n === reasons.length ? reason : `${reason} (${n} of ${reasons.length})`;
}

/*
 * ## Canaries
 */

/**
 * One arrow that is wrong on purpose and that only a compiler catches: it is
 * not red when the check runs with no compiler at all, and red when the
 * compiler answers. Named by the answer key's own claim id, so a key that
 * changes under it is noticed rather than skipped.
 */
export interface Canary {
  project: string;
  /** `KeyClaim.id` in that project's answer key. */
  claim: string;
  /** As the key writes it: `ts`, `tsx`, `python`, `rust`. */
  language: string;
  /** The compiler it needs, by the names a check reports: `typescript`, `python` (pyright), `rust` (rust-analyzer), `rustc`. */
  needs: string;
  /** For a person: the arrow, and what the compiler is needed for. */
  arrow: string;
}

/** The set's canaries, from `<bench dir>/canaries.json`; none when the set has no file. */
export function loadCanaries(repo: string, benchDir: string): Canary[] {
  const file = path.join(repo, benchDir, "canaries.json");
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")) as { canaries: Canary[] }).canaries;
}

export interface CanaryAnswer {
  canary: Canary;
  /** The bench's own outcome word, or `missing` when the key no longer has the claim. */
  outcome: string;
  detail: string;
}

export interface CanaryVerdict {
  /** Languages whose canaries did not all go red. A non-empty list stops the run. */
  failed: string[];
  /** For the header: one line per language, then one per canary that did not go red. */
  lines: string[];
}

/**
 * Every canary must come back red. One that does not fails its language, and
 * the line says the most likely reason, read from what the compilers did in
 * the canaries' own checks (`tally`).
 */
export function judgeCanaries(answers: readonly CanaryAnswer[], tally: CompilerTally): CanaryVerdict {
  const byLanguage = new Map<string, CanaryAnswer[]>();
  for (const answer of answers) {
    const language = languageGroup(answer.canary.language);
    byLanguage.set(language, [...(byLanguage.get(language) ?? []), answer]);
  }
  const failed: string[] = [];
  const lines: string[] = [];
  for (const [language, rows] of [...byLanguage].sort((a, b) => a[0].localeCompare(b[0]))) {
    const wrong = rows.filter((row) => row.outcome !== "red");
    if (wrong.length === 0) {
      lines.push(`${language.padEnd(7)} ${rows.length} of ${rows.length} canaries red`);
      continue;
    }
    failed.push(language);
    lines.push(`${language.padEnd(7)} COULD NOT CHECK: ${wrong.length} of ${rows.length} canaries did not go red`);
    for (const row of wrong) {
      lines.push(`          ${row.canary.project} · ${row.canary.arrow}: ${row.outcome} (${row.detail})`);
      lines.push(`            likely: ${likelyReason(row, tally)}`);
    }
  }
  return { failed, lines };
}

function likelyReason(answer: CanaryAnswer, tally: CompilerTally): string {
  const { canary } = answer;
  const name = NAME_OF[canary.needs] ?? canary.needs;
  if (answer.outcome === "missing") {
    return `the answer key no longer has claim ${canary.claim}; pick a new one (how: the "picked" note in the set's canaries.json)`;
  }
  if (canary.needs === "rustc") {
    const crates = tally.cratesOf(canary.project);
    const notBuilt = crates.filter((crate) => !crate.built);
    if (crates.length === 0) return `${name} was never asked for a crate in ${canary.project}`;
    if (notBuilt.length > 0) return `${name} could not build ${notBuilt.map((crate) => `${crate.manifest}: ${crate.why}`).join("; ")}`;
    return `${name} built every crate it was asked for, and the arrow still did not go red: the checker or the key changed; re-pick the canaries`;
  }
  const { asked, answered } = tally.count(canary.needs, canary.project);
  if (asked === 0) return `${name} was never asked a question in ${canary.project}`;
  if (answered === 0) {
    const hint = canary.needs === "python"
      ? " -- did it start? (npx fetches pyright the first time; is the project's venv installed: npm run bench:libraries)"
      : canary.needs === "rust" ? " -- is rust-analyzer installed (rustup component add rust-analyzer), and have the crate's dependencies been downloaded (cargo fetch)?" : "";
    return `${name} answered none of the ${asked} questions it was asked in ${canary.project}${hint}`;
  }
  return `${name} answered ${answered} of ${asked} questions in ${canary.project} and the arrow still did not go red: a library may be missing (npm run bench:libraries), or the checker or the key changed`;
}

/*
 * ## compiler-true
 */

export interface CompilerTrueProject {
  project: string;
  /** The pairs the compiler said are true, before any `--words` or shape filter. */
  pairs: number;
  /** Set when the referee that makes the pairs could not run, e.g. every crate failed to build. */
  couldNotRun?: string;
}

/**
 * A `compiler-true` run is a failure when it measured nothing: 0 pairs over
 * every project, or more than a quarter of its projects that crashed, had no
 * pairs, or whose referee could not run. One odd project out of five is
 * named and does not fail the run; two are a machine problem.
 */
export function judgeCompilerTrue(language: string, measured: readonly CompilerTrueProject[], crashed: readonly string[]):
  { valid: boolean; lines: string[] } {
  const total = measured.length + crashed.length;
  const pairs = measured.reduce((sum, one) => sum + one.pairs, 0);
  const nothing = measured.filter((one) => one.pairs === 0 || one.couldNotRun !== undefined);
  const bad = nothing.length + crashed.length;
  const lines: string[] = [];
  for (const one of nothing) {
    lines.push(`${one.project}: measured nothing -- ${one.couldNotRun ?? "the compiler gave 0 pairs"}`);
  }
  for (const one of crashed) lines.push(`${one}`);
  const valid = total > 0 && pairs > 0 && bad * 4 <= total;
  if (!valid) {
    lines.unshift(pairs === 0
      ? `NOT VALID: ${language} gave 0 pairs in ${total} project${total === 1 ? "" : "s"}, so nothing was checked. A 0-red result here means nothing.`
      : `NOT VALID: ${bad} of ${total} projects measured nothing, more than a quarter; the totals below are not the corpus.`);
  }
  return { valid, lines };
}
