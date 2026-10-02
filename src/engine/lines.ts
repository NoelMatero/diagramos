/**
 * Refs whose name is written in a shape the file never spells: line numbers
 * (#286), and a name qualified with its type or module (#288).
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

/**
 * `Server::accept`, `crate::net::accept`, `App.run`, `Server#accept`: a name
 * with its owner in
 * front (#288). A method sits inside its `impl` or `class`, so the file never
 * spells it that way and a mention check finds nothing. The last part is the
 * name the file does spell.
 */
const QUALIFIED = /^(?:[A-Za-z_$][\w$]*(?:::|\.|#))+([A-Za-z_$][\w$]*)$/;

/** The plain name inside a qualified one, or nothing when it is not qualified. */
export function plainNameOf(symbol: string): string | undefined {
  return QUALIFIED.exec(symbol.split("@")[0].trim())?.[1];
}

/**
 * A name as a board writes it, read as the name the code declares (#382, #385).
 *
 * The one place a board's text becomes a name to look for: `parseRef` reads
 * every ref's symbol through it, so every box and both ends of every word's
 * arrow do; `handles` reads a box's case list through it; `@accesses` reads
 * the member on its label through it. `Money::new`, `Self::Get`, `Kind.A`,
 * `Store.save` are how each language spells the thing, and they mean `new`,
 * `Get`, `A`, `save` -- the plain spelling, which is what every reader looks
 * up.
 *
 * Before this, each reader matched the text as written. Nothing in a file is
 * declared as `Money::new`, so the match failed and the arrow or the box was
 * judged anyway.
 *
 * `owner` is the part just before the name, kept so a caller holding the file
 * can tell a real owner from a typo (`ownerIsHere`). An assertion suffix stays
 * on the name: `Money::new@declared` is `new@declared`.
 */
export function writtenName(written: string): { name: string; owner?: string } {
  const at = written.indexOf("@");
  const head = (at < 0 ? written : written.slice(0, at)).trim();
  const match = QUALIFIED.exec(head);
  if (!match) return { name: written };
  const owner = head.slice(0, head.length - match[1].length).replace(/(?:::|\.|#)$/, "").split(/::|\.|#/).pop()!;
  return { name: match[1] + (at < 0 ? "" : written.slice(at)), owner };
}

/**
 * Whether the owner a name was written with is something this file has.
 *
 * `Self` and the path words always are. Otherwise the file mentions it, or is
 * the module it names (`net.rs` for `crate::net::accept`). An owner the file
 * never mentions is a typo or the wrong file, and taking the name alone would
 * confirm `Wallet::new` off `Money::new`.
 */
export function ownerIsHere(owner: string, file: string, source: string): boolean {
  if (OWNER_WORDS.has(owner)) return true;
  const stem = file.replace(/\\/g, "/").split("/").pop()!.replace(/\.[^.]*$/, "");
  if (owner === stem) return true;
  return new RegExp(`(?<![\\w$])${owner.replace(/\$/g, "\\$")}(?![\\w$])`).test(source);
}

const OWNER_WORDS = new Set(["Self", "self", "crate", "super", "this", "cls"]);

/**
 * Whether a finding is the qualified-name refusal. Since #382 that is only an
 * owner the file does not have: a qualified name whose owner is there resolves.
 */
export function pointsAtQualified(finding: { kind: string; ref: string }): boolean {
  if (finding.kind !== "unresolvable-ref") return false;
  const hash = finding.ref.indexOf("#");
  return hash >= 0 && plainNameOf(finding.ref.slice(hash + 1)) !== undefined;
}
