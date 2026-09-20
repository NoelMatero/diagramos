/**
 * The referee `checkDrift` can build for itself (#328).
 *
 * `@calls` may call an arrow wrong only when it enumerated the routine's whole
 * call set and resolved every one of them (#231, #233). A call written
 * `thing.render()` resolves only if something can say what `thing` is, and the
 * reader alone cannot: that answer needs a type checker. Handed one, a call it
 * had to give up on becomes a call it can place -- which is the difference
 * between a wrong arrow caught and a wrong arrow passed over in silence.
 *
 * ## Why this file exists at all
 *
 * The checker half has been built, tested and measured since #226. It lived in
 * `scripts/`, and only `scripts/check-drift.mjs` ever assembled it. So the CLI
 * got the strong check and **the MCP server -- the thing that actually runs
 * when Claude draws a board, and the thing every `check_drift` call goes
 * through -- got the weak one**, as did `bench:planted`, which meant every
 * score this project has ever quoted was the weak check's score.
 *
 * Measured on TypeScript boards, wiring in the in-process resolver and changing
 * nothing else took `bench:planted` from 30 to 40 wrong arrows caught out of
 * 121, and resolved all 29 "the text does not give this value's type" refusals
 * into something else.
 *
 * ## TypeScript only, and why that is not a stopgap
 *
 * Python's and Rust's resolvers answer over a language server. Both need a
 * harvesting round -- collect every question, start the server, wait for it to
 * index the tree, ask in a batch -- which is seconds to minutes on a real
 * repository. That is affordable for a measurement and for the CLI, which the
 * reader invoked and is waiting on; it is not affordable at draw time, where a
 * diagram tool that stalls for a minute after every edit is a diagram tool
 * nobody leaves on. The TypeScript compiler is the one of the three that
 * answers in process and synchronously, so it is the one that can run here.
 *
 * A board is never left to imply it got the stronger check: a Python or Rust
 * call this cannot place stays exactly the `receiver` refusal it already was,
 * and #324's reason word says so on the arrow itself.
 */
import { languageOf } from "./parse";
import { createTsReferee, isOutsideTree, receiverResolutionFrom, type TsReferee } from "./referee-ts";
import type { ClosedBodyReferee } from "./drift";
import type { ReceiverResolution } from "./calls";
import path from "node:path";

/** A position in a file, as the reader recorded it. */
type At = { start: number; end: number };

/**
 * Answers a caller already harvested for one language, handed in rather than
 * asked for.
 *
 * Python's and Rust's resolvers speak to a language server and need every
 * question collected before the first one is asked, so only a caller that can
 * afford that round -- `check-drift.mjs`, which the reader invoked and is
 * waiting on -- has them. Passing them in here rather than keeping a second
 * copy of the routing over there is the point: which language reaches which
 * resolver is one decision, made once, in this file.
 */
export interface HarvestedAnswers {
  resolveReceiver?(file: string, at: At): ReceiverResolution | undefined;
  declarationAt?(file: string, at: At): { file: string; line: number } | "outside" | undefined;
}

/**
 * One referee per tree, kept for the life of the process.
 *
 * The MCP server checks the same repository over and over -- once per draw,
 * once per edit, once per explicit check -- and building a `ts.Program` is the
 * expensive part. #234 already made the referee re-verify its cached programs
 * against every source file's `mtime` before trusting one, so holding it across
 * edits answers from current text rather than from the text at startup; that
 * note ends by naming this exact caller as the reason to revisit it, and this
 * is that revisit.
 *
 * Keyed by resolved root, so a server serving two repositories keeps their
 * compilers apart. `null` remembers "asked, and this tree has no compiler", so
 * a repository without TypeScript installed pays the failed load once.
 */
const byRoot = new Map<string, TsReferee | null>();

function refereeFor(root: string): TsReferee | undefined {
  const key = path.resolve(root);
  if (!byRoot.has(key)) byRoot.set(key, createTsReferee(key) ?? null);
  return byRoot.get(key) ?? undefined;
}

/**
 * A referee for `checkDrift` over this tree.
 *
 * Cheap to call, and deliberately so: nothing is loaded and no tree is walked
 * until the first question arrives, so a board with no TypeScript call arrow on
 * it never pays for a compiler it does not use, and a server in a repository
 * with no TypeScript at all never loads one. That is what makes it safe to
 * hand to every `checkDrift` call including the two at draw time.
 *
 * Always an object, never `undefined`: a tree with no compiler answers
 * `undefined` to every question, which is the state `checkDrift` has always
 * handled and exactly what it did before this was wired in.
 */
export function createClosedBodyReferee(
  root: string,
  harvested?: Partial<Record<"python" | "rust", HarvestedAnswers>>,
): ClosedBodyReferee {
  const tree = path.resolve(root);

  /*
   * Deliberately not `refereeFor(tree)` here: that would build the referee at
   * assembly time, on every draw, whether or not a single arrow needs it. The
   * question this file answers is asked lazily, so the cost is paid lazily.
   */
  const typescriptOnly = <T>(file: string, ask: (referee: TsReferee) => T): T | undefined => {
    /*
     * By exclusion, the way `check-drift.mjs` routes: `.js`, `.jsx` and `.mjs`
     * belong here too. The program is built with `allowJs`, so the compiler
     * has a real opinion about a receiver in a JavaScript file -- inferred
     * from JSDoc and from the declarations it can see -- and refusing to ask
     * would throw that away for no reason.
     */
    const language = languageOf(file);
    if (language === undefined || language === "python" || language === "rust") return undefined;
    const referee = refereeFor(tree);
    return referee ? ask(referee) : undefined;
  };

  /** Whichever harvested set covers this file's language, if the caller brought one. */
  const handedIn = (file: string): HarvestedAnswers | undefined => {
    const language = languageOf(file);
    return language === "python" || language === "rust" ? harvested?.[language] : undefined;
  };

  return {
    resolveReceiver: (file, at) => handedIn(file)?.resolveReceiver?.(file, at)
      ?? typescriptOnly(file, (referee) =>
        receiverResolutionFrom(referee.typeAt(path.resolve(tree, file), at.start, at.end), tree)),

    /*
     * "Go to definition" at a call's own name, for `@accesses`' helper rule
     * (#255). Same referee, same tree, and the engine wants a repo-relative
     * path and a 1-based line -- the compiler answers absolute and 0-based.
     */
    declarationAt: (file, at) => handedIn(file)?.declarationAt?.(file, at)
      ?? typescriptOnly(file, (referee) => {
      const found = referee.symbolDeclarationLocationAt(path.resolve(tree, file), at.start, at.end);
      if (!found) return undefined;
      if (isOutsideTree(found.file, tree)) return "outside" as const;
      return { file: path.relative(tree, found.file), line: found.line + 1 };
    }),
  };
}
