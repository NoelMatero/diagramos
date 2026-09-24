/**
 * Whether one routine calls another.
 *
 * The gap this closes (#189): calling is the single most common thing one piece
 * of code does to another -- 162,051 call relationships across the 3,297-file
 * census in #187, 53.2% of everything the syntax shows and four times the next
 * relation -- and until now an arrow could not say it. The model kept trying
 * anyway: `will call` and `calls` are the two most written pieces of prose on
 * any arrow in the board corpus, in the space where a word should be.
 *
 * ## Why this is harder than every other word here
 *
 * A field list, a signature and a file's imports are all readable inside one
 * file. **A call is not.** `foo()` is a name, and which `foo` it means is a
 * question about bindings that live somewhere else. Every other reader in this
 * directory can finish its job with the text in front of it; this one cannot,
 * and that is the whole of the difficulty.
 *
 * So the reader is two layers, and the second is the one that does the work:
 *
 *   1. **The call sites in a routine.** `parse.ts` already says a call is a
 *      node with a `function` field, and that holds in all four grammars.
 *   2. **What each called name is bound to.** A bare `foo` is the file's own
 *      `foo`, or a `foo` some import brought in, and those are different
 *      functions with one spelling. `bindingsIn` reads the import declarations
 *      and answers which.
 *
 * A call whose name cannot be tied to one file is not evidence of anything, and
 * this file is written so that such a call **raises a doubt** rather than
 * quietly counting as an absence.
 *
 * ## The footing: presence, like `@builds` and never like `@holds`
 *
 * `holds.ts` reads a declaration, so absence there is genuine absence. A
 * function body is not a declaration. A routine that never writes `b()` can
 * still reach `b` through a callback, a trait object, a dispatch table or a
 * decorator -- which is the `feeds` argument, in full, one relation over. So
 * **`absent` is not a finding here and must never become one.**
 *
 * What is available is the verdict `needs.ts` was built for and the one worth
 * having: finding the call running the **other way**, and only the other way,
 * is proof the arrow is backwards. That rests on something found rather than on
 * something missing.
 *
 * ## Every doubt is about a name, not about a body
 *
 * The first version of this raised a doubt on every call it could not resolve,
 * and refused 97% of the corpus: an ordinary body is full of `console.log` and
 * `.map()` and none of them can be resolved to a file, nor need to be.
 *
 * The rule that fixes it is that a doubt is only a doubt **about the name being
 * asked after**. `obj.render()` is unresolvable and irrelevant unless the far
 * box is called `render`; then it is a call that might be the one, and the
 * reader must stay quiet. A call whose name cannot be read at all -- `table[k]()`
 * -- is always a doubt, because the name it hides could be any name.
 *
 * ## The five ways a call escapes a static reader, and what happens to each
 *
 * The list is #189's, and none of them is answered -- each one is a reason to
 * withhold, which is the only honest thing available:
 *
 *   dynamic dispatch       a receiver whose type is not in the text  -> `receiver`
 *   callbacks              the name is passed, never called here     -> nothing to see
 *   `getattr`, `exec`      the body can reach anything at all        -> `dynamic`
 *   re-exports, barrels    the name binds to a file that forwards    -> `elsewhere`
 *   macros                 the call site is generated, not written   -> `macro`
 */
import { providedByLanguage } from "./builtins";
import { compiledBodiesOf, compiledRefutes, traitImplsOf, type CompiledBody, type CompiledCrate } from "./compiled-calls";
import { mayAccuse } from "./licence";
import { declaresMember, holdersIn } from "./overrides";
import { each, parseSource, type Language, type Node, type Tree } from "./parse";

/**
 * Why no verdict was reached. Every one of these is a reason to stay quiet, and
 * the caller reports the arrow exactly as it would have been reported before
 * anybody claimed anything.
 */
export type CallsWithheld =
  /** No grammar for this language, or the file would not parse at all. */
  | "unreadable"
  /** Nothing in that file declares that name. */
  | "not-declared"
  /** The name is declared and it is not a routine. There is no body to read. */
  | "no-body"
  /**
   * The parse recovered from an error, so what is and is not in this body is a
   * statement about a file we only partly read.
   */
  | "incomplete"
  /**
   * A call whose callee is a value: `table[kind]()`, `handlers[i]()`.
   *
   * The same `computed-call` doubt `deps.ts` names. The name is not in the
   * text, so it could be the one being asked after, and this doubt is raised
   * whatever the question was.
   */
  | "computed"
  /**
   * The body can reach a name that is nowhere in it: `getattr`, `eval`, `exec`.
   *
   * Python's whole hazard, and it is not a hypothetical -- `getattr(handler,
   * name)()` is how a dispatcher is spelled there.
   */
  | "dynamic"
  /** The declaration came out of macro soup, and the call site with it. */
  | "macro"
  /**
   * A call on a receiver whose type the text does not give: `obj.run()`.
   *
   * Raised only when the member is the name being asked after. Dynamic
   * dispatch, in all four grammars, is this.
   */
  | "receiver"
  /**
   * The name is called and nothing in the file says where it came from -- a
   * wildcard import, a global, an ambient declaration.
   */
  | "unbound"
  /**
   * The name is called and the *routine* is what binds it: a parameter, or a
   * value the body set before calling it.
   *
   * Apart from `unbound` because the two send a reader to opposite places
   * (#337). `unbound` says the origin is missing from the text and somebody
   * could go and find it -- a wildcard import leads to a file, a built-in to a
   * table. This says the origin is right there on the line above and is a
   * *value*, so what runs depends on whoever called, and no amount of reading
   * this file settles it. Counting the second as the first put nine sites of
   * one vite middleware into a bucket labelled "wildcard imports to follow".
   */
  | "local-callee"
  /**
   * The name is bound twice over: declared here *and* imported, or imported
   * from two places. Which one the call means is not in the text.
   */
  | "ambiguous"
  /**
   * The name binds to a file that is not the far end, and following the
   * forwarding ran out of road -- a file that could not be opened, a wildcard
   * re-export, a chain longer than the budget.
   *
   * Barrel files and re-exports. The binding is readable and stops short of an
   * answer.
   */
  | "elsewhere"
  /**
   * The name is imported and the specifier resolved to no file in this
   * repository.
   *
   * Usually a package: `from unittest.mock import patch`. Sometimes not -- a
   * monorepo's `@mundane/ui` is inside the repository and resolves to nothing
   * here, and reading that as "definitely not the far end" is how a workspace
   * alias becomes a false accusation. The two are indistinguishable to this
   * reader, so both withhold.
   */
  | "unplaced"
  /**
   * The language has a grammar and no measured licence, so nothing has ever
   * checked how often this reader is wrong about it. Confirming is unaffected;
   * it is the accusation that needs the licence (#198).
   */
  | "unlicensed";

/** Where the call was written, so a report can quote a file and a line. */
export interface CallsEvidence {
  /** The routine that was called. */
  name: string;
  /** The routine the call was written inside. */
  inside: string;
  /** 1-based, in the file the call was written in. */
  line: number;
  /** The call as written, so a verdict that can refute shows what it read. */
  wrote: string;
}

/**
 * Why a `refuted` verdict is entitled to say wrong, in place of the one
 * routine's worth of evidence `backwards` quotes (#233).
 *
 * There is no single call to point at -- the accusation rests on an absence
 * of one across every call the routine makes, which is the opposite shape of
 * evidence from `CallsEvidence`. `sites` is what a report shows in its place:
 * how much was actually checked, so "not among them" reads as a count rather
 * than an assertion.
 */
export interface CallsRefutedEvidence {
  /** The routine whose entire call set was enumerated and found closed. */
  routine: string;
  /** 1-based line the routine opens on. */
  line: number;
  /** Every call the routine makes, checked and placed somewhere else. */
  sites: number;
}

/**
 * Why a `wrong-routine` verdict is entitled to say wrong (#329).
 *
 * The closed reading of `refuted`, plus the one thing it used to throw away:
 * a call that *does* land in the head's file, at a routine the arrow does not
 * name. That is the strongest position this reader reaches short of refuting
 * -- the call list is closed, and the one call going anywhere near the far
 * end demonstrably goes somewhere else -- and it is more useful than either
 * colour on its own, because the routine it names is the fix.
 */
export interface CallsWrongRoutineEvidence {
  /** The routine whose entire call set was enumerated and found closed. */
  routine: string;
  /** 1-based line the routine opens on. */
  line: number;
  /** Every call the routine makes, checked and placed. */
  sites: number;
  /**
   * The calls that land in the head's file, and what each one reaches there
   * -- the far side's own spelling, never the one written at the call site.
   * Never empty, or this verdict would be `refuted` instead.
   */
  reached: Array<{ name: string; line: number }>;
}

export type CallsVerdict =
  /** The tail calls the routine the arrow points at. */
  | { verdict: "confirmed"; evidence: CallsEvidence }
  /**
   * The call runs the other way, and only the other way: the head calls the
   * tail. The arrow is backwards.
   */
  | { verdict: "backwards"; evidence: CallsEvidence }
  /**
   * Every call the tail's routine makes was enumerated, resolved, and none of
   * them reaches the head -- a closed-body absence (#233), licensed
   * separately from `backwards` and resting on a different reader
   * (`callSitesIn`'s tier-2 resolver, docs/claim-vocabulary.md items 12-14).
   * `absent` below is still the answer everywhere this licence does not
   * apply; this is not a replacement for it, only a second way to earn the
   * same "wrong".
   */
  | { verdict: "refuted"; evidence: CallsRefutedEvidence }
  /**
   * Neither end calls the other, as far as the text shows.
   *
   * **Not a finding, and this must stay true.** A callback is invisible here,
   * so this is "no call found", never "no call happens". Reported exactly as an
   * unclaimed arrow is.
   */
  /**
   * The call set was closed, and a call in it lands in the head's file at a
   * routine the arrow does not name (#329). `refuted` with the near miss
   * named: same closed reading, same licence, and a sentence that says what
   * to draw instead of only what is wrong.
   */
  | { verdict: "wrong-routine"; evidence: CallsWrongRoutineEvidence }
  | { verdict: "absent"; notClosed?: CallsNotClosed }
  | { verdict: "withheld"; why: CallsWithheld };

/**
 * Why the closed-body reading could not close, on an arrow that came back
 * `absent` (#324).
 *
 * `absent` has always been two answers wearing one word. One is *the whole
 * call set was read and the head is not in it*, which is `refuted` and is a
 * finding. The other is *the reading stopped somewhere*, which is silence --
 * and until now it was silence about silence: the reason the reading stopped
 * was computed, used to return `undefined`, and thrown away. On the planted
 * boards that left 170 of the 249 missed `@calls` mistakes with no recorded
 * reason of any kind, so nobody could rank what to fix.
 *
 * Carried on the verdict rather than tallied inside this file, because the
 * same distinction is what an arrow needs to say out loud: "no call found" and
 * "we could not finish looking" are different sentences to the person holding
 * the board.
 *
 * `SiteUnresolved` is spliced in whole rather than restated, for the reason
 * given at `SiteUnresolved` itself: a reason this reader can produce and this
 * type cannot name would be a reason nothing could ever report.
 */
export type CallsNotClosed =
  /**
   * The language has no absence licence for `@calls`, so the closed reading
   * was never attempted. Not a fact about this code -- a fact about what has
   * been measured (`licence.ts`, `#231`).
   */
  | "unlicensed"
  /** `callSitesIn` could not read the tail's file at all. */
  | "unreadable"
  /** The tail's file was read and declares no routine by that name. */
  | "routine-not-found"
  /**
   * A call was placed, and placed at a type that is an interface, an abstract
   * class or a bare type parameter -- item 14's caveat
   * (docs/claim-vocabulary.md). The method actually reached at runtime can
   * live on a different class, so the set is enumerable and not conclusive.
   */
  | "abstract-receiver"
  /**
   * A call was placed at a method of a plain class, and a class deriving from
   * it declares that method again (#353). Whenever the value is one of those,
   * the subclass's method is what runs -- so where the call was placed is one
   * of the places it goes, not the only one.
   */
  | "overridden"
  /**
   * A call in the tail's body does land in the head's file, at some routine
   * the arrow does not name.
   *
   * Not a refusal to read and not a mistake: the two readers agree and the
   * call set is genuinely open on this question. Named so it can be told
   * apart from the reasons above, all of which are the reading falling short.
   */
  | "reaches-the-file"
  /**
   * The Rust compiler's own list of the tail's calls (#357) has a call, or a
   * mention, of something named what the head is named. The list names a
   * function and not where it lives -- a call through a trait names no
   * implementation at all -- so a shared name is as far as it can say.
   */
  | "same-name"
  /**
   * The head is a method of a trait the repository does not declare, and
   * the language or a library calls those without the name being written:
   * `a + b` runs `add`, `?` runs `from`, `format!` runs `fmt`, a scope's end
   * runs `drop` (#357). Neither the text nor the compiler's list shows the
   * method, only the machinery.
   */
  | "called-implicitly"
  /**
   * The tail's body names the head without calling it -- `map(double)`,
   * `spawn(worker)` -- so it hands the routine to something that does
   * (#357). Rust only: every call in the body can be placed and the head is
   * still what runs.
   */
  | "named"
  | SiteUnresolved;

/** One end of the question: a file, its text, and what its imports point at. */
export interface CallSide {
  /** Repo-relative, and the identity a binding is compared against. */
  file: string;
  source: string;
  language: Language;
  /**
   * This file's dependencies, already resolved to files by `deps.ts`.
   *
   * Handed in rather than read here, because resolving a specifier to a file is
   * three different problems in three languages and `deps.ts`, `deps-rust.ts`
   * and `deps-python.ts` have each been measured at it. This file's job is the
   * half nothing else does: which specifier a *name* came from.
   */
  imports: Array<{ specifier: string; file?: string }>;
  /**
   * Another file in the same repository, when one can be read.
   *
   * A name is very often imported from a file that does not declare it --
   * `from graphify.extract import extract_objc`, where `extract.py` re-exports
   * what `extractors/objc.py` declares. Without this the reader answered
   * `absent` on 250 calls in one repository that are written in plain sight,
   * and each one of those is half of a false `backwards`.
   *
   * Optional, because a caller holding one file can still get a confirmation
   * out of this reader. Without it a forwarded name withholds.
   */
  open?: (file: string) => { source: string; language: Language; imports: CallSide["imports"] } | undefined;
  /**
   * A receiver's type, from its exact byte range -- tier 1 (`resolution.ts`)
   * or tier 2 (a real checker), when a caller has one. Optional, and consulted
   * in exactly one place: `placeOf`'s three `receiver` dead ends, where the
   * text names a value (`x.foo()`) but not what it is.
   *
   * Three shapes, all narrowing `receiver` and never inventing a new refusal:
   *
   *   `{ kind: "type"; name }`        placed exactly the way a bare name
   *                                   would be -- local, imported, or
   *                                   `unbound` when the name matches
   *                                   neither. The fallback: a resolver that
   *                                   only knows a printed type name and
   *                                   nothing about where it lives.
   *   `{ kind: "declared"; file; concrete }`  the resolver knows *the exact
   *                                   repo-relative file* the type is
   *                                   declared in -- placed there directly,
   *                                   bypassing a name search entirely.
   *                                   Stronger than `type`, and catches what
   *                                   it cannot: `const x = make(); x.run()`
   *                                   binds no name this file ever imports
   *                                   for `x`'s real type, only for `make`,
   *                                   so a name search finds nothing to
   *                                   place even though the compiler already
   *                                   knows exactly where `x`'s type lives.
   *                                   `concrete` is `false` when that type is
   *                                   an interface, an abstract class, or a
   *                                   bare type parameter -- item 14's own
   *                                   caveat (docs/claim-vocabulary.md): the
   *                                   method actually reached at runtime can
   *                                   live on a different class than the one
   *                                   the declared type names, so a closed-body
   *                                   accusation (#233) may not rest on this
   *                                   site even though it is placed.
   *   `{ kind: "external" }`          the resolver knows *where the type is
   *                                   declared* and that place is not this
   *                                   repository (a language builtin, a
   *                                   package in `node_modules`) -- placed
   *                                   immediately, because a call that
   *                                   provably lands outside the repository
   *                                   provably is not any repo routine either.
   *
   * `resolves`/`callsTo`, the direction-and-backwards half of the live
   * per-claim path `drift.ts` uses, never reads this field: wiring a resolver
   * in was additive to the closed-bodies question (#226) and changed nothing
   * about what `@calls` reported then. `callsBetween`'s closed-body absence
   * check (#233) is the first live caller that does, through `callSitesIn`.
   */
  resolveReceiver?: (at: { start: number; end: number }) => ReceiverResolution | undefined;
  /**
   * "Go to definition" at a call's own name (#351): where the function called
   * there is declared, `"outside"` when that is not in the repository.
   *
   * When a caller hands this in, it replaces `resolveReceiver` as the question
   * a `receiver` dead end is put to. `resolveReceiver` asks what the value on
   * the left of the dot is and then maps that type back to a file itself, and
   * each of those two steps can drop the answer -- a chain, a closure's
   * parameter, `self.field.method()` -- while `Type::make()` has no value on
   * the left to ask about at all. This asks the question the placement is
   * actually for, at the one position every language server answers it.
   *
   * Only `drift.ts`'s `@calls` closed-body check passes it. The walk across
   * files (`reach.ts`) and `@accesses` ask the same question through their own
   * options and are unchanged.
   */
  declarationAt?: (at: { start: number; end: number }) => { file: string; line: number; concrete?: boolean } | "outside" | undefined;
  /**
   * Whether a class deriving from the one named `holder` declares `member`
   * again, anywhere in the repository (#353) -- `overrides.ts`. A call placed
   * at such a method runs the subclass's whenever the value is one, so the
   * closed-body check may not accuse on it.
   *
   * Absent, nobody asked, and a placement stands as it did before this
   * existed. `drift.ts` hands it to every side it builds.
   */
  overridden?: (holder: string, member: string) => boolean;
  /**
   * The crate the Rust compiler built this file into, when it has (#357) --
   * every body after macro expansion, with every call it makes.
   *
   * Consulted only where the text reading of a Rust tail stopped short: a
   * call inside a macro, a receiver nothing could type. There the compiler's
   * list is read instead (`compiled-calls.ts`), and only after every call
   * the text *did* see is found in it. Absent, or answering `undefined`,
   * and the text reading stands exactly as before.
   *
   * `drift.ts` hands it to the tail of a `@calls` arrow; `referee-live.ts`
   * builds what it answers from.
   */
  compiled?: () => CompiledCrate | undefined;
}

/** What `resolveReceiver` may answer with. See `CallSide.resolveReceiver`'s doc. */
export type ReceiverResolution =
  | { kind: "type"; name: string }
  | { kind: "declared"; file: string; concrete: boolean }
  | { kind: "external" };

/* ------------------------------------------------------------------ bindings */

/** What one name in a file is bound to. */
interface Binding {
  /** The import specifier it came from, spelled as the language writes it. */
  specifier: string;
  /** True when the name stands for a module rather than for a routine. */
  namespace: boolean;
  /**
   * The name the *other side* declares it under, when the text says (#329).
   *
   * `import { render as r }` binds `r` here and names `render` there, and all
   * four grammars write that shape the same way: a name, and an alias it is
   * bound as. Until this field existed the alias was recorded and the name
   * thrown away, so a call written `r()` could be placed in the right file
   * and never matched against the routine it actually reaches.
   *
   * `undefined` is "the text does not say", which is not the same as the
   * bound name. A default import -- `import anything from "./b"` -- names the
   * far side nothing at all, and filling that gap in with the local spelling
   * would be an invention of exactly the kind a verdict must not rest on.
   */
  name?: string;
}

export interface Bindings {
  /** Names this file brought in, and where from. */
  imported: Map<string, Binding>;
  /** Names declared in this file's own text. */
  local: Set<string>;
  /** Names bound more than once, where the text does not say which wins. */
  ambiguous: Set<string>;
  /**
   * Names this file passes on without binding: `export { x } from "./y"`.
   *
   * Not a binding -- nothing in this file can call `x` -- so it is kept apart
   * from `imported`. It is the only thing that makes a barrel file followable.
   */
  forwarded: Map<string, Binding>;
  /**
   * True when the file brings in or passes on names nothing can enumerate:
   * `from x import *`, `export * from "./y"`, `use crate::a::*`.
   *
   * A file like this can never answer "the name did not come from here", so
   * following through it stops rather than concluding.
   */
  wildcard: boolean;
  /**
   * The specifiers those wildcards name -- `"./general"` in `export * from
   * "./general"`.
   *
   * The names a wildcard brings in cannot be listed. The *places* it brings
   * them from can, and they are written down right there. Recording them is
   * what makes a barrel file followable: `@vue/shared` resolves to
   * `packages/shared/src/index.ts`, which declares nothing and re-exports
   * seven modules, so `toRawType` used to come back `elsewhere` and every
   * cross-package chain in that repository died at the barrel -- 20 of one
   * corpus's arrows, and the commonest single reason the walk in `reach.ts`
   * could not follow a real path.
   *
   * Followed only to a **unique** answer. A name two of the wildcard's
   * targets declare, or a target that could not be read, is a doubt exactly
   * as it was before; see `throughWildcards`.
   */
  reExported: string[];
}

/** The separators a module path is written with, in the four grammars. */
const PATH_STEP = ["::", ".", "/"];

/** Whether `outer` names `inner` or a module above it. */
function pathCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  return PATH_STEP.some((step) => inner.startsWith(outer + step));
}

/**
 * The last segment of a dotted or scoped path, which is the name it binds.
 *
 * `import a.b` binds `a`, not `b` -- Python's one exception, handled by its own
 * caller rather than here.
 */
function lastSegment(path: string): string {
  return path.split(/::|\./).pop() ?? path;
}

function bind(into: Bindings, name: string, binding: Binding): void {
  if (into.local.has(name)) { into.ambiguous.add(name); return; }
  const already = into.imported.get(name);
  if (already && already.specifier !== binding.specifier) { into.ambiguous.add(name); return; }
  into.imported.set(name, binding);
}

/**
 * The two names in a renaming import: what it is called there, what it is
 * bound as here (#329).
 *
 * Every grammar this reader handles spells a rename with the same two fields.
 * TypeScript's `import_specifier` and `export_specifier`, Python's
 * `aliased_import` and Rust's `use_as_clause` all carry a `name` (or `path`,
 * which is a name with a module in front of it) and an `alias`, and the only
 * difference between them is which of those two field names the grammar
 * chose. Read as fields rather than as a list of node types, per
 * docs/reading-a-grammar.md -- a hand-written list of node names is how the
 * same mistake got made four times in one sitting, and a rename is one idea
 * in four languages rather than four ideas.
 *
 * `bound` is the name in this file's scope and is what a call writes.
 * `declared` is the name at the far end, and is `undefined` where the text
 * does not give one.
 */
function renamedBy(node: Node): { bound: string; declared?: string } | undefined {
  const there = node.childForFieldName("name") ?? node.childForFieldName("path");
  const here = node.childForFieldName("alias") ?? there;
  if (!here) return undefined;
  return { bound: here.text, declared: there ? lastSegment(there.text) : undefined };
}

/** Direct children of a node, which no grammar exposes as an array. */
function children(node: Node): Node[] {
  const out: Node[] = [];
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) out.push(child);
  }
  return out;
}

/**
 * TypeScript, JavaScript and TSX: everything hangs off `import_clause`.
 *
 * `export { x } from "./y"` is deliberately not read. It binds nothing in this
 * file -- it forwards -- and reading it as a binding is how a barrel file would
 * have started answering questions about names it only passes through.
 */
function bindTypeScript(root: Node, into: Bindings): void {
  each(root, (node) => {
    const isImport = node.type === "import_statement";
    if (!isImport && node.type !== "export_statement") return;
    const from = node.childForFieldName("source");
    if (!from) return;
    const specifier = from.text.slice(1, -1);
    /*
     * `export { x } from "./y"` binds nothing here -- no code in this file can
     * call `x` -- so it goes in `forwarded`, which is the map that makes a
     * barrel file followable and the reason this branch exists at all.
     */
    const into_ = isImport ? into.imported : into.forwarded;
    const record = (bound: string, namespace: boolean, declared?: string) => {
      if (isImport) bind(into, bound, { specifier, namespace, name: declared });
      else into_.set(bound, { specifier, namespace, name: declared });
    };

    for (const part of children(node)) {
      if (part.type === "export_clause" || part.type === "named_imports") {
        for (const one of children(part)) {
          if (one.type !== "export_specifier" && one.type !== "import_specifier") continue;
          const renamed = renamedBy(one);
          if (renamed) record(renamed.bound, false, renamed.declared);
        }
        continue;
      }
      if (part.type === "*") {
        into.wildcard = true;
        // `export * from "./y"`. An `import *` is a `namespace_import` below
        // and binds a name, so this branch is only ever the re-export.
        if (!isImport) into.reExported.push(specifier);
        continue;
      }
      if (part.type !== "import_clause") continue;
      for (const clause of children(part)) {
        if (clause.type === "identifier") {
          /*
           * `import def from "./y"`. The far side declares this under whatever
           * name it likes, or under none at all (`export default function
           * () {}`), and this spelling is the importer's own choice -- so the
           * declared name is left unsaid rather than guessed at.
           */
          record(clause.text, false);
        } else if (clause.type === "namespace_import") {
          // `import * as ns from "./y"`: the alias renames the *module*, and a
          // member reached through it keeps its own name, so there is no
          // routine name for this binding to carry.
          const name = children(clause).find((child) => child.type === "identifier");
          if (name) record(name.text, true);
        } else if (clause.type === "named_imports") {
          for (const one of children(clause)) {
            if (one.type !== "import_specifier") continue;
            const renamed = renamedBy(one);
            if (renamed) record(renamed.bound, false, renamed.declared);
          }
        }
      }
    }
  });
}

/**
 * Python, where the same keyword binds two different kinds of thing.
 *
 * `from x import foo` binds the routine `foo` and the specifier is `x.foo`,
 * which is exactly the shape `deps-python.ts` records for it. `import a.b`
 * binds the *module* `a` -- the first segment, not the last -- and `a.b.go()`
 * reaches through it.
 *
 * `from x import *` binds names this reader cannot enumerate. Nothing is
 * recorded, and every name it brought in comes out `unbound`, which is the
 * correct answer rather than a gap.
 */
function bindPython(root: Node, into: Bindings): void {
  each(root, (node) => {
    if (node.type === "import_from_statement") {
      const moduleNode = node.childForFieldName("module_name");
      if (!moduleNode) return;
      const module = moduleNode.text;
      for (const part of children(node)) {
        if (part.id === moduleNode.id) continue;
        if (part.type === "dotted_name") {
          bind(into, lastSegment(part.text), {
            specifier: `${module}.${part.text}`, namespace: false, name: lastSegment(part.text),
          });
        } else if (part.type === "aliased_import") {
          const name = part.childForFieldName("name");
          const renamed = renamedBy(part);
          if (name && renamed) {
            bind(into, renamed.bound, {
              specifier: `${module}.${name.text}`, namespace: false, name: renamed.declared,
            });
          }
        } else if (part.type === "wildcard_import") {
          into.wildcard = true;
          into.reExported.push(module);
        }
      }
      return;
    }
    if (node.type !== "import_statement") return;
    for (const part of children(node)) {
      if (part.type === "dotted_name") {
        // `import a.b` puts `a` in scope, and only `a`.
        const head = part.text.split(".")[0]!;
        bind(into, head, { specifier: head, namespace: true });
      } else if (part.type === "aliased_import") {
        // `import a.b as m`: the alias renames the module, and `m.go()` calls
        // whatever `go` that module declares -- so this binding carries no
        // routine name, exactly as a TypeScript namespace import does not.
        const name = part.childForFieldName("name");
        const alias = part.childForFieldName("alias");
        if (name && alias) bind(into, alias.text, { specifier: name.text, namespace: true });
      }
    }
  });
}

/**
 * Rust, where one `use` can bind a dozen names and the tree is nested.
 *
 * `use crate::a::{b, c as d}` is a `scoped_use_list`, and every leaf under it is
 * a separate binding whose specifier is the full path -- which is what
 * `deps-rust.ts` records and what `pathCovers` then matches against.
 *
 * A `use ...::*` binds names nothing can list, exactly as Python's does, and is
 * left out for the same reason.
 */
function bindRust(root: Node, into: Bindings): void {
  const walk = (node: Node, prefix: string): void => {
    switch (node.type) {
      case "scoped_use_list": {
        const path = node.childForFieldName("path");
        const list = node.childForFieldName("list");
        const under = path ? (prefix ? `${prefix}::${path.text}` : path.text) : prefix;
        if (list) for (const one of children(list)) walk(one, under);
        return;
      }
      case "use_list": {
        for (const one of children(node)) walk(one, prefix);
        return;
      }
      case "use_as_clause": {
        const path = node.childForFieldName("path");
        const renamed = renamedBy(node);
        if (!path || !renamed) return;
        const full = prefix ? `${prefix}::${path.text}` : path.text;
        bind(into, renamed.bound, { specifier: full, namespace: false, name: renamed.declared });
        return;
      }
      case "use_wildcard": {
        // The names are not enumerable; the module they come from is, and it
        // is written right here. See `Bindings.reExported`.
        into.wildcard = true;
        const path = node.childForFieldName("path") ?? node.child(0);
        const under = path && path.type !== "*" ? path.text : "";
        const full = prefix && under ? `${prefix}::${under}` : prefix || under;
        if (full) into.reExported.push(full);
        return;
      }
      case "scoped_identifier":
      case "identifier":
      case "crate":
      case "self":
      case "super": {
        const full = prefix ? `${prefix}::${node.text}` : node.text;
        const name = lastSegment(full);
        if (name) bind(into, name, { specifier: full, namespace: false, name });
        return;
      }
      default:
    }
  };

  each(root, (node) => {
    if (node.type !== "use_declaration") return;
    const argument = node.childForFieldName("argument");
    if (argument) walk(argument, "");
  });
}

/**
 * Statements that bring a name in from somewhere else rather than declaring it.
 *
 * Pruned rather than filtered, because an import *looks* exactly like a
 * declaration to the rule `parse.ts` states -- `import { foo }` is a node with a
 * `name` field, and so is `use crate::a::foo`. The first version of this counted
 * every imported name as locally declared, which made every import in every
 * TypeScript file ambiguous with itself: 217 refusals in `ts` and 156 in `tsx`,
 * and **zero** cross-file calls confirmed in either. The whole word looked
 * impossible in TypeScript and the cause was one missing exclusion.
 */
const BRINGS_IN = /^(import_statement|import_from_statement|use_declaration|future_import_statement)$/;

/**
 * Node types that declare a name, as opposed to merely carrying one.
 *
 * Needed for the same reason `BRINGS_IN` is. `f(name=1)` in Python is a
 * `keyword_argument` with a `name` field, and a parameter with a default is a
 * `default_parameter` with one -- neither declares anything a call could reach,
 * and both would make an ordinary import ambiguous with an argument label.
 */
const DECLARES = /(_declaration|_definition|_declarator|_item)$/;

/**
 * Declarations a bare call could never reach: the members of a type.
 *
 * `interface EmailPreviewProps { registerRef: ... }` declares a name, and
 * nothing in that file can call it -- it is the shape of somebody else's
 * argument. Counting it made a call to an imported `registerRef` read as a call
 * to "this file's own", which is a definite no rather than a doubt, and the
 * reader answered `absent` on a call written three lines below the interface.
 *
 * A method is left in. It is reached through `self` or `this`, and that branch
 * asks a different question.
 */
const NOT_REACHABLE =
  /^(property_signature|method_signature|call_signature|construct_signature|abstract_method_signature|public_field_definition|field_definition|field_declaration|enum_variant)$/;

/** Names this file declares itself, at any depth, imports excluded. */
function declaredNames(node: Node, into: Set<string>): void {
  if (BRINGS_IN.test(node.type)) return;
  if (DECLARES.test(node.type) && !NOT_REACHABLE.test(node.type)) {
    const name = node.childForFieldName("name")
      ?? (node.type === "impl_item" ? node.childForFieldName("type") : undefined);
    if (name && name.childCount === 0) into.add(name.text);
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) declaredNames(child, into);
  }
}

const BINDINGS_LIMIT = 512;
/**
 * What a file binds, remembered across the questions asked about it.
 *
 * Nothing here has a shelf life: the key is the file's whole text, so an edited
 * file is a different question and a stale answer cannot be returned. What it
 * buys is that the answer is a fact about a *file* while the caller asks it once
 * per *call site*. `measure:calls` asked this 19,320 times about 775 files --
 * every one of those a full walk of the tree, and every node on that walk a
 * crossing into WebAssembly and back.
 *
 * Bounded and holding only strings. `parseSource` has to keep its own cache
 * small because a tree is WebAssembly memory that only `delete()` returns; this
 * one holds names, so it can afford to remember more files than that.
 */
const bindings_ = new Map<string, Bindings | undefined>();

/**
 * What every name in a file is bound to.
 *
 * Exported because the measurement drives it directly: the binding half is
 * where a call reader goes wrong, and a number about the whole verdict would
 * not say which layer produced it.
 */
export function bindingsIn(source: string, language: Language): Bindings | undefined {
  const remembered = `${language}:${source}`;
  if (bindings_.has(remembered)) {
    const cached = bindings_.get(remembered);
    bindings_.delete(remembered);
    bindings_.set(remembered, cached);
    return cached;
  }
  const found = readBindings(source, language);
  bindings_.set(remembered, found);
  if (bindings_.size > BINDINGS_LIMIT) {
    const oldest = bindings_.keys().next();
    if (!oldest.done) bindings_.delete(oldest.value);
  }
  return found;
}

function readBindings(source: string, language: Language): Bindings | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  const bindings: Bindings = {
    imported: new Map(), local: new Set(), ambiguous: new Set(),
    forwarded: new Map(), wildcard: false, reExported: [],
  };
  declaredNames(tree.rootNode, bindings.local);
  if (language === "python") bindPython(tree.rootNode, bindings);
  else if (language === "rust") bindRust(tree.rootNode, bindings);
  else bindTypeScript(tree.rootNode, bindings);
  // A name that is both declared here and imported was bound twice; `bind`
  // catches the orders it sees, and this catches the one it cannot.
  for (const name of bindings.imported.keys()) {
    if (bindings.local.has(name)) bindings.ambiguous.add(name);
  }
  return bindings;
}

/* --------------------------------------------------------------- call sites */

/** How a call names the thing it calls. */
type Callee =
  /**
   * `foo()` -- a bare name in this file's scope. `nameAt` is where `foo` is
   * written, for a checker to be asked "go to definition" there (#255).
   */
  | { kind: "bare"; name: string; nameAt: { start: number; end: number } }
  /** `self.foo()`, `this.foo()` -- a member of the thing the routine belongs to. */
  | { kind: "own"; name: string; nameAt: { start: number; end: number } }
  /**
   * `ns.foo()`, `Type::foo()` -- a member of something else that is named.
   * `at` is the receiver expression's own byte range as written -- `ns` in
   * `ns.foo()` -- present whenever `through` is, empty string included: a
   * complex receiver (`make().run()`) has no name to place but still has an
   * expression a real type checker could be asked about.
   */
  | {
      kind: "through"; through: string; name: string; at: { start: number; end: number };
      /**
       * The *method* name's own byte range -- `foo` in `x.foo()`, not `x`.
       * Exists so a referee can ask a real checker what `x.foo` itself
       * resolves to (`getSymbolAtLocation` on the member, the way a "go to
       * definition" would), independently of how `resolveReceiver` derived
       * a placement from `x`'s type alone. Two different questions: `x`'s
       * type names a class, and the method actually reached could still live
       * on a different one an interface merges in or a subclass overrides --
       * `at` cannot see that, and this is the range that lets something else
       * check it.
       */
      memberAt: { start: number; end: number };
    }
  /** `table[k]()` -- the name is not in the text. */
  | { kind: "computed" };

/** The receivers that mean "the thing this routine is part of". */
const OWN = new Set(["self", "this"]);

/** A name a reader would recognise, wherever a grammar puts one. */
const NAME_LEAF = /identifier$|^field_identifier$|^property_identifier$/;

function calleeOf(node: Node): Callee | undefined {
  const callee = node.childForFieldName("function") ?? node.childForFieldName("macro");
  return callee ? calleeOfNode(callee) : undefined;
}

/**
 * The thing `new X()` makes, read as though it were a callee (#328).
 *
 * `@calls` does not confirm from a construction -- `@builds` is the word for
 * that, and the two stay separate. But the compiler's own call list does
 * count one, and a closed reading that leaves it out will refute an arrow
 * drawn onto the class being constructed. TanStack's `mutationCache.build`
 * does one interesting thing, `new Mutation(...)`, and the first check able
 * to close that body accused a correct board of not reaching `mutation.ts`.
 *
 * So a construction is a site the closed reading has to place, and nothing
 * else: it is read only by `callSitesIn`, which means it can stop a
 * refutation and can never start one.
 */
function constructedBy(node: Node): Callee | undefined {
  if (node.type !== "new_expression") return undefined;
  const made = node.childForFieldName("constructor");
  return made ? calleeOfNode(made) : { kind: "computed" };
}

function calleeOfNode(callee: Node): Callee {
  if (callee.childCount === 0) {
    return NAME_LEAF.test(callee.type)
      ? { kind: "bare", name: callee.text, nameAt: { start: callee.startIndex, end: callee.startIndex + callee.text.length } }
      : { kind: "computed" };
  }

  /*
   * `foo::<T>()` in Rust is a `generic_function` wrapping the real callee, and
   * reading it as a member access made 66 Rust calls come back `computed` -- a
   * doubt about a name that was right there in the text.
   */
  const inner = callee.childForFieldName("function");
  if (inner) return calleeOfNode(inner);

  const object = callee.childForFieldName("object")
    ?? callee.childForFieldName("value")
    ?? callee.childForFieldName("path")
    ?? callee.child(0);
  const member = callee.childForFieldName("property")
    ?? callee.childForFieldName("attribute")
    ?? callee.childForFieldName("field")
    ?? callee.childForFieldName("name");
  if (!object || !member || member.childCount !== 0) return { kind: "computed" };
  if (OWN.has(object.text)) {
    return { kind: "own", name: member.text, nameAt: { start: member.startIndex, end: member.startIndex + member.text.length } };
  }
  // A receiver that is itself an expression -- `make().run()`, `a.b.c()` -- names
  // nothing this reader can look up. Treated as an unknown receiver rather than
  // as a computed callee: the member *is* readable, so the doubt it raises is
  // only about the name it is a member of.
  const through = object.childCount === 0 ? object.text : "";
  return {
    kind: "through", through, name: member.text,
    at: { start: object.startIndex, end: object.startIndex + object.text.length },
    memberAt: { start: member.startIndex, end: member.startIndex + member.text.length },
  };
}

/**
 * The names a routine binds for itself: its parameters, and whatever its body
 * sets before using it (#337).
 *
 * Read as *fields*, per docs/reading-a-grammar.md, because a list of node
 * types is the mistake that file exists to describe. Three fields carry every
 * binding in all four grammars:
 *
 *   `name`      TypeScript's `variable_declarator`, Python's
 *               `default_parameter`, a nested `function_declaration`
 *   `pattern`   Rust's `parameter` and `let_declaration`, TypeScript's
 *               `required_parameter`
 *   `left`      Python's `assignment`, which spells the same idea a third way
 *
 * A `type` field is never descended into, and that is not a detail: Rust puts
 * the binding and its type on one node, so a walk that took every identifier
 * under `parameters` would bind `Mystery` from `fn f(x: Mystery)` and then
 * place a call on it.
 *
 * Generous by design. A name collected here that is not really a binding
 * turns a site's reason from `unbound` into `local-callee`, and both leave the
 * body open -- so the cost of over-reading is a ranking that is wrong about
 * the reason, never a verdict that is wrong about the code.
 */
function boundByRoutine(routine: Node): Set<string> {
  const bound = new Set<string>();
  const take = (node: Node): void => {
    if (node.childCount === 0) {
      if (NAME_LEAF.test(node.type)) bound.add(node.text);
      return;
    }
    for (const child of children(node)) take(child);
  };
  /**
   * Inside the parameter list every name is a binding, so the leaves are taken
   * whether a field points at them or not -- Python writes `def f(hook)` as a
   * bare `identifier` under `parameters` with no field on it at all, which is
   * the "where there is no field, read the structure" half of the rule.
   */
  const walkParameters = (node: Node): void => {
    const type = node.childForFieldName("type");
    if (node.childCount === 0) { take(node); return; }
    for (const child of children(node)) {
      if (type && child.id === type.id) continue;
      walkParameters(child);
    }
  };
  /**
   * Inside the body only a field says "binding". A bare identifier there is a
   * *use*, and taking those would bind every name the routine mentions --
   * which would make `local-callee` mean nothing at all.
   */
  const walkBody = (node: Node): void => {
    for (const field of ["name", "pattern", "left"]) {
      const named = node.childForFieldName(field);
      if (named) take(named);
    }
    const type = node.childForFieldName("type");
    for (const child of children(node)) {
      if (type && child.id === type.id) continue;
      walkBody(child);
    }
  };
  const parameters = routine.childForFieldName("parameters");
  if (parameters) walkParameters(parameters);
  const body = routine.childForFieldName("body");
  if (body) walkBody(body);
  return bound;
}

/** 1-based line of a byte offset, counted the way an editor counts. */
const lineOf = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

/**
 * The names a body can reach without naming them.
 *
 * All four languages have a way to call a string, and a body that uses one can
 * call anything at all -- so the doubt is raised whatever name was asked after,
 * the same way a computed callee is.
 */
const REACHES_ANYTHING = new Set([
  "getattr", "setattr", "eval", "exec", "__import__", "globals", "locals", "vars",
  "apply", "call", "Function",
]);

type Named = { routines: Node[]; declared: boolean; unreadable: boolean };
const named_ = new WeakMap<Tree, Map<string, Named>>();

/**
 * Every routine of this name in this source.
 *
 * The rule and its reasoning are `constructs.ts`'s, and deliberately identical:
 * a routine is a declaration that has `parameters`, which is one of the three
 * facts `parse.ts` says holds in every grammar; a Rust `impl` block names its
 * type on a `type` field; and a box that names a *type* is scanned through the
 * routines inside it, because nobody draws a box for one method of a class.
 */
function routinesNamed(
  source: string,
  routine: string,
  language: Language,
): Named {
  const tree = parseSource(source, language);
  if (!tree) return { routines: [], declared: false, unreadable: true };

  /*
   * Held against the tree rather than against the text, because what is
   * remembered here are nodes *inside* that tree -- they mean nothing once it
   * is freed. A weak key is exactly that lifetime: `parseSource` evicting a
   * tree makes every answer about it unreachable, so a stale node cannot come
   * back. The same file gets asked about a dozen different routines and every
   * one of those walked the whole tree again.
   */
  const found_ = named_.get(tree) ?? new Map<string, Named>();
  named_.set(tree, found_);
  const remembered = found_.get(routine);
  if (remembered) return remembered;

  const routines: Node[] = [];
  let declared = false;
  each(tree.rootNode, (node) => {
    const name = node.type === "impl_item"
      ? node.childForFieldName("type")
      : node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0 || name.text !== routine) return;
    declared = true;
    const value = node.childForFieldName("value");
    if (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters")) {
      routines.push(node);
      return;
    }
    if (holdsRoutines(node)) routines.push(node);
  });
  const answer = { routines, declared, unreadable: false };
  found_.set(routine, answer);
  return answer;
}

/** Whether this declaration has a routine anywhere inside it. */
function holdsRoutines(node: Node): boolean {
  let found = false;
  each(node, (child) => {
    if (found || child.id === node.id) return;
    if (child.childForFieldName("parameters")) found = true;
  });
  return found;
}

/**
 * Which files a bound name could have come from.
 *
 * The binding says `crate::a::b::foo` or `./layout` or `flask.app.Flask`, and
 * `deps.ts` has already turned this file's specifiers into repo-relative files.
 * A dependency answers for a binding when its specifier names the binding or a
 * module above it -- which is what the three readers record and the only way
 * one entry for `crate::a::b` can answer for a name inside it.
 *
 * An empty result is a binding whose specifier resolved to nothing, which means
 * a module outside this repository. That is a definite answer -- the far end is
 * inside it -- and not a doubt.
 */
function filesFor(specifier: string, imports: CallSide["imports"]): { files: Set<string>; known: boolean } {
  const files = new Set<string>();
  let known = false;
  for (const one of imports) {
    if (!pathCovers(one.specifier, specifier) && !pathCovers(specifier, one.specifier)) continue;
    known = true;
    if (one.file) files.add(one.file);
  }
  return { files, known };
}

/**
 * How many files deep a forwarded name is followed.
 *
 * A re-export chain in real code is one hop -- `extract.py` passing on what
 * `extractors/objc.py` declares -- and three is well past anything measured.
 * The budget exists so a cycle of barrels cannot make one arrow expensive; it
 * runs out into a doubt, never into an answer.
 */
const FOLLOW_LIMIT = 3;

/**
 * Whether the name a file was asked for arrives at the far end.
 *
 * "yes" is the name declared there. "no" is a file that declares this name
 * itself and is not the far end -- a definite answer, which is what lets a
 * genuine name collision stay quiet instead of raising a doubt. Anything else
 * is "maybe", and the caller turns that into a refusal.
 */
function arrivesAt(
  name: string,
  file: string,
  side: CallSide,
  target: string,
  seen: Set<string>,
  depth = 0,
): "yes" | "no" | "maybe" {
  if (file === target) return "yes";
  if (seen.has(file) || depth >= FOLLOW_LIMIT) return "maybe";
  seen.add(file);

  const opened = side.open?.(file);
  if (!opened) return "maybe";
  const bindings = bindingsIn(opened.source, opened.language);
  if (!bindings) return "maybe";
  if (bindings.ambiguous.has(name)) return "maybe";

  const onward = bindings.imported.get(name) ?? bindings.forwarded.get(name);
  if (!onward) {
    // Declared right here, and here is not the far end. The one place a
    // forwarding search gets to say no.
    if (bindings.local.has(name) && !bindings.wildcard) return "no";
    /*
     * A barrel. `comesToRest` follows these to a unique answer and this only
     * ever looks for a **yes**: a wildcard whose targets do not lead to the
     * far end is not evidence that nothing does, because one of them may be
     * a package this reader cannot open. So the gain here is confirmations
     * (`@vue/shared` re-exporting `toRawType`, 20 arrows in one corpus that
     * came back `elsewhere`) and never a new way to say no.
     */
    for (const specifier of bindings.reExported) {
      const { files } = filesFor(specifier, opened.imports);
      for (const next of files) {
        if (arrivesAt(name, next, side, target, new Set(seen), depth + 1) === "yes") return "yes";
      }
    }
    return "maybe";
  }

  const { files } = filesFor(onward.specifier, opened.imports);
  if (files.has(target)) return "yes";
  if (files.size === 0) return "maybe";
  let maybe = false;
  for (const next of files) {
    // Under the far side's own spelling where the hop states one: a barrel
    // that writes `export { paint as render }` is passing on `paint` (#329).
    const answer = arrivesAt(onward.name ?? name, next, side, target, seen, depth + 1);
    if (answer === "yes") return "yes";
    if (answer === "maybe") maybe = true;
  }
  return maybe ? "maybe" : "no";
}

/**
 * Whether one call site is a call to a name declared in the far file.
 *
 * `undefined` is "no", with certainty. A reason is "maybe, and the text does not
 * say", which is the whole point of this file.
 */
function resolves(
  callee: Callee,
  side: CallSide,
  bindings: Bindings,
  target: { file: string; names: Set<string> },
): "yes" | CallsWithheld | undefined {
  if (callee.kind === "computed") return "computed";
  if (callee.kind === "bare" && REACHES_ANYTHING.has(callee.name)) return "dynamic";
  if (callee.kind === "through" && REACHES_ANYTHING.has(callee.name)) return "dynamic";
  /*
   * The gate: is this call even about the name being asked after? It is when
   * the call site spells it, and also when an import renamed it on the way in
   * -- `import { render as r }` makes `r()` a call to `render`, and comparing
   * only the spelling at the call site answered "not this one" to a call
   * written in plain sight (#329). Every grammar here has the form, so this
   * is one rule rather than a TypeScript exception.
   *
   * Only for a bare name. The alias in `import * as ns` renames the module,
   * and `ns.foo()` still calls whatever `foo` lives inside it.
   */
  const renamedTo = callee.kind === "bare" ? bindings.imported.get(callee.name)?.name : undefined;
  if (!target.names.has(callee.name) && !(renamedTo !== undefined && target.names.has(renamedTo))) {
    return undefined;
  }

  /*
   * A member of `self` is a member of whatever the routine belongs to, and that
   * is in this file. Same file, so the name is placed; a different file, and the
   * text says nothing about whose method it is.
   */
  if (callee.kind === "own") return side.file === target.file ? "yes" : "receiver";

  const bound = callee.kind === "through" ? callee.through : callee.name;
  if (!bound) return "receiver";
  if (bindings.ambiguous.has(bound)) return "ambiguous";

  const imported = bindings.imported.get(bound);
  if (!imported) {
    /*
     * Not imported. Declared here is an answer -- the call means this file's own
     * -- and anything else is a name from a wildcard import, a global or an
     * ambient declaration, which the text does not place.
     *
     * The two are told apart because they send a reader to different places. A
     * bare `foo()` naming nothing is `unbound`: something brought that name into
     * scope invisibly. `thing.foo()` where `thing` is an ordinary local is
     * `receiver`: the name is placed, and what it is a member *of* is a value
     * whose type is not in the text. That is dynamic dispatch, and it is the
     * first hazard #189 lists.
     */
    if (!bindings.local.has(bound)) return callee.kind === "through" ? "receiver" : "unbound";
    /*
     * `through` before same-file, and the order is the whole of it (#254). A
     * bare `add()` in a file that declares `add` is this file's own.
     * `seen.add(x)` is a method on `seen`, and this file declaring an `add` of
     * its own says nothing about it -- `seen` is a `Set`. Asking "same file?"
     * before "written on a receiver?" answered `yes` to both: a green nothing
     * earned, and in the reverse direction a `backwards` red on an arrow whose
     * two ends are one file. `measure:calls`' checker referee put six of these
     * to a real compiler and got a standard-library method back every time --
     * `Set.add` and `Response.json` here, `Path::parent`, `Command::arg` and
     * `Read::read_to_end` in ripgrep. `placeOf` below already asks in this
     * order, and its own doc says the two must match.
     */
    if (callee.kind === "through") return "receiver";
    return side.file === target.file ? "yes" : undefined;
  }

  const { files, known } = filesFor(imported.specifier, side.imports);
  if (files.has(target.file)) return "yes";
  /*
   * Imported from a module that resolved to no file here. A package, almost
   * always -- and sometimes a workspace alias that is inside the repository and
   * that `resolve.ts` cannot place. Nothing separates the two, so it withholds.
   */
  if (files.size === 0) return known ? "unplaced" : "unbound";

  // Resolved, and to somewhere else. Follow it: the file it landed on may be
  // passing the name on from the far end.
  let maybe = false;
  for (const file of files) {
    const answer = arrivesAt(imported.name ?? callee.name, file, side, target.file, new Set());
    if (answer === "yes") return "yes";
    if (answer === "maybe") maybe = true;
  }
  return maybe ? "elsewhere" : undefined;
}

/**
 * Every call one routine makes to the far end, and every reason to doubt the
 * answer if none was found.
 *
 * A confirmation needs one call site and nothing else. An absence needs the
 * whole body read without a doubt in it, which is the asymmetry the verdicts
 * below are built on.
 */
function callsTo(
  side: CallSide,
  routine: string,
  target: { file: string; names: Set<string> },
): { evidence?: CallsEvidence; why?: CallsWithheld } {
  const bindings = bindingsIn(side.source, side.language);
  if (!bindings) return { why: "unreadable" };

  const { routines, declared, unreadable } = routinesNamed(side.source, routine, side.language);
  if (unreadable) return { why: "unreadable" };
  if (routines.length === 0) return { why: declared ? "no-body" : "not-declared" };

  let why: CallsWithheld | undefined;
  for (const body of routines) {
    if (body.hasError) { why ??= "incomplete"; continue; }
    let found: CallsEvidence | undefined;
    each(body, (node) => {
      if (found) return;
      /*
       * A macro's arguments are loose tokens rather than a tree, so a call
       * written inside one is invisible. Only a doubt when the name being asked
       * after is somewhere in those tokens -- otherwise every `println!` in
       * Rust would silence every question.
       */
      if (node.type === "token_tree") {
        if ([...target.names].some((name) => new RegExp(`\\b${escapeName(name)}\\b`).test(node.text))) {
          why ??= "macro";
        }
        return;
      }
      const callee = calleeOf(node);
      if (!callee) return;
      const answer = resolves(callee, side, bindings, target);
      if (answer === undefined) return;
      if (answer === "yes") {
        found = {
          name: callee.kind === "computed" ? "" : callee.name,
          inside: routine,
          line: lineOf(side.source, node.startIndex),
          wrote: node.text.replace(/\s+/g, " ").slice(0, 80),
        };
        return;
      }
      why ??= answer;
    });
    if (found) return { evidence: found };
  }
  return why ? { why } : {};
}

/** A name, made safe to put in a pattern. Identifiers are tame; `$` is not. */
function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the tail calls the head, and whether the call runs the other way.
 *
 * `from.routine` is the one symbol the tail box stands for; `to.names` is every
 * symbol the head box stands for, and any one of them is enough -- the same
 * any-of-the-members rule the other checks use.
 *
 * The backwards question is asked by reading the head's own routines, so the
 * accusation rests on something found. It is refused unless **both** languages
 * carry a licence, and that is stricter than `constructs.ts`: half of a
 * backwards verdict is the absence in the forward direction, and an absence
 * read by a reader nobody has measured is not evidence of anything (#198).
 */
export function callsBetween(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
): CallsVerdict {
  const wanted = new Set(to.names);
  const forward = callsTo(from, from.routine, { file: to.file, names: wanted });
  if (forward.evidence) return { verdict: "confirmed", evidence: forward.evidence };
  /*
   * A doubt reading forwards was the end of it until #357: the text could not
   * see a call, so it could not say the call was absent. The Rust compiler's
   * list can -- a call inside a macro is in it -- so for a Rust tail it has,
   * the question goes on to the closed reading, which asks the compiler.
   */
  const compiled = forward.why ? compiledBodiesFor(from) : undefined;
  if (forward.why && !compiled) return { verdict: "withheld", why: forward.why };

  if (!mayAccuse("calls", from.language) || !mayAccuse("calls", to.language)) {
    return { verdict: "withheld", why: "unlicensed" };
  }
  /*
   * The text doubted the forward direction, so only the compiler may settle
   * it -- before `backwards` below, which main never reached past a doubt
   * and must not reach now on anything weaker than the compiler's "never".
   */
  if (compiled) {
    const settled = compiledVerdict(compiled, to);
    if ("why" in settled) return { verdict: "absent", notClosed: settled.why };
  }

  /*
   * Nothing found this way round. Before answering, ask whether it runs the
   * other way -- which is the only accusation this word is entitled to, and the
   * only one that rests on something found.
   *
   * A doubt on the way back is not a withheld verdict: the forward direction was
   * read cleanly, so the honest answer is that no call was found, which is
   * `absent` and is silence either way.
   */
  const back = { file: from.file, names: new Set([from.routine]) };
  for (const name of to.names) {
    const reverse = callsTo(to, name, back);
    if (reverse.evidence) return { verdict: "backwards", evidence: reverse.evidence };
  }

  /*
   * Still nothing found either way. Before falling through to silence, ask
   * the other question this word can now answer (#233): not "did the text
   * happen to show a call", but "did the tail's whole call set get read, and
   * is the head genuinely absent from it". That is a licence of its own --
   * `from.language` only, since the reading being closed is entirely about
   * `from`'s body and `to.file` is only ever compared as a string here, never
   * read.
   */
  if (!mayAccuse("calls", from.language, "absence")) {
    return { verdict: "absent", notClosed: "unlicensed" };
  }
  const closed = closedBodyRefutes(from, to, compiled);
  if ("reached" in closed) return { verdict: "wrong-routine", evidence: closed.reached };
  if ("evidence" in closed) return { verdict: "refuted", evidence: closed.evidence };
  return { verdict: "absent", notClosed: closed.why };
}

/**
 * Whether every call `from.routine` makes was read, resolved, and none of
 * them reaches `to.file` -- the closed-body absence `callsBetween` may now
 * accuse from (#233), independent of the backwards check above.
 *
 * A `why` for anything short of certain: an unreadable file, a routine
 * `callSitesIn` never saw, any call site left unplaced (an open body, exactly
 * as today), any placement landing at `to.file` (genuinely present, not this
 * word's business here), or any placed site whose receiver resolved to a
 * type that is not concrete (item 14's own caveat, docs/claim-vocabulary.md)
 * -- the one known way a closed reading can still be wrong, so it withholds
 * rather than accuses on the strength of one.
 *
 * It returns that `why` rather than a bare `undefined` (#324). Every one of
 * those five exits is a different piece of work to do, and collapsing them
 * into one absent answer is what left the ranking unbuildable: the caller
 * could see that the reading stopped and never which wall it hit.
 *
 * **The first wall wins, and the walk stops there.** A body with an
 * unresolvable receiver and a computed call is one arrow, counted once, under
 * whichever came first in the text. Counting every wall per body would say
 * more about how long the routine is than about what blocks it, and the
 * ranking this feeds is a ranking of arrows.
 *
 * `routinesNamed` allows more than one declaration to share a name (an
 * overload set); this asks the same question `callsTo` does, over all of
 * them, because "the routine has no call reaching `to`" is not established
 * until none of its declarations does.
 */
function closedBodyRefutes(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
  /** Already read by `callsBetween`, when it had to be. */
  known?: CompiledTail,
): { evidence: CallsRefutedEvidence } | { reached: CallsWrongRoutineEvidence } | { why: CallsNotClosed } {
  const text = textClosed(from, to);
  /*
   * Closed, and in Rust still not the end of it: every call the text wrote
   * was placed, and the head can run without being written as one (#357).
   * `a + b` runs `add`, `?` runs `from`, a scope's end runs `drop` -- and a
   * body can hand the head to `map` by name. Each of those went red on a
   * correct arrow once rust-analyzer could place everything else.
   */
  const closedByText = (): typeof text => {
    const unwritten = from.language === "rust" ? unwrittenRustCall(from, to) : undefined;
    return unwritten ? { why: unwritten } : text;
  };
  if (!("why" in text) && !known) return closedByText();
  /*
   * The text stopped, or the forward reading doubted before it got here
   * (`known`). For a Rust tail the compiler built, its list is the second
   * reading (#357) -- and only the second: where the text closes on its own
   * it keeps its verdict and its evidence, because it placed every call at a
   * file and the compiler's list names functions without saying whose they
   * are. After a forward doubt the compiler's "never" is required first.
   */
  const compiled = known ?? compiledBodiesFor(from);
  if (!compiled) return text;
  const verdict = compiledVerdict(compiled, to);
  if ("why" in verdict) return { why: verdict.why };
  if (!("why" in text)) return closedByText();
  const first = routinesNamed(from.source, from.routine, "rust").routines[0];
  return {
    evidence: {
      routine: from.routine,
      line: first ? lineOf(from.source, first.startIndex) : 1,
      sites: verdict.sites,
    },
  };
}

/** What the compiler's bodies say about the head: never, with how many calls, or why they cannot. `measure:compiled-calls` asks this too. */
export function compiledVerdict(
  compiled: CompiledTail,
  to: CallSide & { names: string[] },
): ReturnType<typeof compiledRefutes> {
  return compiledRefutes(compiled.bodies, {
    names: to.names,
    source: to.source,
    ownTrait: (written) => traitDeclaredHere(to, written),
  }, compiled.generics);
}

/** What `compiledBodiesFor` found: the bodies, and the type parameters in scope where they were declared. */
export interface CompiledTail {
  bodies: CompiledBody[];
  generics: Set<string>;
}

/**
 * How a Rust tail can reach the head without a call to it being written, on a
 * body whose written calls were all placed elsewhere (#357).
 *
 * `called-implicitly`  the head is a method of a trait this repository does
 *                      not declare -- `Add`, `From`, `Display`, `Drop`, a
 *                      library's trait. The language or the library runs
 *                      those on the caller's behalf, on values whose types
 *                      the text does not always write down: a field, a
 *                      `Result<T>` alias hiding the error type. A trait the
 *                      repository declares is only ever called by name.
 * `named`              the body names the head without calling it.
 */
function unwrittenRustCall(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
): "called-implicitly" | "named" | undefined {
  const names = new Set(to.names);
  if (traitImplsOf(to.source, names).some((one) => !traitDeclaredHere(to, one.trait))) return "called-implicitly";

  const reading = callSitesIn(from, from.routine);
  const called = new Set<number>();
  if (reading.read) {
    for (const body of reading.bodies) {
      if (body.routine !== from.routine) continue;
      for (const site of body.sites) if (site.nameAt) called.add(site.nameAt.start);
    }
  }
  let named = false;
  for (const routine of routinesNamed(from.source, from.routine, "rust").routines) {
    const body = routine.childForFieldName("body");
    if (!body) continue;
    each(body, (node) => {
      if (named || (node.type !== "identifier" && node.type !== "field_identifier")) return;
      if (names.has(node.text) && !called.has(node.startIndex)) named = true;
    });
  }
  return named ? "named" : undefined;
}

/**
 * Whether a trait an `impl` in `side` names is declared in this repository:
 * written from `crate::`, `self::` or `super::`, declared in the same file, or
 * imported from something `deps-rust.ts` resolved to a file here.
 */
function traitDeclaredHere(side: CallSide, written: string): boolean {
  const segments = written.split("::").map((one) => one.trim()).filter(Boolean);
  const first = segments[0];
  if (!first) return false;
  if (first === "crate" || first === "self" || first === "super") return true;
  if (segments.length === 1 && new RegExp(`\\btrait\\s+${escapeName(first)}\\b`).test(side.source)) return true;
  const binding = bindingsIn(side.source, side.language)?.imported.get(first);
  if (!binding) return false;
  return side.imports.some((one) => one.specifier === binding.specifier && one.file !== undefined);
}

/**
 * The Rust compiler's bodies for the tail's routine, or `undefined` when it
 * has none to offer or they cannot be trusted (#357).
 *
 * Trusted means one more thing than found: every call the text reading saw
 * in the routine is in them by name. That is the check that the body matched
 * is the routine the board means, and that the build compiled the code the
 * text shows -- a call switched off by a setting `compiledBodiesOf` did not
 * catch, or inlined away, fails it. Calls inside a macro are not in the text
 * reading, so they cannot fail it; that is what the compiler is here to add.
 */
export function compiledBodiesFor(from: CallSide & { routine: string }): CompiledTail | undefined {
  if (from.language !== "rust" || !from.compiled) return undefined;
  const crate = from.compiled();
  if (!crate) return undefined;
  const reading = compiledBodiesOf(crate, from.file, from.source, from.routine);
  if (!("bodies" in reading)) return undefined;
  const seen = callSitesIn(from, from.routine);
  if (!seen.read) return undefined;
  for (const body of seen.bodies) {
    if (body.routine !== from.routine) continue;
    for (const site of body.sites) {
      if (site.name === "" || site.why === "macro") continue;
      // `ok!(..)` is read as a call to `ok`; what rustc lists is what it expands to.
      if (site.nameAt && from.source[site.nameAt.end] === "!") continue;
      if (!reading.bodies.some((compiled) => compiled.words.has(site.name))) return undefined;
    }
  }
  return { bodies: reading.bodies, generics: reading.generics };
}

/** `closedBodyRefutes` as it was before #357: the text reading alone. */
function textClosed(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
): { evidence: CallsRefutedEvidence } | { reached: CallsWrongRoutineEvidence } | { why: CallsNotClosed } {
  const reading = callSitesIn(from);
  if (!reading.read) return { why: "unreadable" };
  const bodies = reading.bodies.filter((body) => body.routine === from.routine);
  if (bodies.length === 0) return { why: "routine-not-found" };

  let sites = 0;
  const reached: Array<{ name: string; line: number }> = [];
  for (const body of bodies) {
    for (const site of body.sites) {
      // Open: something unplaced, and the site says what stopped it.
      if (site.file === undefined) return { why: site.why ?? "unplaced" };
      /*
       * `concrete` is only ever set by a checker's answer, and since #353 an
       * `own` call the class does not declare is put to one too -- a
       * `self.callback()` lands on an attribute, which runs whatever was put
       * there. So the guard is on the answer, not on how the call was spelt.
       */
      if (site.concrete === false) return { why: "abstract-receiver" };
      if (site.overridden) return { why: "overridden" };
      if (site.file === to.file) {
        /*
         * The near miss (#329). Three ways this can go, and only one of them
         * is an accusation:
         *
         *   the resting name is one of the head's  the call is the arrow's
         *                                          own, however it was spelt
         *                                          at the call site -- present,
         *                                          and not this word's business
         *   the resting name was never read        the text does not say what
         *                                          this reaches, so neither
         *                                          does this reader
         *   a different routine, named             the thing worth saying
         */
        if (site.declaredAs === undefined) return { why: "reaches-the-file" };
        if (to.names.includes(site.declaredAs)) return { why: "reaches-the-file" };
        /*
         * And the head's file has to actually declare a routine by that name
         * (#329's measurement). `measure:wrong-routine` put every placed name
         * to a real compiler over `.corpus`: the *name* was never wrong, and
         * the **file** was wrong 43 times in ~2,700 -- always the same two
         * shapes, an inherited method placed at the subclass's file
         * (`subscribe` at `focusManager.ts`, declared in `subscribable.ts`)
         * and a standard-library method placed at the file its receiver came
         * from (`find` at `mutation.ts`, declared in `lib.es2015.core.d.ts`).
         *
         * The arrow is still not calling the head in either case, so the
         * verdict would survive. The *sentence* would not: it would name a
         * routine to point the arrow at that is not in that file at all. An
         * accusation whose advice is fiction is not an accusation worth
         * making, so the reader keeps its silence unless it read the
         * declaration it is about to name.
         */
        if (!isRoutine(to.source, site.declaredAs, to.language)) return { why: "reaches-the-file" };
        reached.push({ name: site.declaredAs, line: site.line });
      }
      sites += 1;
    }
  }
  if (reached.length === 0) {
    return { evidence: { routine: from.routine, line: bodies[0]!.line, sites } };
  }
  /*
   * An arrow drawn at a **type** is a different mistake and not this one
   * (#324 counts it separately). `Renderer.paint()` reaches the Renderer box
   * by any ordinary reading, and only something that runs can be called -- so
   * a near miss is only a near miss when every name the head stands for is
   * itself a routine in that file.
   */
  if (!to.names.every((name) => isRoutine(to.source, name, to.language))) {
    return { why: "reaches-the-file" };
  }
  return { reached: { routine: from.routine, line: bodies[0]!.line, sites, reached } };
}

/**
 * Whether a name is declared as something that runs, rather than as a type
 * that has running things inside it.
 *
 * `routinesNamed` deliberately answers yes for a class or an `impl` block,
 * because a box drawn at a type is asked about through its methods. This asks
 * the narrower question #329 needs: the declaration itself takes parameters.
 * The test is `parse.ts`'s own -- a routine is a declaration with a
 * `parameters` field, in every grammar here -- rather than a list of node
 * names one language spells differently.
 */
function isRoutine(source: string, name: string, language: Language): boolean {
  const { routines } = routinesNamed(source, name, language);
  return routines.some((node) => Boolean(
    node.childForFieldName("parameters")
    ?? node.childForFieldName("value")?.childForFieldName("parameters"),
  ));
}

/* ------------------------------------------- one body's call sites (#217) */

/**
 * Why one call site could not be placed. The same vocabulary `resolves` uses.
 *
 * Deliberately the same words rather than a private set: the question below is
 * a different question asked of the same reader, and a reason that does not
 * appear in `CallsWithheld` would be a reason `@calls` could never report.
 */
export type SiteUnresolved = Extract<
  CallsWithheld,
  "computed" | "dynamic" | "receiver" | "unbound" | "local-callee" | "ambiguous" | "unplaced"
  | "elsewhere" | "macro"
>;

/** One call written in a body, and whether the reader can say what it reaches. */
export interface CallSitePlaced {
  /** The callee as written, empty when the name is not in the text. */
  name: string;
  /** 1-based, in the file the call was written in. */
  line: number;
  /** The file the callee was placed in, when it was placed. */
  file?: string;
  /** Why it was not placed. Absent exactly when `file` is present. */
  why?: SiteUnresolved;
  /**
   * Whether this call went through `resolveReceiver` at all -- `x.foo()`,
   * not a bare `foo()`. Without this, a `why` tally cannot be checked
   * against what a resolver actually answered: a bare unimported call and a
   * receiver call land in the same `unbound`/`unplaced` buckets, and
   * comparing a resolver's own query count against the combined bucket
   * always looks like a huge unexplained gap that is really just the wrong
   * population being compared.
   */
  receiver: boolean;
  /**
   * The method name's own byte range -- `foo` in `x.foo()` -- present
   * exactly when `receiver` is true. Lets a caller ask an independent
   * checker what the call itself resolves to, separately from how this
   * reader placed it: the safety measurement a `receiver`-based verdict
   * needs before anything may accuse on the strength of one.
   */
  memberAt?: { start: number; end: number };
  /**
   * The called name's own byte range -- `paint` in `paint()`, `x.paint()` and
   * `this.paint()` alike -- and absent for a computed call, whose name is not
   * in the text. Equal to `memberAt` on a receiver call.
   *
   * `@accesses` (#255) stays quiet when a function the body calls reads the
   * member, and finding that function means asking a checker "go to
   * definition" here. #254's measurement had only `memberAt`, so for a bare
   * call it searched the line again with a regex; the tree already had the
   * node.
   */
  nameAt?: { start: number; end: number };
  /**
   * The name the callee is declared under **where it comes to rest** -- the
   * far side's own spelling, not the one written at the call site (#329).
   *
   * `import { render as r }` and `r()` gives `render` here. So does a
   * re-export that renames on the way through. Present only where a
   * declaration was actually read at the resting file; a file nobody could
   * open, a specifier placed without finding the declaration, or an import
   * form that names the far side nothing (a default import) all leave it
   * unsaid, because the honest answer there is that the text does not say.
   *
   * The distinction is the whole of #329: a call placed in the head's file
   * is either the arrow's routine under another spelling -- which is a
   * correct arrow -- or a different routine that happens to live next door,
   * which is a wrong one. Without this they are one answer.
   */
  declaredAs?: string;
  /**
   * Whether this site's `file` came from a `resolveReceiver` answer whose
   * type is a concrete class -- `false` for an interface, an abstract class,
   * or a bare type parameter, `undefined` when the placement did not go
   * through that question at all (a bare name, an ordinary import, `external`,
   * the weaker `type`-name fallback).
   *
   * #233's guard: a closed-body absence accusation may not rest on any site
   * where this is `false`, because the file the type is declared in is not
   * necessarily the file the method actually reached at runtime lives in
   * (docs/claim-vocabulary.md item 14's own caveat).
   */
  concrete?: boolean;
  /**
   * The method this site was placed at is declared again by a class deriving
   * from the one holding it (#353), so the placement names one place the call
   * can run and not the only one. The same guard as `concrete: false`, for a
   * plain base class rather than an interface.
   */
  overridden?: boolean;
}

/** Every call site in one routine, placed or refused. */
export interface BodyCallSites {
  routine: string;
  /** 1-based line the routine opens on. */
  line: number;
  /** Lines the routine spans, so a report can weigh a closure by body size. */
  lines: number;
  sites: CallSitePlaced[];
}

export type CallSitesReading =
  | { read: true; bodies: BodyCallSites[] }
  | { read: false; why: Extract<CallsWithheld, "unreadable"> };

/**
 * Whether a forwarded name comes to rest on a file that declares it.
 *
 * `arrivesAt` asks whether a name reaches **one named** far end, which is the
 * question a claim asks. This asks the target-free version -- does it come to
 * rest anywhere at all -- and it is the stricter half of the closure question:
 * a barrel file that re-exports a name places the *specifier* without placing
 * the *declaration*, and counting that as placed would make a call set look
 * enumerable when the reader cannot name what is in it.
 *
 * Same budget as `arrivesAt` and the same shape of answer, so a chain of
 * barrels runs out into a doubt rather than into a claim.
 */
function comesToRest(
  name: string,
  file: string,
  side: CallSide,
  seen: Set<string>,
  depth = 0,
): Rest | undefined {
  if (seen.has(file) || depth >= FOLLOW_LIMIT) return undefined;
  seen.add(file);

  const opened = side.open?.(file);
  /*
   * No opener, so the specifier is placed and what is in that file is unknown.
   * Counted as placed: this reader's own `resolves` treats a resolved specifier
   * as an answer, and being stricter here than the word itself would measure
   * something `@calls` does not do.
   *
   * Placed, and `as` left unsaid: a file nobody opened cannot say what it
   * calls the thing (#329).
   */
  if (!opened) return { file };
  const bindings = bindingsIn(opened.source, opened.language);
  if (!bindings) return { file };
  if (bindings.ambiguous.has(name)) return undefined;
  // Declared right here, under this name. The one branch that can say what
  // the far end calls it, because it read the declaration.
  if (bindings.local.has(name)) return { file, as: name };

  const onward = bindings.imported.get(name) ?? bindings.forwarded.get(name);
  if (!onward) {
    if (bindings.reExported.length > 0) {
      return throughWildcards(name, bindings, opened.imports, side, seen, depth);
    }
    /*
     * The permissive step, and it stays permissive about the *file* only. This
     * file neither declares the name nor forwards it and is still counted as
     * the resting place, which is right for a specifier somebody wrote down --
     * but nothing here read a declaration, so the name goes unsaid.
     */
    return bindings.wildcard ? undefined : { file };
  }

  const { files } = filesFor(onward.specifier, opened.imports);
  if (files.size === 0) return undefined;
  for (const next of files) {
    const rest = comesToRest(onward.name ?? name, next, side, seen, depth + 1);
    if (!rest) continue;
    /*
     * A hop that did not say what the far side calls it was followed under
     * the name this side uses, which is a guess about the spelling and not
     * about the file. The file stands; the name is dropped.
     */
    return onward.name ? rest : { file: rest.file };
  }
  return undefined;
}

/**
 * `comesToRest` with its one permissive step taken out.
 *
 * That step -- a file that does not declare the name and forwards nothing
 * still counting as the resting place -- is right for a specifier somebody
 * wrote down, and wrong for a wildcard's targets. A barrel re-exporting seven
 * modules would have every one of them answer with itself, so the uniqueness
 * rule below would see seven different answers and always refuse. Here a file
 * answers only if it actually declares the name or forwards it onward.
 */
function declaresOrForwards(
  name: string,
  file: string,
  side: CallSide,
  seen: Set<string>,
  depth: number,
): Rest | undefined {
  if (seen.has(file) || depth >= FOLLOW_LIMIT) return undefined;
  seen.add(file);
  const opened = side.open?.(file);
  if (!opened) return undefined;
  const bindings = bindingsIn(opened.source, opened.language);
  if (!bindings) return undefined;
  if (bindings.ambiguous.has(name)) return undefined;
  if (bindings.local.has(name)) return { file, as: name };
  const onward = bindings.imported.get(name) ?? bindings.forwarded.get(name);
  if (onward) {
    const { files } = filesFor(onward.specifier, opened.imports);
    for (const next of files) {
      const rest = declaresOrForwards(onward.name ?? name, next, side, new Set(seen), depth + 1);
      if (!rest) continue;
      return onward.name ? rest : { file: rest.file };
    }
    return undefined;
  }
  if (bindings.reExported.length > 0) {
    return throughWildcards(name, bindings, opened.imports, side, seen, depth);
  }
  return undefined;
}

/**
 * Where a wildcard re-export puts a name, when exactly one of its targets has
 * it.
 *
 * The whole value of this is in the word *exactly*. A barrel's job is to
 * present several modules as one, and the name being asked after is declared
 * in one of them -- so the answer is there in the text, and refusing to look
 * was a doubt about something written down. What is not written down is which
 * one, so:
 *
 *   - every target must resolve to a file this reader can open. One that does
 *     not could be the one declaring the name, and the answer is a doubt.
 *   - the name must come to rest in one place. Two targets declaring it is a
 *     collision the text does not settle, and a doubt is the honest answer --
 *     the same rule `ambiguous` already applies one level up.
 *
 * Each target is followed with a fresh `seen`, because these are siblings
 * rather than a chain: one barrel re-exporting seven modules is one hop, and
 * sharing a visited set between them made the seventh look like a
 * seven-deep chain and run out of budget.
 */
function throughWildcards(
  name: string,
  bindings: Bindings,
  imports: CallSide["imports"],
  side: CallSide,
  seen: Set<string>,
  depth: number,
): Rest | undefined {
  let answer: Rest | undefined;
  for (const specifier of bindings.reExported) {
    const { files } = filesFor(specifier, imports);
    if (files.size === 0) return undefined;
    for (const next of files) {
      const rest = declaresOrForwards(name, next, side, new Set(seen), depth + 1);
      if (!rest) continue;
      if (answer !== undefined && answer.file !== rest.file) return undefined;
      answer = rest;
    }
  }
  return answer;
}

/** Where one call site's callee lives, when it can be placed at all. */
export type Placement = { file: string; concrete?: boolean; as?: string; overridden?: boolean };

/**
 * A name's resting place: the file it settles in, and what that file calls it.
 *
 * `as` is present only where a declaration was actually read there (#329).
 * Every other way of arriving -- a file nobody could open, the permissive
 * step that counts a resolved specifier as placed without finding the
 * declaration, a hop whose grammar states no far-side name -- places the file
 * and says nothing about the spelling, because nothing read one.
 */
type Rest = { file: string; as?: string };

/**
 * `placeOf`'s local/imported/comesToRest lookup, factored out so a type name a
 * resolver hands back gets placed by the exact same rule a value name would be.
 *
 * Exported because `constructs.ts` asks the same question of a different thing
 * (#309): in Python `Response(body)` and `render(body)` are one syntax, and what
 * separates them is which file the name comes to rest in and what that file
 * declares it as. The same rule rather than a second copy of it -- a name placed
 * one way for `@calls` and another way for `@builds` is two readers that have to
 * agree and silently would not.
 */
export function placeName(name: string, side: CallSide, bindings: Bindings): Placement | { why: SiteUnresolved } {
  if (bindings.ambiguous.has(name)) return { why: "ambiguous" };
  const imported = bindings.imported.get(name);
  // Declared in this file, under the name written here: nothing renames a
  // name on its way into its own file.
  if (!imported) return bindings.local.has(name) ? { file: side.file, as: name } : { why: "unbound" };
  const { files, known } = filesFor(imported.specifier, side.imports);
  if (files.size === 0) return { why: known ? "unplaced" : "unbound" };
  // Followed under the name the *import* gives it, which is the far side's
  // spelling wherever the grammar wrote one down (#329).
  const settled = settlesOn(imported.name ?? name, files, side);
  return settled ? settled : { why: "elsewhere" };
}

/**
 * Which of a specifier's candidate files a name actually comes to rest in.
 *
 * One specifier can resolve to more than one file, and Rust is where it
 * happens: `crate::codec::encode` is recorded against both the file that
 * declares `mod codec` and `codec.rs` itself. `comesToRest` ends with a
 * permissive step -- a file that neither declares the name nor forwards it is
 * still counted as the resting place, which is right for a specifier somebody
 * wrote down and wrong as a tie-break. Taken in order, the first candidate
 * won on that fallback: `encode` was placed in `main.rs`, which declares no
 * `encode` at all, and the walk in `reach.ts` then stepped into a file with
 * nothing of that name in it and stopped.
 *
 * So the candidates are asked the strict question first -- does this file
 * declare the name, or forward it somewhere that does -- and only if none of
 * them does is the permissive answer taken, in the original order. A single
 * candidate is unaffected either way, which is every TypeScript and Python
 * import in the corpus.
 */
function settlesOn(name: string, files: Set<string>, side: CallSide): Rest | undefined {
  if (files.size > 1) {
    for (const file of files) {
      const declares = declaresOrForwards(name, file, side, new Set(), 0);
      if (declares) return declares;
    }
  }
  for (const file of files) {
    const rest = comesToRest(name, file, side, new Set());
    if (rest) return rest;
  }
  return undefined;
}

/**
 * The file a call is placed at when a resolver can say for certain the
 * receiver's type is declared outside this repository. Never a real path --
 * nothing on disk is named this -- and never read by `resolves`/`callsTo`,
 * so it can never be compared against a claim's own target file. Its only
 * job is to make a body's `blocking` filter (`callSitesIn`) see a placed
 * site rather than a `why`, which is the one thing "provably not a repo
 * routine" and "known to be this repo routine" have in common: neither one
 * leaves the call's destination in doubt.
 *
 * Exported so a safety measurement can tell this placement apart from a
 * real file without hardcoding the string a second time.
 */
export const EXTERNAL_RECEIVER = "<external-to-repository>";

/**
 * `receiver`'s narrower answer, when a caller supplied one. `side.resolveReceiver`
 * is asked for the receiver's type at its exact range: a named type is placed by
 * `placeName`, exactly as a bare name would be; a resolver that instead says the
 * type's own declaration lives outside the repository is placed immediately, with
 * no name match attempted. `undefined` -- no resolver, no range, or the resolver
 * had nothing to say -- leaves the caller to fall back to the plain `receiver`
 * refusal this reader always had.
 */
function placeThroughChecker(
  at: { start: number; end: number } | undefined,
  side: CallSide,
  bindings: Bindings,
): Placement | { why: SiteUnresolved } | undefined {
  if (!at || !side.resolveReceiver) return undefined;
  const resolved = side.resolveReceiver(at);
  if (!resolved) return undefined;
  if (resolved.kind === "external") return { file: EXTERNAL_RECEIVER };
  if (resolved.kind === "declared") return { file: resolved.file, concrete: resolved.concrete };
  return placeName(resolved.name, side, bindings);
}

/**
 * Where a checker's "go to definition" at the call's own name puts it (#351),
 * or `undefined` when that says nothing a verdict may rest on.
 *
 * Outside the repository settles the site. Inside it, the answer is a file
 * and a line, placed there with the checker's own word on whether the call
 * runs there (`concrete`) -- each language's rule, applied where the
 * definition is read (`referee-ts.ts`, `referee-python.ts`,
 * `referee-rust.ts`). Nobody saying counts as `false`, so the closed-body
 * check withholds rather than accuses on it.
 *
 * The name it rests under is the routine declared on that line, when one is;
 * the near-miss verdict names it (#329), and a line holding no routine names
 * nothing.
 *
 * And a method a subclass declares again is marked so (#353). A checker's
 * "runs there" is about the declaration it landed on -- a body, not an
 * interface's signature -- and says nothing about a class deriving from its
 * holder, which is what runs whenever the value is one.
 */
function placeThroughDefinition(
  memberAt: { start: number; end: number },
  side: CallSide,
): Placement | undefined {
  const found = side.declarationAt?.(memberAt);
  if (!found) return undefined;
  if (found === "outside") return { file: EXTERNAL_RECEIVER };
  const there = found.file === side.file ? side : side.open?.(found.file);
  const landed = there ? routineDeclaredOn(there.source, there.language, found.line) : undefined;
  return {
    file: found.file,
    concrete: found.concrete ?? false,
    ...(landed ? { as: landed.name } : {}),
    ...(landed?.holder && overriddenBelow(landed.holder, landed.name, side) ? { overridden: true } : {}),
  };
}

/**
 * Whether a class deriving from `holder` declares `member` again, by the
 * side's `overridden` (#353). Only a holder that is a class by structure --
 * named, and not itself a routine -- has anything deriving from it; a
 * function nested in another is not one.
 */
function overriddenBelow(holder: Node, member: string, side: CallSide): boolean {
  if (!side.overridden || holder.childForFieldName("parameters")) return false;
  const name = holder.childForFieldName("name");
  if (!name || name.childCount !== 0) return false;
  return side.overridden(name.text, member);
}

/**
 * The routine with a body whose name is written on `line` (1-based), by the
 * same test `callSitesIn` finds bodies with -- a name, parameters, a body --
 * and the declaration holding it, if any (#351).
 *
 * The name's line, because that is the line every checker here reports a
 * definition at; the line a declaration *opens* on can be a decorator's.
 *
 * `holder` is the nearest enclosing node that is itself a declaration -- one
 * with a `name` or a `type` field, the class, `impl` or trait around a method
 * -- and `undefined` for a routine at the top of its file. What a holder
 * means for where a call runs is each language's own rule, which is why this
 * returns the node rather than a verdict.
 */
export function routineDeclaredOn(
  source: string,
  language: Language,
  line: number,
): { name: string; node: Node; holder?: Node } | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  const isDeclaration = (node: Node) => Boolean(node.childForFieldName("name") ?? node.childForFieldName("type"));
  const visit = (node: Node, holder: Node | undefined): { name: string; node: Node; holder?: Node } | undefined => {
    const name = node.childForFieldName("name") ?? node.childForFieldName("left");
    const value = node.childForFieldName("value");
    if (
      name && name.childCount === 0
      && (node.childForFieldName("parameters") ?? value?.childForFieldName("parameters"))
      && (node.childForFieldName("body") ?? value?.childForFieldName("body"))
      && lineOf(source, name.startIndex) === line
    ) {
      return { name: name.text, node, ...(holder ? { holder } : {}) };
    }
    const inside = isDeclaration(node) ? node : holder;
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      const found = child ? visit(child, inside) : undefined;
      if (found) return found;
    }
    return undefined;
  };
  return visit(tree.rootNode, undefined);
}

/**
 * Where `self.foo()` / `this.foo()` runs (#353).
 *
 * A member of `self` is a member of whatever the routine belongs to, and
 * that used to be the whole rule: this file, under the name written on it.
 * It is right only when the class declares `foo` itself and nothing deriving
 * from it declares `foo` again, and each half had a correct arrow going red:
 *
 *   `foo` declared by a subclass too   a base class calling its own hook
 *                                      runs the subclass's -- marked
 *                                      `overridden`, which withholds
 *   `foo` not declared here at all     inherited from a base, or a value
 *                                      set on the instance: it runs in
 *                                      some other file. Put to "go to
 *                                      definition" where the caller offers
 *                                      it, as a `through` call is, and a
 *                                      `receiver` doubt where it does not
 *
 * Rust keeps the old rule inside an `impl`, which nothing can override. A
 * trait's default method is the one place Rust has the hazard: `self.foo()`
 * there runs whatever each implementation says `foo` is.
 *
 * With no holder -- a routine at the top of its file, a method of an object
 * literal -- there is no class to judge by, and the old rule stands.
 */
function placeOwn(
  callee: Extract<Callee, { kind: "own" }>,
  side: CallSide,
  holder: Node | undefined,
): Placement | { why: SiteUnresolved } {
  const here: Placement = { file: side.file, as: callee.name };
  if (!holder) return here;
  if (side.language === "rust") return holder.childForFieldName("type") ? here : { ...here, overridden: true };
  if (!declaresMember(holder, callee.name)) {
    return (side.declarationAt ? placeThroughDefinition(callee.nameAt, side) : undefined) ?? { why: "receiver" };
  }
  return overriddenBelow(holder, callee.name, side) ? { ...here, overridden: true } : here;
}

/**
 * Where one call site's callee lives, or why the reader cannot say.
 *
 * The target-free twin of `resolves`, and every branch below is the same branch
 * in the same order -- the reasons have to match, or a body counted closed here
 * would be a body `@calls` still refuses on. `resolves`/`callsTo` never calls
 * `placeThroughChecker`: a resolver only narrows what this function reports,
 * never what the live `@calls` word does.
 */
function placeOf(
  callee: Callee,
  side: CallSide,
  bindings: Bindings,
  /**
   * The names the enclosing routine binds -- `boundByRoutine`. Optional, and
   * absent only where there is no routine to ask: `resolves` answers per ask
   * and never holds a body node. A site left `unbound` there rather than
   * `local-callee` reports the same openness under a coarser word, which is
   * the one asymmetry between the two readers and is why it is written down.
   */
  scope?: ReadonlySet<string>,
  /**
   * The class, `impl` or trait the enclosing routine is a member of --
   * `holdersIn` -- for an `own` call to be judged against (#353). Absent
   * where there is no routine to ask, as `scope` is.
   */
  holder?: Node,
): Placement | { why: SiteUnresolved } {
  if (callee.kind === "computed") return { why: "computed" };
  if (REACHES_ANYTHING.has(callee.name)) return { why: "dynamic" };

  if (callee.kind === "own") return placeOwn(callee, side, holder);

  const bound = callee.kind === "through" ? callee.through : callee.name;
  const at = callee.kind === "through" ? callee.at : undefined;
  /*
   * A resolver is only ever a fallback for a `through` callee -- `bare` and
   * `own` calls have no receiver expression for one to be asked about.
   *
   * The resolver answers about the **receiver**, so the file it hands back is
   * where the receiver's type lives and the name reached there is the member
   * as written: `x.paint()` is a call to `paint`, whatever `x` turned out to
   * be. A placement's own `as` here would be the type's name, which is a
   * different question, so it is replaced rather than passed on (#329).
   */
  const throughChecker = (): { why: SiteUnresolved } | Placement => {
    /*
     * "Go to definition" instead of the receiver's type where the caller
     * offers it (#351), and no second question when it has no answer. The
     * receiver's answer is the one that placed `strat.search()` on an
     * `Arc<dyn Strategy>` outside the repository, because `Arc` is; asked as
     * a fallback on the bench it placed nothing the definition had not, and
     * doubled what the first pass asks a language server.
     */
    if (side.declarationAt && callee.kind === "through") {
      return placeThroughDefinition(callee.memberAt, side) ?? { why: "receiver" };
    }
    const placed = placeThroughChecker(at, side, bindings);
    if (!placed) return { why: "receiver" };
    return "file" in placed ? { ...placed, as: callee.name } : placed;
  };

  // An expression receiver -- `make().run()`, `a.b.c()` -- names nothing to
  // look up. Dynamic dispatch, and the reader cannot say whose method it is --
  // unless a resolver can, from the expression itself rather than its name.
  if (!bound) return throughChecker();
  if (bindings.ambiguous.has(bound)) {
    // Ambiguous as a *value* name (declared twice over) does not mean the
    // resolver is confused -- it asked the compiler at one exact position,
    // which binding governs there is not in doubt for it the way it is for
    // a linear text read.
    return callee.kind === "through" ? throughChecker() : { why: "ambiguous" };
  }

  const imported = bindings.imported.get(bound);
  /*
   * `x.foo()` where `x` happens to be imported: only a question about
   * `imported.specifier`'s own file when `x` is a *namespace* import
   * (`import * as x`) -- `foo` genuinely is a member of that module then.
   * An ordinary named import (`import { x }`) used as a receiver is a
   * method call on a value, never a namespace access, whatever file `x`
   * itself came from happens to declare under the name `foo`. Treating the
   * two the same is how this measurement's own safety check (#226) caught
   * `PUNCTUATION.has(...)` -- `PUNCTUATION`, a `Set` imported by name --
   * "placed" at the file `PUNCTUATION` comes from: `comesToRest` found no
   * `has` declared there, found no wildcard either, and its own permissive
   * "probably declared there anyway" fallback answered instead of refusing.
   * That fallback is right for a genuine namespace; it was never asked
   * whether this was one.
   */
  if (imported && callee.kind === "through" && !imported.namespace) return throughChecker();
  if (!imported) {
    if (!bindings.local.has(bound)) {
      if (callee.kind !== "through") {
        /*
         * The routine's own binding first: a parameter or a local holds a
         * *value*, and `unbound` would send a reader looking for an import
         * that is not missing (#337).
         */
        if (scope?.has(bound)) return { why: "local-callee" };
        /*
         * Before the doubt: is this a name the *language* put here (#337)?
         * `isinstance`, `Number`, `Ok` -- nothing imported them because
         * nothing has to, and there is no file in any repository they could
         * reach. Placed outside the repository, which lets a body close and
         * can never be what an arrow reaches.
         *
         * Not while a wildcard import is in the file. That brings in names
         * nothing can enumerate, one of which may be a `list` of the
         * repository's own, and which one the call means is then not in the
         * text -- the doubt `throughWildcards` already refuses on.
         */
        if (!bindings.wildcard && providedByLanguage(bound, side.language)) {
          return { file: EXTERNAL_RECEIVER };
        }
        return { why: "unbound" };
      }
      return throughChecker();
    }
    /*
     * Declared here. A bare name means this file's own; a member reached
     * *through* a local value is that value's method, and its type is not in
     * the text even though the name it is bound to is -- unless a resolver
     * says what it is.
     */
    if (callee.kind !== "through") return { file: side.file, as: callee.name };
    return throughChecker();
  }

  const { files, known } = filesFor(imported.specifier, side.imports);
  if (files.size === 0) {
    // `bound` reads as a namespace/module import whose specifier did not
    // resolve -- correct for `ns.foo()`, and not the last word for a
    // `through` callee: `bound` naming an import is not proof the receiver
    // is a namespace rather than an ordinary value that merely shares its
    // name with one, and a resolver answers the value question directly.
    if (callee.kind === "through") return throughChecker();
    return { why: known ? "unplaced" : "unbound" };
  }
  /*
   * Followed under the far side's own spelling for a bare call -- `import
   * { render as r }` and `r()` is a call to `render` over there (#329). A
   * member reached through a namespace keeps its own name: the alias in
   * `import * as ns` renames the module, never what is inside it.
   */
  const under = callee.kind === "through" ? callee.name : imported.name ?? callee.name;
  const settled = settlesOn(under, files, side);
  if (settled) return settled;
  return callee.kind === "through" ? throughChecker() : { why: "elsewhere" };
}

/**
 * Every call site in every routine of one file, each placed or refused.
 *
 * **A measurement, not a word (#217).** `callsBetween` asks whether one body
 * calls one named far end, and reports its doubts per *ask*. This asks the
 * question the other way round -- what does this body call, all of it -- because
 * that is the question a closed region needs. A body with no unplaced call site
 * has an enumerable call set, and only then does "this routine does not call
 * that one" become refutable from an absence rather than silence.
 *
 * Nothing consumes this but `scripts/measure-closed-bodies.mts`. It puts no
 * colour on a diagram and no word rests on it.
 */
export function callSitesIn(side: CallSide, only?: string): CallSitesReading {
  const bindings = bindingsIn(side.source, side.language);
  if (!bindings) return { read: false, why: "unreadable" };
  const tree = parseSource(side.source, side.language);
  if (!tree) return { read: false, why: "unreadable" };

  const bodies: BodyCallSites[] = [];
  /** Which class each routine is a member of (#353), read on the first body that is placed. */
  let holders: Map<number, Node> | undefined;
  each(tree.rootNode, (node) => {
    const name = node.type === "impl_item"
      ? node.childForFieldName("type")
      : node.childForFieldName("name") ?? node.childForFieldName("left");
    if (!name || name.childCount !== 0) return;
    const value = node.childForFieldName("value");
    /*
     * `parameters` is the test `routinesNamed` uses, and using the same one is
     * the point: the population here has to be the population `@calls` would be
     * asked about. An `impl` block passes `holdsRoutines` there and is not a
     * body, so it is left out -- its methods are found on their own.
     */
    if (!(node.childForFieldName("parameters") ?? value?.childForFieldName("parameters"))) return;
    /*
     * And it must actually have a body. A method *signature* -- in a TS
     * interface, a Rust trait, an overload declaration -- has parameters and no
     * body, and counting one is not a small error: it reads as a routine that
     * makes no calls, so it lands in the trivially-closed column and inflates
     * the very number this is here to measure. `board-server.ts` alone declared
     * `setFile` and `close` twice that way. The referee found it.
     */
    if (!(node.childForFieldName("body") ?? value?.childForFieldName("body"))) return;

    const opened = lineOf(side.source, node.startIndex);
    const body: BodyCallSites = {
      routine: name.text,
      line: opened,
      lines: node.text.split("\n").length,
      sites: [],
    };
    /*
     * `only` names the one routine whose sites are wanted, and the rest are
     * listed without being placed (#reach).
     *
     * Placing a site is where a receiver reaches a real checker, and a
     * language server answers one question at a time over a pipe. The
     * cross-file walk reads whole *files* and needs one *body* out of each,
     * so placing all of them made two arrows over a handful of Flask modules
     * 212 questions and twenty-eight seconds -- for perhaps thirty that were
     * on the route. The walk asks for what it is about to read and lists the
     * rest, which is all it needs them for: mapping a definition's line to
     * the routine holding it, and finding whether a file declares a name.
     *
     * A body listed this way has an empty `sites`, which reads as a routine
     * that calls nothing -- and that would be a closed body to anything
     * counting them. So `only` is never passed by a caller that draws a
     * conclusion from the absence of sites, and `reach.ts` keys its cache by
     * routine as well as file so one body's reading is never handed back for
     * another's.
     */
    if (only !== undefined && name.text !== only) { bodies.push(body); return; }
    const scope = boundByRoutine(node);
    holders ??= holdersIn(tree.rootNode);
    const holder = holders.get(node.id);
    each(node, (inner) => {
      /*
       * A macro's arguments are loose tokens rather than a tree, so a call
       * written inside one is invisible. That is a doubt about the whole body
       * here -- unlike `callsTo`, which only raises it when the name asked
       * after is in the tokens. A body cannot be closed around calls nobody
       * can see.
       */
      if (inner.type === "token_tree") {
        body.sites.push({
          name: "",
          line: lineOf(side.source, inner.startIndex),
          why: "macro",
          receiver: false,
        });
        return;
      }
      const callee = calleeOf(inner) ?? constructedBy(inner);
      if (!callee) return;
      const where = placeOf(callee, side, bindings, scope, holder);
      body.sites.push({
        name: callee.kind === "computed" ? "" : callee.name,
        line: lineOf(side.source, inner.startIndex),
        receiver: callee.kind === "through",
        ...(callee.kind === "through" ? { memberAt: callee.memberAt } : {}),
        ...(callee.kind === "computed" ? {} : { nameAt: callee.kind === "through" ? callee.memberAt : callee.nameAt }),
        ...("file" in where
          ? {
              file: where.file,
              ...(where.concrete !== undefined ? { concrete: where.concrete } : {}),
              ...(where.as !== undefined ? { declaredAs: where.as } : {}),
              ...(where.overridden ? { overridden: true } : {}),
            }
          : { why: where.why }),
      });
    });
    bodies.push(body);
  });
  return { read: true, bodies };
}
