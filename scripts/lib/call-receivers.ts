/**
 * The second referee for `measure:calls` (#254): a real checker, for the calls
 * the text scan cannot place.
 *
 * `call-scan.ts` finds `x.foo(..)` and stops there -- which `foo` is meant is a
 * question about what `x` is, and a text scan has no answer. So those calls
 * were counted apart and kept out of the number `@calls`' licence rests on,
 * and they are not a random sample: they are the method calls, the hard half.
 *
 * `tsc`, pyright and rust-analyzer each answer "go to definition" at `foo`'s
 * own position, which is exactly the missing question. None of them shares
 * anything with the reader being judged: `callsBetween` places a name with
 * tree-sitter and its own bindings, and never consults a resolver on the path
 * that confirms or accuses (`calls.ts`, `placeOf`'s doc).
 */

import ts from "typescript";

import { type Language } from "../../src/engine/parse";

import { PYRIGHT_VERSION } from "./licence-python";
import { createPyrightLspReferee } from "./resolution-python-lsp";
import { createRustAnalyzerReferee } from "./resolution-rust-lsp";
import { createTsReferee } from "./resolution-ts";

/** Where a call's name is written, as a byte range into the file. */
export interface NameRange { start: number; end: number }

const escape = (name: string) => name.replace(/[$]/g, "\\$");

/**
 * One line with its strings and comments blanked, length kept, so an offset
 * found in it is an offset into the real line. The same forms `stripNoise`
 * blanks, minus the ones that span lines: the text scan already saw a call on
 * this line, so it is code.
 */
function codeOf(line: string, language: Language): string {
  const blank = (text: string) => " ".repeat(text.length);
  // Rust's single quote is left alone, as `stripNoise` leaves it: `&'a str` is a
  // lifetime, and reading it as a character literal eats the rest of the line.
  const strings = language === "python"
    ? /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g
    : language === "rust"
      ? /"(?:[^"\\]|\\.)*"/g
      : /`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  const quoted = line.replace(strings, blank);
  const comment = language === "python" ? /#.*$/ : /\/\/.*$/;
  return quoted.replace(comment, blank);
}

/**
 * Every place on `line` (1-based) where `name` is called the way the text scan
 * said it was: on a receiver (`x.foo(`, `x?.foo(`, `Type::foo(`) or bare.
 *
 * The scan records a name and a line, not a column, and a checker needs a
 * position. More than one hit is normal -- `a.foo(b.foo())` -- and each is
 * asked.
 */
export function callSitesOn(
  source: string, line: number, name: string, via: "bare" | "receiver", language: Language,
): NameRange[] {
  const lines = source.split("\n");
  const text = lines[line - 1];
  if (text === undefined) return [];
  let lineStart = 0;
  for (let i = 0; i < line - 1; i++) lineStart += lines[i]!.length + 1;

  const code = codeOf(text, language);
  const pattern = via === "receiver"
    ? new RegExp(`(?<=(?:\\.|::)\\s*)${escape(name)}(?=\\s*\\()`, "g")
    : new RegExp(`(?<![\\w$])(?<!(?:\\.|::)\\s*)${escape(name)}(?=\\s*\\()`, "g");
  return [...code.matchAll(pattern)].map((hit) => ({
    start: lineStart + hit.index,
    end: lineStart + hit.index + name.length,
  }));
}

/** A declaration a checker pointed at: absolute file, 0-based line. */
export interface Declared { file: string; line: number }

/** What the checker said about every site of one call, taken together. */
export type Landing =
  | { kind: "lands" }
  | { kind: "elsewhere"; at: Declared }
  | { kind: "silent"; why: "no-site" | "checker-silent" | "partly-silent" | "no-checker" };

/**
 * The call is to the routine the scan meant when the checker names a line in
 * that file that declares the name. One site landing is enough -- a routine
 * that calls `foo` once through the right receiver calls it, whatever else it
 * does.
 *
 * `elsewhere` needs **every** site answered. A site the checker could not
 * place might be the real call, and calling the rest "elsewhere" would turn a
 * confirmation the reader got right into an invention.
 */
export function landingOf(
  answers: Array<Declared | undefined>,
  target: string,
  name: string,
  lineOf: (file: string, line: number) => string | undefined,
): Landing {
  if (answers.length === 0) return { kind: "silent", why: "no-site" };
  const declares = new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`);
  let elsewhere: Declared | undefined;
  let unanswered = 0;
  for (const answer of answers) {
    if (!answer) { unanswered += 1; continue; }
    if (answer.file === target && declares.test(lineOf(answer.file, answer.line) ?? "")) return { kind: "lands" };
    elsewhere ??= answer;
  }
  if (!elsewhere) return { kind: "silent", why: "checker-silent" };
  if (unanswered > 0) return { kind: "silent", why: "partly-silent" };
  return { kind: "elsewhere", at: elsewhere };
}

export type ReceiverScore =
  | "agreed" | "refused" | "missed" | "accused"
  | "invented" | "rightly-unconfirmed" | "backwards-elsewhere";

/**
 * A real call is scored exactly as `measure:calls` scores a bare one. A call
 * the checker places somewhere else has one wrong answer, confirming it.
 *
 * `backwards` on a call that goes elsewhere is kept apart rather than scored:
 * the checker settled that this site is not a call to the target, which makes
 * the forward half of `backwards` right, and says nothing about the reverse
 * call the reader found.
 */
export function scoreReceiverCall(
  landing: Exclude<Landing, { kind: "silent" }>,
  verdict: "confirmed" | "withheld" | "absent" | "backwards" | "refuted",
): ReceiverScore {
  if (landing.kind === "lands") {
    if (verdict === "confirmed") return "agreed";
    if (verdict === "withheld") return "refused";
    if (verdict === "backwards") return "accused";
    return "missed";
  }
  if (verdict === "confirmed") return "invented";
  if (verdict === "backwards") return "backwards-elsewhere";
  return "rightly-unconfirmed";
}

/** "Go to definition" at a call's name, from whichever checker the language has. */
export interface CallChecker {
  definitionAt(file: string, source: string, at: NameRange): Promise<Declared | undefined>;
  close(): void;
  /** Which checker, at which version -- recorded beside the number it produced. */
  label: string;
}

const TYPESCRIPT = new Set<Language>(["ts", "tsx", "js"]);

/**
 * The checker for one language in one tree, or why there is none -- which the
 * measurement prints as the reason those calls stayed out, rather than
 * shrinking its population without saying so.
 *
 * TypeScript's is the compiler in process. Python's and Rust's are language
 * servers, warmed once before the first answer is trusted, for the reasons
 * their own clients document.
 */
export async function checkerFor(
  tree: string, language: Language,
): Promise<CallChecker | { unavailable: string }> {
  const why = (error: unknown) => (error instanceof Error ? error.message : String(error));
  if (TYPESCRIPT.has(language)) {
    try {
      const referee = createTsReferee(tree);
      return {
        definitionAt: async (file, _source, at) => referee.symbolDeclarationLocationAt(file, at.start, at.end),
        close: () => {},
        label: `tsc ${ts.version}`,
      };
    } catch (error) {
      return { unavailable: `tsc could not build this tree: ${why(error)}` };
    }
  }
  if (language === "python") {
    try {
      const referee = await createPyrightLspReferee(tree);
      let warmed: Promise<void> | undefined;
      return {
        definitionAt: async (file, source, at) => {
          warmed ??= referee.warmUp(file, source, at.start);
          await warmed;
          return referee.methodDeclarationLocationAt(file, source, at.start, at.end);
        },
        close: () => referee.close(),
        label: `pyright ${PYRIGHT_VERSION}`,
      };
    } catch (error) {
      return { unavailable: `pyright did not start: ${why(error)}` };
    }
  }
  if (language === "rust") {
    try {
      const referee = await createRustAnalyzerReferee(tree);
      await referee.warmUp();
      return {
        definitionAt: (file, source, at) => referee.methodDeclarationLocationAt(file, source, at.start, at.end),
        close: () => referee.close(),
        label: `rust-analyzer ${referee.version()}`,
      };
    } catch (error) {
      return { unavailable: `rust-analyzer did not start: ${why(error)}` };
    }
  }
  return { unavailable: `no checker for ${language}` };
}
