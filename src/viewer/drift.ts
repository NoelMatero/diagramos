/**
 * The drift report, shaped for the page.
 *
 * The engine's report already says everything; what the panel needs is the
 * same selection the CLI notice makes -- rows a person can read, a tally a
 * person can glance at -- with one addition the CLI cannot have: every row
 * that still exists on the canvas carries its node id, so clicking it can
 * reveal the box it is about.
 *
 * Pure functions, kept out of App.tsx so they are testable without a browser.
 */

export type Tone = "bad" | "warn" | "good" | "dim";

/**
 * The subset of the engine's DriftReport the panel reads. Structural on
 * purpose: a real report satisfies it, and the page stays honest about how
 * little of the payload it depends on.
 */
export interface DriftView {
  clean: boolean;
  findings: Array<{ node: string; label: string; ref: string; kind: string }>;
  edges: Array<{ from: string; to: string; fromLabel: string; toLabel: string; node: string }>;
  deleted: Array<{ node: string; label: string; ref: string }>;
  deletedEdges?: Array<{ fromLabel: string; toLabel: string }>;
  /** Claim words the vocabulary does not have. Optional: older payloads have none. */
  garbledClaims?: Array<{ on: string; label: string; written: string }>;
  workItems: Array<{ node: string; label: string; ref?: string }>;
  promotions: Array<{ node: string; label: string }>;
  checked: number;
  skipped: number;
  edgesChecked: number;
  strayArrows?: number;
  concept: boolean;
}

export interface TallyPart {
  text: string;
  tone: Tone;
}

export interface StatusRow {
  text: string;
  tone: Tone;
  /** Node id to reveal on the canvas. Absent when the element is gone. */
  node?: string;
}

const name = (label: string, node: string) => (label || node).replace(/\s+/g, " ");

/** The chip's counts: the same parts as the CLI notice's tally, same words. */
export function tallyOf(report: DriftView): TallyPart[] {
  const kind = (wanted: string) => report.findings.filter((finding) => finding.kind === wanted).length;
  const empty = kind("empty-ref");
  const unused = kind("unused-symbol");
  const gone = report.findings.length - empty - unused;
  const parts: TallyPart[] = [];
  if (gone) parts.push({ text: `${gone} gone`, tone: "bad" });
  if (empty) parts.push({ text: `${empty} empty`, tone: "bad" });
  if (unused) parts.push({ text: `${unused} unused`, tone: "bad" });
  if (report.deleted.length) parts.push({ text: `${report.deleted.length} removed`, tone: "bad" });
  if (report.garbledClaims?.length) {
    parts.push({ text: `${report.garbledClaims.length} unreadable`, tone: "bad" });
  }
  if (report.edges.length) {
    parts.push({
      text: `${report.edges.length} ${report.edges.length === 1 ? "arrow" : "arrows"}`,
      tone: "warn",
    });
  }
  if (report.strayArrows) {
    parts.push({
      text: `${report.strayArrows} stray ${report.strayArrows === 1 ? "arrow" : "arrows"}`,
      tone: "dim",
    });
  }
  if (report.promotions.length) parts.push({ text: `${report.promotions.length} built`, tone: "good" });
  if (report.workItems.length) parts.push({ text: `${report.workItems.length} planned`, tone: "dim" });
  return parts;
}

/** One row per finding, the CLI's long form, with a node id where one still exists. */
export function rowsOf(report: DriftView): StatusRow[] {
  return [
    // A word the check cannot read comes first: everything below it is the board
    // and the code disagreeing, which is a smaller problem than a claim nothing
    // can ever evaluate.
    ...(report.garbledClaims ?? []).map((finding) => ({
      text: `${finding.on === "arrow" ? "arrow " : ""}${name(finding.label, finding.label)} · @${finding.written} is not a claim`,
      tone: "bad" as Tone,
    })),
    // The element is gone from the board, so there is nothing to reveal.
    ...report.deleted.map((finding) => ({
      text: `${name(finding.label, finding.node)} removed · ${finding.ref} still there`,
      tone: "bad" as Tone,
    })),
    ...report.findings.map((finding) => ({
      text: `${name(finding.label, finding.node)} → ${finding.ref}`,
      tone: "bad" as Tone,
      node: finding.node,
    })),
    ...report.edges.map((finding) => ({
      text: `${name(finding.fromLabel, finding.from)} → ${name(finding.toLabel, finding.to)}`,
      tone: "warn" as Tone,
      // The finding's own from/to are file paths (the evidence); `node` is the
      // arrow in node ids, which is what the canvas can reveal.
      node: finding.node,
    })),
    // Deleted edges: quiet notes about arrows that were removed but the code still supports
    ...(report.deletedEdges ?? []).map((finding) => ({
      text: `arrow ${name(finding.fromLabel, finding.fromLabel)} → ${name(finding.toLabel, finding.toLabel)} deleted — the code still connects them`,
      tone: "dim" as Tone,
    })),
    ...report.promotions.map((promotion) => ({
      text: `${name(promotion.label, promotion.node)} is built now`,
      tone: "good" as Tone,
      node: promotion.node,
    })),
    ...report.workItems.map((item) => ({
      text: `${name(item.label, item.node)} not built yet`,
      tone: "dim" as Tone,
      node: item.node,
    })),
  ];
}

/** The dot's colour: the worst news wins, and quiet is green. */
export function worstToneOf(rows: StatusRow[]): Tone {
  if (rows.some((row) => row.tone === "bad")) return "bad";
  if (rows.some((row) => row.tone === "warn")) return "warn";
  return "good";
}

/**
 * The clean chip's words: what was read, so "in sync" cannot mean "unread".
 * In sentences, not tallies -- "4 refs · 3 arrows checked" needed the reader
 * to already know what a ref is, which is the one thing a status line that
 * only appears when everything is fine cannot assume.
 */
export function summaryOf(report: DriftView): string {
  if (report.concept) {
    return "a concept board — it describes something outside this repo, so nothing here is checked";
  }
  if (!report.checked && !report.edgesChecked) {
    return "nothing on this board points at code yet, so nothing was checked";
  }
  const boxes = `${report.checked} ${report.checked === 1 ? "box" : "boxes"}`;
  const arrows = `${report.edgesChecked} ${report.edgesChecked === 1 ? "arrow" : "arrows"}`;
  const unread = report.skipped
    ? ` — ${report.skipped} more ${report.skipped === 1 ? "box has no ref, so it" : "boxes have no ref, so they"} went unchecked`
    : "";
  return `checked ${boxes} and ${arrows} against the code — all still true${unread}`;
}
