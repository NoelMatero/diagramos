/**
 * Refs that point at line numbers instead of names (#286).
 *
 * Its own module, with no imports, because the board page counts these too and
 * cannot load the checker to find out.
 */

/**
 * `254`, `578-636`, `L578-L636`: a line or a range, the way search results,
 * stack traces and editors point at code (#286).
 *
 * Never a pointer. Lines move on any edit above them, which is why refs name
 * things. Every form but a bare `L254` contains a digit first or a separator,
 * and no identifier in TypeScript, Python or Rust can, so refusing those can
 * never refuse a real name. `L254` can be a name; `LONE_LINE` is the caller's
 * cue to look before refusing it.
 */
export const LINE_NUMBERS = /^L?\d+(?:\s*[-\u2013:]\s*L?\d+)?$/i;
export const LONE_LINE = /^L\d+$/i;
/** `src/lib.rs:254` -- the same thing after a colon, which reads as a file name otherwise. */
export const COLON_LINE = /^(.+?):(L?\d+(?:\s*[-\u2013:]\s*L?\d+)?)$/i;

/** Whether a finding is the line-number refusal, for a caller that words it differently. */
export function pointsAtLines(finding: { kind: string; ref: string }): boolean {
  if (finding.kind !== "unresolvable-ref") return false;
  const hash = finding.ref.indexOf("#");
  if (hash < 0) return COLON_LINE.test(finding.ref.trim());
  return LINE_NUMBERS.test(finding.ref.slice(hash + 1).split("@")[0].trim());
}
