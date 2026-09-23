/**
 * Whether a `needs` arrow points the way the code does.
 *
 * This is the first verdict in the tool that can say **wrong**. Everything else
 * either confirms or goes quiet, because "related somehow" has no opposite: fail
 * to find a connection and you have learned nothing, so the answer is amber
 * forever and a backwards arrow survives every check ever written.
 *
 * `needs` has an opposite. The tail declares a dependency on the head, which is
 * a direction, so finding the dependency pointing the other way *and nowhere
 * else* is proof the arrow is drawn backwards. That is the one thing here worth
 * having, and the one thing that can cost trust if it is ever wrong.
 *
 * So the whole file is written as reasons not to answer -- but the reasons are
 * not all reasons to refuse the same question, and #308 is what it cost to run
 * them together. **Confirming and accusing rest on opposite evidence.**
 *
 * Confirming is *presence*: the import is written in the tail, we found it, and
 * what else that file does elsewhere cannot unwrite it. Two gates only, and both
 * are about whether the text is ours to read at all:
 *
 * - both files in a language whose reader has been **measured** (`licence.ts`);
 * - both files **vouched for** by a source index (`ledger.ts`), so the text we
 *   read is text some other tool also thinks is source of this repository, and
 *   not a generated bundle or a script hidden away in a dotted directory.
 *
 * Accusing is *absence*: "the dependency is not in the tail, and it is in the
 * head". That is a statement about a whole file, so it needs the whole file:
 *
 * - both files **parsed to the end**, because a recovered parse read less than
 *   one, and nothing can be proved absent in what we did not read;
 * - neither file **able to load a file at runtime** -- `import()`, `eval`, a
 *   Rust item macro -- where no reader can follow, so "it declares nothing on
 *   it" is not a fact about the file. A `table[name]()` is not one of those:
 *   it calls what the file already imported (#344).
 *
 * Running those four together refused 19.8% of true imports in #302's corpus --
 * `flask/__init__.py` imports `app.py` in plain sight, and the answer was
 * withheld because `app.py` writes one `table[name]()` somewhere else in the
 * file. A cycle was refused for the same kind of reason: both files import each
 * other, so neither *accusation* is available, but the arrow that was drawn is
 * still an import somebody can point at.
 *
 * Miss a gate that the question at hand actually needs and this returns
 * `withheld` with the reason, and the caller falls back to the amber it would
 * have shown anyway. Silence is always available and always safe; the accusation
 * is not.
 */
import { mayHideAnImport, readDependencies, readerCanPlace } from "./deps";
import { vouchedFor, type Ledger } from "./ledger";
import { licenceFor, mayAccuse } from "./licence";
import { languageOf } from "./parse";
import { declaredNames } from "./parts";
import type { ConfigCache } from "./resolve";
import type { Workspace } from "./workspace";

/** Why no direction verdict was reached. Each one is a reason to stay quiet. */
export type NeedsWithheld =
  /** No measured reader for one of these languages, so no right to refute. */
  | "unlicensed"
  /** One end could not be read at all -- missing, or a language with no grammar. */
  | "unreadable"
  /** No source index has ever read one end, so it may not be source at all. */
  | "unvouched"
  /** A parse recovered from an error, so nothing can be proved absent in it. */
  | "incomplete"
  /** One end reaches out at runtime; the text is not the whole story. */
  | "dynamic"
  /** Both ends are the same file, which cannot depend on itself in any useful sense. */
  | "same-file";

/** Where a dependency was declared, for a report that has to name its evidence. */
export interface NeedsEvidence {
  /** The file doing the depending. */
  file: string;
  /** The file depended on. */
  on: string;
  /** The specifier as written, so the report can quote it. */
  specifier: string;
  /** 1-based. */
  line: number;
  /**
   * True when the import took whatever that file exports rather than named
   * things (`from x import *`, `export * from`, `use x::*`). Read when a name
   * is followed through a module that hands it on (#323).
   */
  star?: boolean;
  /** The names it asked that file for, where the language writes them (#323). */
  names?: readonly string[];
}

export type NeedsVerdict =
  /** The dependency runs the way the arrow does. */
  | { verdict: "confirmed"; evidence: NeedsEvidence }
  /** It runs the other way, and only the other way. The arrow is backwards. */
  | { verdict: "backwards"; evidence: NeedsEvidence }
  /**
   * The tail does not import the head, and does reach it through other files
   * (#323). Not wrong: `app -> database` drawn over three files in between is
   * a reading of the architecture, and 26 of the 243 file pairs Haiku drew on
   * `bench:planted` are that shape. `via` is the files between, in order.
   */
  | { verdict: "indirect"; via: string[]; evidence: NeedsEvidence; mayAccuse: boolean }
  /**
   * The tail does not import the head and nothing it imports leads there,
   * followed to the end through files that could all be read (#323). The
   * accusation on an absence, and licensed per language on that axis.
   */
  | { verdict: "refuted" }
  /** Neither file declares the other, and no accusation was available. Amber. */
  | { verdict: "absent" }
  | { verdict: "withheld"; why: NeedsWithheld };

/**
 * What one file declares about another, and what its silence is worth.
 *
 * The two fields answer the two different questions this file asks, and keeping
 * them apart is the whole of #308:
 *
 * - `on` is what we found written. Every entry is a dependency somebody can open
 *   the file and point at, so it is evidence enough to **confirm** on its own.
 * - `blind` is set when *not* finding something here means nothing. That refuses
 *   the **accusation** and leaves the confirmation alone, which is the right way
 *   round: a file that calls `table[name]()` in its tail has not thereby stopped
 *   importing what it imports at the top.
 *
 * `refused` is the harder version of the same thing: no list was read at all, so
 * there is nothing to confirm on either, and the question ends there.
 */
interface Declared {
  /** Every repo file this one declares a dependency on. Empty when `refused`. */
  on: Map<string, NeedsEvidence>;
  /** No list was read at all: neither verdict is available. */
  refused?: NeedsWithheld;
  /** A list was read and may be short, so absence in it proves nothing. */
  blind?: NeedsWithheld;
}

/** What one file declares about another, and whether it can be trusted to. */
function declares(
  file: string,
  workspace: Workspace,
  cache: ConfigCache,
  ledger?: Ledger,
): Declared {
  if (!licenceFor(file)) return { on: new Map(), refused: "unlicensed" };

  const absolute = workspace.resolve(file);
  if (!absolute || workspace.stat(absolute) !== "file") {
    return { on: new Map(), refused: "unreadable" };
  }

  /*
   * Checked before the parse, and after the stat, so a file that is simply gone
   * is told that rather than this. The order costs one directory lookup and buys
   * the more useful sentence.
   */
  if (!vouchedFor(ledger, file)) return { on: new Map(), refused: "unvouched" };

  const read = readDependencies(file, workspace.read(absolute), workspace, cache);
  if (!read) return { on: new Map(), refused: "unreadable" };

  const on = new Map<string, NeedsEvidence>();
  for (const dependency of read.dependencies) {
    if (!dependency.file) continue;
    // First mention wins: a file importing the same module twice should quote the
    // line somebody would look at first.
    if (!on.has(dependency.file)) {
      on.set(dependency.file, {
        file,
        on: dependency.file,
        specifier: dependency.specifier,
        line: dependency.line,
      });
    }
  }

  /*
   * Order matters here, and it is the pessimistic one: a file that is both
   * incompletely read and dynamic reports as incomplete, because that is the
   * more fundamental problem. Either way the caller says nothing about absence,
   * so the only thing at stake is which reason a person is told, and "we could
   * not read all of this" is the more useful one to hear first.
   *
   * An incomplete parse leaves the list standing rather than dropping it, and
   * that is deliberate: recovery is local, so an `import` the grammar did read
   * is still an `import` in the text. What it cannot support is the sentence
   * "and there is no other one anywhere in here".
   */
  /*
   * A Rust file no crate declares reads as a file that imports nothing, since
   * `mod` and `crate::` have no root to resolve against. That is the reader's
   * blindness, not an absence, and since #323 an absence is an accusation.
   */
  if (!readerCanPlace(file, workspace, cache)) return { on, blind: "unreadable" };
  if (!read.complete) return { on, blind: "incomplete" };
  /*
   * Only the escapes that can bring in a file the text never names (#344). A
   * `table[name]()` calls something already imported, so "and it imports
   * nothing else" is as true with one as without.
   */
  if (mayHideAnImport(read.dynamic)) return { on, blind: "dynamic" };
  return { on };
}

/**
 * Which way the dependency between two files actually runs.
 *
 * `from` and `to` are repo-relative and read as the arrow does: `from` claims to
 * depend on `to`.
 */
export function checkNeeds(
  from: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache = new Map(),
  ledger?: Ledger,
): NeedsVerdict {
  if (from === to) return { verdict: "withheld", why: "same-file" };

  const tail = declares(from, workspace, cache, ledger);
  if (tail.refused) return { verdict: "withheld", why: tail.refused };
  const head = declares(to, workspace, cache, ledger);
  if (head.refused) return { verdict: "withheld", why: head.refused };

  /*
   * The confirmation, and it is the whole of the evidence it needs.
   *
   * The tail declares the head. That is the arrow, written down, in a file a
   * licence covers and a source index vouches for. Nothing the rest of either
   * file does can make that import not be there -- not a computed call further
   * down, not a torn parse in another function, and not the head importing the
   * tail back. So this is asked before any of them, and the cycle that used to
   * be refused here confirms: both arrows in a mutual import are true, and
   * being unable to pick between two accusations was never a reason to decline
   * the one fact on the board.
   */
  const forward = tail.on.get(to) ?? reexported(from, to, workspace, cache, ledger);
  if (forward) return { verdict: "confirmed", evidence: forward };

  /*
   * Past here everything rests on an *absence* -- either "nothing connects
   * these", or the accusation, which is "not in the tail, and in the head". A
   * file we could not read to the end cannot support a sentence about the whole
   * of it, so the gates that were skipped above are the gates now.
   */
  if (tail.blind) return { verdict: "withheld", why: tail.blind };
  if (head.blind) return { verdict: "withheld", why: head.blind };

  /*
   * The accusation, and the last gate before it. `declares` has already refused
   * both files unless a licence names their extensions, so this is true
   * wherever we get to it today -- it is asked anyway because the question it
   * asks is the right one: not "is this language licensed" but "was *this*
   * word's reader measured here" (#207). Both files, because saying backwards
   * rests on finding the import in `to` and on not finding it in `from`.
   */
  const backward = head.on.get(from);
  const bothMeasured = [from, to].every((file) => {
    const language = languageOf(file);
    return language !== undefined && mayAccuse("needs", language);
  });
  if (backward && bothMeasured) return { verdict: "backwards", evidence: backward };
  if (backward) return { verdict: "absent" };

  /*
   * Nothing either way, and until #323 that was the end: amber, on the footing
   * that an absence proves nothing. #308 made the reader find 99.8% of real
   * imports, so an absence now does prove something -- about the *direct*
   * import. It proves nothing about the arrow, because people draw
   * `app -> database` meaning "depends on" with files in between, and are not
   * wrong. So the chain is ruled out before the accusation is made, the way
   * `calls` rules out a call two hops away.
   */
  const licensed = (axis: "absence" | "indirect") => [from, to].every((file) => {
    const language = languageOf(file);
    return language !== undefined && mayAccuse("needs", language, axis);
  });
  const walk = walkImports(from, to, workspace, cache, ledger);
  if (walk.reached) {
    /*
     * Whether an `@needs` arrow over this chain may be called wrong, which is
     * a per-language measurement and not a rule (#323). Rust and TypeScript
     * leave no true import reachable only through another file; Python leaves
     * six, so there the chain is reported and never accused. `@depends` never
     * reads this: the chain is what that word claims.
     */
    return {
      verdict: "indirect",
      via: walk.reached.via,
      evidence: walk.reached.first,
      mayAccuse: licensed("indirect"),
    };
  }
  const bothLicensed = licensed("absence");
  if (walk.blind || !bothLicensed) return { verdict: "absent" };
  return { verdict: "refuted" };
}

/**
 * The files an import leads to, one per import rather than one per module on
 * the way there.
 *
 * Rust reads `use crate::parser::ArgMatcher` as a dependency on `lib.rs`, on
 * `parser/mod.rs` and on nothing past them, because every module a path passes
 * through is somewhere the name could have come from. That is right for
 * confirming an arrow onto `parser/mod.rs` and wrong for walking: `lib.rs`
 * declares every module in the crate, so a walk through it reaches everything
 * and no Rust arrow could ever be unreached. The walk takes the last file each
 * written import landed on, and drops a bare `crate`/`self`/`super`, which is
 * a path's first segment or a `pub(crate)` read as one (#319), never an import.
 */
function landings(read: NonNullable<ReturnType<typeof readDependencies>>): NeedsEvidence[] {
  const last = new Map<string, {
    specifier: string; line: number; file: string; star: boolean; names: readonly string[];
  }>();
  for (const dependency of read.dependencies) {
    if (!dependency.file) continue;
    if (dependency.specifier === "crate" || dependency.specifier === "self" || dependency.specifier === "super") continue;
    last.set(`${dependency.line} @ ${dependency.specifier}`, {
      specifier: dependency.specifier,
      line: dependency.line,
      file: dependency.file,
      star: dependency.star === true,
      names: dependency.names ?? [],
    });
  }
  return [...last.values()].map((one) => ({
    file: "",
    on: one.file,
    specifier: one.specifier,
    line: one.line,
    ...(one.star ? { star: true } : {}),
    ...(one.names.length > 0 ? { names: one.names } : {}),
  }));
}

/** One file's readable imports for the walk, or why it cannot be walked through. */
function hopsOf(
  file: string,
  workspace: Workspace,
  cache: ConfigCache,
  ledger?: Ledger,
): { hops: NeedsEvidence[]; blind?: NeedsWithheld } {
  const declared = declares(file, workspace, cache, ledger);
  if (declared.refused) return { hops: [], blind: declared.refused };
  const absolute = workspace.resolve(file)!;
  const read = readDependencies(file, workspace.read(absolute), workspace, cache);
  if (!read) return { hops: [], blind: "unreadable" };
  const hops = landings(read).map((hop) => ({ ...hop, file }));
  return declared.blind ? { hops, blind: declared.blind } : { hops };
}

/**
 * A Rust name imported through a module that re-exports it (#323).
 *
 * `parser.rs` writes `use crate::parser::ArgMatcher`, which lands on
 * `parser/mod.rs`, which writes `pub(crate) use self::arg_matcher::ArgMatcher`.
 * The compiler follows the name to `arg_matcher.rs`, and so does `@needs`' own
 * referee; the reader stopped at the module. Eleven true arrows on
 * `bench:planted` were that shape, and one of them was the single true
 * `@needs` the bench called wrong: read one hop short, the import looked like
 * it only ran the other way.
 *
 * By name, and only where the specifier carries one, which today is Rust:
 * a module that names `ArgMatcher` in a `use` and is imported for
 * `ArgMatcher` is passing it along, since a private `use` there would not
 * compile. A glob or a rename is not followed, and falls through to the walk.
 */
/**
 * Whether a module hands on whatever another file exports, and so on (#323).
 *
 * `from django.db.models import *` in `gis/db/models/__init__.py`, and
 * `from django.db.models.aggregates import *` inside that: the compiler says
 * the first file imports the third, because that is where the names are. The
 * same shape is `export * from "./x"` and `use crate::io::*`. Only a star
 * counts here -- a module that imports something for its own use is not
 * passing it on, and a named re-export is followed by name below.
 */
/**
 * Whether the file at the end of a star chain declares the name the import
 * asked for (#323).
 *
 * The name is the last segment of what was written -- `crate::MatchKind`,
 * `regex_automata::util::search::Span`. A specifier that names a module rather
 * than an item (`httpx`, `./widgets`) matches nothing, which is the point: the
 * chain is only this file's business when it came for something at the end of
 * it.
 */
function declaresWanted(wanted: string, to: string, workspace: Workspace): boolean {
  if (!/^[A-Za-z_]\w*$/.test(wanted)) return false;
  const language = languageOf(to);
  const absolute = workspace.resolve(to);
  if (!language || !absolute || workspace.stat(absolute) !== "file") return false;
  return declaredNames(workspace.read(absolute), language).includes(wanted);
}

function starReaches(
  from: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache,
  seen: Set<string>,
  /**
   * Whether this file was reached by a star import into Python, where the
   * module's attributes are everything it imported -- named or not.
   * `django/db/models/__init__.py` writes `from django.db.models.base import
   * Model`, and a file that star-imports the package has `Model`, so the
   * compiler calls that an import of `base.py`. A `pub use` and an `export *`
   * pass on only what the file itself re-exports, so they get no such step.
   */
  named = false,
): boolean {
  if (seen.has(from) || seen.size > 24) return false;
  seen.add(from);
  const absolute = workspace.resolve(from);
  if (!absolute || workspace.stat(absolute) !== "file") return false;
  const read = readDependencies(from, workspace.read(absolute), workspace, cache);
  if (!read) return false;
  const python = languageOf(from) === "python";
  for (const dependency of read.dependencies) {
    if (!dependency.file || dependency.file === from) continue;
    if (!dependency.star && !named) continue;
    if (dependency.file === to) return true;
    if (starReaches(dependency.file, to, workspace, cache, seen, python && dependency.star === true)) {
      return true;
    }
  }
  return false;
}

function reexported(
  from: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache,
  ledger?: Ledger,
): NeedsEvidence | undefined {
  const own = hopsOf(from, workspace, cache, ledger).hops;
  for (const written of own) {
    if (written.on === to) continue;
    /*
     * A star import takes everything that module has, so the chain alone is
     * the answer: Django's package files, `export * from`, `use io::*`.
     */
    if (written.star) {
      const reached = starReaches(
        written.on, to, workspace, cache, new Set([from]),
        languageOf(written.on) === "python",
      );
      if (reached) return written;
      continue;
    }
    /*
     * Otherwise the import named what it came for, and the name is followed
     * through the files that hand it on: `export { db } from "./database"`,
     * `pub(crate) use self::arg_matcher::ArgMatcher`, `from .base import
     * Model` under a star. Only the end of the chain counts -- `clap` passes
     * `ArgMatches` through two modules, and an arrow onto the middle one is a
     * planted mistake that stopping early turned green.
     */
    for (const name of written.names ?? []) {
      if (handsOn(written.on, name, to, workspace, cache, ledger, new Set([from]))) return written;
    }
  }
  return undefined;
}

/**
 * Whether a file passes `name` on from `to`, directly or through more files.
 *
 * The file has to import that exact name and not declare it itself: a module
 * writing `pub use self::arg_matcher::ArgMatcher` is handing `ArgMatcher` on,
 * and a module that declares its own is the end of the road. Where the
 * language allows a star at some point in the chain, `starReaches` covers the
 * rest.
 */
function handsOn(
  at: string,
  name: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache,
  ledger: Ledger | undefined,
  seen: Set<string>,
): boolean {
  if (seen.has(at) || seen.size > 8) return false;
  seen.add(at);
  for (const hop of hopsOf(at, workspace, cache, ledger).hops) {
    if (hop.on === at) continue;
    const carries = hop.star || (hop.names ?? []).includes(name);
    if (!carries) continue;
    if (hop.on === to) return declaresWanted(name, to, workspace);
    if (handsOn(hop.on, name, to, workspace, cache, ledger, seen)) return true;
  }
  return false;
}

/** How far a walk may go before its silence stops meaning anything. */
const WALK_LIMIT = 5000;

/**
 * Whether the tail reaches the head through what it imports, and the shortest
 * way if so.
 *
 * Breadth first, so the chain named is the shortest one. A file the walk
 * could not read to the end -- unlicensed, unvouched, a torn parse, an
 * `eval` -- is still walked through for what it does declare, and
 * marks the walk `blind`: finding the head is still a finding, and failing to
 * is no longer evidence, since that file may reach it in a way nobody can read.
 */
export function walkImports(
  from: string,
  to: string,
  workspace: Workspace,
  cache: ConfigCache,
  ledger?: Ledger,
): { reached?: { via: string[]; first: NeedsEvidence }; blind?: NeedsWithheld } {
  const cameFrom = new Map<string, { parent: string; hop: NeedsEvidence }>();
  const queue = [from];
  const seen = new Set([from]);
  let blind: NeedsWithheld | undefined;
  for (let next = 0; next < queue.length; next += 1) {
    const file = queue[next]!;
    const { hops, blind: here } = hopsOf(file, workspace, cache, ledger);
    if (here && file !== from) blind ??= here;
    for (const hop of hops) {
      if (seen.has(hop.on)) continue;
      seen.add(hop.on);
      cameFrom.set(hop.on, { parent: file, hop });
      if (hop.on === to) {
        const via: string[] = [];
        let step = cameFrom.get(to)!;
        while (step.parent !== from) {
          via.unshift(step.parent);
          step = cameFrom.get(step.parent)!;
        }
        return { reached: { via, first: step.hop } };
      }
      if (seen.size > WALK_LIMIT) return { blind: blind ?? "incomplete" };
      queue.push(hop.on);
    }
  }
  return blind ? { blind } : {};
}
