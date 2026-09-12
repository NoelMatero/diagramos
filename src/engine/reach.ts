/**
 * Following a chain of calls across files, in both directions.
 *
 * ## What stopped at one step, and why it stopped there
 *
 * `body.ts`'s `reaches` follows calls as deep as they go **inside one file**.
 * That is not a budget, it is a wall: `bodiesFor` looks a callee's name up in
 * the tree it already parsed, so the moment a chain steps into another file it
 * ends. Most real chains do. `handleRequest` calls `parseBody` in
 * `body-parser.ts`, which calls `decode` in `codec.ts`, and an arrow drawn from
 * `handleRequest` to `decode` -- a true arrow, about a real path through the
 * code -- comes back `no-call-either-way`.
 *
 * Two earlier attempts to search further are the reason this one is written the
 * way it is, and both failed the same way: they followed a **name** instead of
 * a **call**.
 *
 *   - Following bare names out of the file made mio's `EventSet::readable()`
 *     read as the project's own `readable`, and two plainly false arrows went
 *     quiet (ee3b29e, whose commit message names both).
 *   - Widening the search at *file* level blesses nearly everything, because
 *     one file importing half the codebase puts all of it within "reach" of
 *     all of it. That is the whitewash `corroborates` in `drift.ts` is
 *     deliberately only ever allowed to *confirm* from, and the reason
 *     function granularity exists at all.
 *
 * And one that was already written down here and classified the other way.
 * `audit-arrows.mts` has said since it was written that an arrow satisfied by
 * a body *naming* the far end rather than calling it -- `filesIn` reaching a
 * local `stat` by way of `workspace.stat` -- is "a choice about what an arrow
 * means, not a bug". `measure:reach` put a number on that choice: 51 wrong
 * confirmations in `anyhow` alone, every one of them a method on a value
 * whose type is not in the text (docs/claim-vocabulary.md item 26) -- 60
 * across the whole Rust population, now 9. Inside one file the choice is
 * still the right one and nothing here changes it.
 *
 * So every hop here is a call site that `calls.ts` could **place**: the name is
 * bound, the binding resolves to a file in this repository, and the forwarding
 * came to rest. `x.foo()` on a receiver nothing typed is not followed, a name
 * bound twice over is not followed, an unresolved specifier is not followed. A
 * library's `readable` is `unbound` or `unplaced` and dies at the first hop; a
 * file's imports are never evidence of anything on their own.
 *
 * ## The two verdicts rest on opposite things, as everywhere else here
 *
 * `reached` rests on a chain **found**. Every hop is evidence, so a hop the
 * reader declines to follow costs a confirmation and nothing else -- the walk
 * simply does not go that way.
 *
 * `never` rests on a region **closed**, and it is an accusation, so it needs
 * far more: every routine on the whole forward closure has to have had every
 * one of its call sites placed. One `x.foo()` anywhere on it, one name bound
 * twice, one budget running out, and the answer is `withheld` -- because an
 * unplaced call is a door the chain may have gone through.
 *
 * That asymmetry is the whole design. Confirming gets more generous with
 * depth; accusing gets harder with it, because the evidence a refutation needs
 * multiplies while the evidence a confirmation needs does not.
 *
 * ## `never` says nothing to anybody yet, and that is the measurement's answer
 *
 * `drift.ts` reads `reached` and ignores `never`. Not an oversight and not a
 * to-do: it is what `measure:reach` came back with. Over the pinned corpus the
 * verdict was **right every time it was given and hardly ever given** -- 24
 * correct refutations and 0 wrong out of 384 TypeScript pairs a compiler says
 * genuinely never reach, 12 of 792 on Python, 11 of 1,572 on Rust. Zero
 * errors out of 24 is consistent with an error rate over one in ten, and an
 * accusation is the one thing here that cannot be taken back
 * (`licence.ts`).
 *
 * So the reader is built, measured, and wired nowhere -- the same posture
 * `resolution.ts` held from #227 until this file consulted it. What would
 * change the answer is a bigger answered sample, and what stands in the way of
 * one is named in the numbers: 204 of TypeScript's 360 refusals and 988 of
 * Rust's 1,552 are a receiver nothing typed.
 *
 * A real checker is what closes those, and `check-drift.mjs` now supplies one
 * for all three languages -- which is exactly why the measurement above does
 * not use it. A reader that follows `tsc`'s answers, judged against a referee
 * that is `tsc`, cannot be caught being wrong. Even so, a checker's answer
 * only ever *follows* a hop here: `declarationAt` can name a trait method or
 * an interface method whose implementation is elsewhere, so a site it places
 * stays open for the closure. `"outside"` is the single exception, and it is
 * the same fact `EXTERNAL_RECEIVER` already carried.
 */
import {
  EXTERNAL_RECEIVER, callSitesIn,
  type BodyCallSites, type CallSide, type CallSitesReading,
  type ReceiverResolution, type SiteUnresolved,
} from "./calls";
import type { Language } from "./parse";
import { resolveReceiversIn } from "./resolution";

/** Why no verdict was reached. Every one is a reason to stay quiet. */
export type ReachWithheld =
  /** No grammar for the head's language, or the file would not parse. */
  | "unreadable"
  /** Nothing in the head's file declares a routine by that name. */
  | "no-body"
  /**
   * A call site somewhere on the closure that `calls.ts` could not place, so
   * the chain may have left through it. The commonest answer by far, and the
   * honest one: see `SiteUnresolved` for which doubt it was.
   */
  | "open-body"
  /**
   * A routine a call was placed at whose own body could not be read -- a file
   * with no grammar, a name placed at a file that declares it as something
   * other than a routine. Placed, and still a successor nobody can enumerate.
   */
  | "unreadable-hop"
  /** More routines on the closure than the budget allows. */
  | "budget"
  /** A chain longer than the depth allowed. */
  | "depth";

/** One step of the chain that was found, so a report can quote the route. */
export interface ReachHop {
  file: string;
  routine: string;
  /** 1-based line the call was written on. */
  line: number;
}

export type ReachVerdict =
  /**
   * A chain of placed calls runs from the head to the tail. `via` is the
   * route, head and tail included, so a report can say how it got there
   * rather than asserting that it did.
   */
  | { verdict: "reached"; via: string[]; hops: ReachHop[] }
  /**
   * Every routine forward of the head was read, every call it makes was
   * placed, and the tail is in none of them. `checked` is how many routines
   * that was -- the size of the evidence, which is what a reader needs to
   * weigh an accusation resting on an absence.
   */
  | { verdict: "never"; checked: number; sites: number }
  | {
      verdict: "withheld";
      why: ReachWithheld;
      detail?: SiteUnresolved;
      /**
       * Every kind of doubt met on the closure, not just the first.
       *
       * A closure is conjunctive: it closes when *all* of its sites are
       * placed, so a histogram of first doubts cannot say what closing one
       * category would buy. This can -- a refusal whose `doubts` are all of
       * one kind is one that a reader for that kind would settle, and
       * `measure:reach` counts those apart before anybody builds one.
       */
      doubts?: readonly SiteUnresolved[];
    };

/**
 * What one file's reading costs, kept so a board's arrows do not pay it twice.
 *
 * Owned by the caller for the reason `ConfigCache` is: this process outlives a
 * check, and a body read once and remembered forever is a fact with a shelf
 * life. A caller that hands one in gets one reading per file per check; a
 * caller that does not gets one reading per file per ask, which is correct and
 * slower.
 */
export interface ReachCache {
  /**
   * One routine's placed sites, keyed by file **and** routine.
   *
   * Keyed by both because `callSitesIn` is asked to place only the routine
   * being read: every other body in that file comes back listed and
   * unplaced, which is the right reading for the walk and the wrong one for
   * any other routine in the same file. A cache keyed by file alone would
   * hand the second routine the first one's reading, and an empty `sites`
   * reads as a body that calls nothing.
   */
  bodies: Map<string, CallSitesReading>;
  /** Every routine a file declares, listed and not placed. Keyed by file. */
  listed: Map<string, CallSitesReading>;
  receivers: Map<string, ReceiverLookup>;
}

export const newReachCache = (): ReachCache =>
  ({ bodies: new Map(), listed: new Map(), receivers: new Map() });

/** What a receiver expression's type is, asked by the expression's byte range. */
type ReceiverLookup = (at: { start: number; end: number }) => ReceiverResolution | undefined;

/**
 * `resolution.ts`, wired in as a receiver resolver for the first time.
 *
 * That module has been a measurement's reader since #227 -- built, measured
 * against three compilers, and consulted by nothing that says anything. It is
 * consulted here because of what the corpus says the walk loses without it:
 * on Python, **every** chain the walk failed to follow began with a method
 * call on a value (`response.iter_bytes()`, `params.set()`, `tag.check()`),
 * which `calls.ts` refuses as `receiver` and which `resolveReceiversIn` reads
 * straight off the constructor or the annotation that names the type. With it
 * wired in, Python's two-step confirmations went from 29 of 78 to 56.
 *
 * It is safe here in a way it would not be everywhere, and the asymmetry is
 * the point. A type read out of the text and placed by `placeName` can only
 * ever make the walk follow **one more** call, which can only ever produce a
 * confirmation -- and a confirmation resting on a misread type is a
 * confirmation, not an accusation. The refutation side refuses to count these
 * sites as closed at all (see `blocking` below), so nothing accuses on the
 * strength of one.
 */
function textReceivers(source: string, language: Language): ReceiverLookup {
  const reading = resolveReceiversIn(source, language);
  if (!reading.read) return () => undefined;
  const byRange = new Map<string, string>();
  for (const routine of reading.routines) {
    for (const site of routine.sites) {
      if (site.verdict.verdict !== "resolved") continue;
      byRange.set(`${site.at.start}:${site.at.end}`, site.verdict.evidence.type);
    }
  }
  return (at) => {
    const type = byRange.get(`${at.start}:${at.end}`);
    return type === undefined ? undefined : { kind: "type", name: type };
  };
}

/**
 * Whether a placed call site still leaves the closure open.
 *
 * `closedBodyRefutes` in `calls.ts` asks the depth-1 version of this and
 * accepts any placed site whose receiver did not resolve to a non-concrete
 * type. This is stricter on one shape: a receiver placed with no answer about
 * whether its type is concrete. Without a resolver there is no such site --
 * a receiver nothing typed is unplaced -- so the rule only bites on the
 * text resolver wired in above, whose answer is a printed type name and
 * carries no concreteness with it.
 *
 * Stricter in the direction that costs a refutation rather than in the one
 * that buys a false accusation, which is this file's whole standing
 * instruction.
 */
function blocking(site: { receiver: boolean; concrete?: boolean }): boolean {
  return site.receiver && site.concrete !== true;
}

/**
 * "Go to definition" at a call's own name -- where the function called there
 * is declared, repo-relative with a 1-based line, `"outside"` when that is
 * not in this repository, `undefined` when nothing answered.
 *
 * The same question `@accesses` already asks (`ClosedBodyReferee` in
 * `drift.ts`), asked here for the hops `calls.ts` cannot place by itself.
 * It is a strictly better question than "what type is the receiver": it
 * answers `x.foo()`, `make().run()` and a bare name nothing in the file
 * binds, all in one step and without a name search afterwards.
 *
 * Only ever used to **follow** a hop, never to close a region. A definition
 * can name an interface method or a trait method whose implementation lives
 * somewhere else, which is item 14's caveat (docs/claim-vocabulary.md) and
 * the reason the refutation side treats these sites as open exactly as it
 * did before. `"outside"` is the exception and is allowed to settle a site:
 * a call the compiler places outside the repository is provably not a repo
 * routine, which is the same thing `EXTERNAL_RECEIVER` means.
 */
export type DeclarationAt = (
  file: string,
  at: { start: number; end: number },
) => { file: string; line: number } | "outside" | undefined;

export interface ReachOptions {
  /**
   * Routine bodies one question may read.
   *
   * Generous, because a refusal is what running out produces and a refusal is
   * a confirmation lost. Measured on the corpus, the closures that close at
   * all are small -- a handful of routines -- and the ones that run past this
   * were never going to close.
   */
  budget?: number;
  /** Call steps one question may follow. */
  depth?: number;
  cache?: ReachCache;
  /** A real checker's "go to definition", when the caller has one. */
  declarationAt?: DeclarationAt;
}

const DEFAULT_BUDGET = 400;
const DEFAULT_DEPTH = 8;

/** A routine, as the walk identifies one. */
const keyOf = (file: string, routine: string): string => `${file}#${routine}`;

/**
 * Whether the head reaches the tail through calls this reader can place, or
 * provably does not.
 *
 * `from.routine` is the head. `to.names` is every symbol the tail's box lists,
 * and reaching any one of them satisfies the arrow -- the same
 * any-of-the-members rule the one-file search uses.
 */
export function reachBetween(
  from: CallSide & { routine: string },
  to: CallSide & { names: string[] },
  options: ReachOptions = {},
): ReachVerdict {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const maxDepth = options.depth ?? DEFAULT_DEPTH;
  const cache = options.cache ?? newReachCache();
  const wanted = new Set(to.names);

  /**
   * A receiver's type, from whatever can answer: the caller's own resolver
   * first -- a real checker, when one is wired in -- and the text otherwise.
   * Never both about one site: a checker that had nothing to say about a
   * position is not overruled by a weaker reader agreeing with it, it is
   * simply followed by one.
   */
  const receiverIn = (file: string, source: string, language: Language): ReceiverLookup => {
    let fromText = cache.receivers.get(file);
    if (!fromText) {
      fromText = textReceivers(source, language);
      cache.receivers.set(file, fromText);
    }
    // Only the text half is cached. The caller's resolver is applied on top
    // each time rather than baked in, so a cache shared across a check cannot
    // hand one ask's referee to another's.
    const given = from.resolveReceiver;
    const text = fromText;
    return given ? (at) => given(at) ?? text(at) : text;
  };

  /**
   * The side for one file. `from` and `to` are handed in already built; every
   * other file comes through `from.open`, which is the same opener `calls.ts`
   * follows a barrel with.
   *
   * Their `resolveReceiver` is replaced rather than passed along, on purpose:
   * the two ends arrive built by a caller that may have wired a checker in,
   * and the text resolver has to be behind it on every file including those
   * two, or the walk answers differently about the head's own body than about
   * a body one hop further on.
   */
  const sideOf = (file: string): CallSide | undefined => {
    const built = file === from.file ? from : file === to.file ? to : undefined;
    const opened = built ?? (() => {
      const read = from.open?.(file);
      return read ? { file, ...read, open: from.open } : undefined;
    })();
    if (!opened) return undefined;
    return {
      ...opened,
      file,
      open: from.open,
      resolveReceiver: receiverIn(file, opened.source, opened.language),
    };
  };

  /** One routine's sites, placed. Every other body in the file is listed only. */
  const placedIn = (file: string, routine: string): CallSitesReading | undefined => {
    const key = `${file}\u0000${routine}`;
    const hit = cache.bodies.get(key);
    if (hit) return hit;
    const side = sideOf(file);
    if (!side) return undefined;
    const reading = callSitesIn(side, routine);
    cache.bodies.set(key, reading);
    return reading;
  };

  /**
   * Every routine a file declares, with no site placed.
   *
   * Two questions need this and neither reads a site: which routine holds the
   * line a definition points at, and whether a file declares a name at all.
   * Asked with a routine name nothing can match, so every body is listed and
   * nothing reaches a checker.
   */
  const NOTHING_IS_CALLED_THIS = "\u0000none";
  const listedIn = (file: string): CallSitesReading | undefined => {
    const hit = cache.listed.get(file);
    if (hit) return hit;
    const side = sideOf(file);
    if (!side) return undefined;
    const reading = callSitesIn(side, NOTHING_IS_CALLED_THIS);
    cache.listed.set(file, reading);
    return reading;
  };

  const start = keyOf(from.file, from.routine);
  const came = new Map<string, { previous: string; line: number }>();
  /*
   * What each key stands for, rather than splitting the key back apart. A
   * TypeScript `#private` method puts a `#` inside the routine name, so the
   * separator is not a thing to parse on -- the route would come out naming
   * the wrong half.
   */
  const at = new Map<string, { file: string; routine: string }>([
    [start, { file: from.file, routine: from.routine }],
  ]);
  const seen = new Set<string>([start]);
  let frontier = [{ file: from.file, routine: from.routine }];
  let read = 0;
  let sites = 0;
  /** The first doubt met, kept so the refusal can say which one it was. */
  let doubt: SiteUnresolved | undefined;
  /** Every kind of doubt met, for the question `ReachVerdict.doubts` answers. */
  const doubts = new Set<SiteUnresolved>();
  let unreadableHop = false;
  let overBudget = false;

  const routeTo = (key: string): { via: string[]; hops: ReachHop[] } => {
    const via: string[] = [];
    const hops: ReachHop[] = [];
    let current: string | undefined = key;
    while (current) {
      const here = at.get(current);
      if (!here) break;
      via.unshift(here.routine);
      const step = came.get(current);
      if (step) hops.unshift({ file: here.file, routine: here.routine, line: step.line });
      current = step?.previous;
    }
    return { via, hops };
  };

  /**
   * Where a checker says an unplaced call lands, as a routine this walk can
   * step to.
   *
   * A definition is a file and a line; a hop is a file and a *routine*. The
   * bridge is the reading this walk already has of that file: the routine
   * whose declaration opens on that line, and failing that the innermost one
   * whose body spans it -- a definition pointing a line off (an overload
   * signature, a decorator above the `def`) is common enough to be worth the
   * second try, and the innermost is the only one of the candidates that is
   * not merely an enclosing scope.
   */
  const asked = (
    file: string,
    site: { why?: SiteUnresolved; nameAt?: { start: number; end: number } },
  ): { file: string; routine: string } | "outside" | undefined => {
    if (!options.declarationAt || !site.nameAt) return undefined;
    const found = options.declarationAt(file, site.nameAt);
    if (!found) return undefined;
    if (found === "outside") return "outside";
    const reading = listedIn(found.file);
    if (!reading?.read) return undefined;
    const exact = reading.bodies.find((body) => body.line === found.line);
    if (exact) return { file: found.file, routine: exact.routine };
    let spanning: BodyCallSites | undefined;
    for (const body of reading.bodies) {
      if (found.line < body.line || found.line >= body.line + body.lines) continue;
      if (!spanning || body.line > spanning.line) spanning = body;
    }
    return spanning ? { file: found.file, routine: spanning.routine } : undefined;
  };

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: Array<{ file: string; routine: string }> = [];
    for (const { file, routine } of frontier) {
      /*
       * The *head*, not merely a routine in the head's file. A local call
       * lands back in that file constantly -- `processFor` calls a `const`
       * declared beside it -- and reading the file as the head there returned
       * `no-body` for the whole question and abandoned every chain still on
       * the frontier. 86 of one corpus's 367 reaching pairs were lost to that
       * one comparison, which the benchmark found and no unit test would have:
       * a fixture small enough to write by hand has no second routine in the
       * head's file to trip over.
       */
      const isHead = keyOf(file, routine) === start;
      const reading = placedIn(file, routine);
      if (!reading || !reading.read) {
        if (isHead) return { verdict: "withheld", why: "unreadable" };
        unreadableHop = true;
        continue;
      }
      const bodies = reading.bodies.filter((body) => body.routine === routine);
      if (bodies.length === 0) {
        /*
         * The head having no body is a different answer from a hop having
         * none: the question was never askable, rather than the closure
         * having a hole in it.
         */
        if (isHead) return { verdict: "withheld", why: "no-body" };
        unreadableHop = true;
        continue;
      }
      read += bodies.length;
      for (const body of bodies) {
        /*
         * The two passes this body needs, and why the second one exists.
         *
         * Python has no `new`, so `response = Response(200)` is a call like
         * any other and `resolution.ts` is right to refuse it -- a call's
         * result is opaque and reading one as its own name would be reading a
         * convention. But the *call* is placed: `Response` is imported, and
         * `calls.ts` resolves it to the file that declares it. What is not
         * placed is `response.iter_bytes()` one line later.
         *
         * So the two are joined rather than either being guessed at. A placed
         * call landing on a name the target file does not declare as a
         * routine is a type being constructed, and the file it lives in is
         * where this body's own unplaced method calls are looked for. Every
         * Python chain the walk could not follow was this shape and no other
         * (`measure:reach`: 23 misses out of 23).
         *
         * It is a join and not a proof, so it is kept out of the closure:
         * the site stays a doubt, the hop is followed, and a confirmation is
         * the only thing that can come of it.
         */
        const typeFiles: string[] = [];
        const unplacedMethods: Array<{ name: string; line: number }> = [];
        for (const site of body.sites) {
          sites += 1;
          if (site.file === undefined) {
            /*
             * The reader could not place it. A checker often can, and at a
             * position rather than by a name search -- so this is asked here
             * and nowhere earlier: `calls.ts` places what the text settles,
             * and only what the text leaves open reaches a compiler.
             */
            const landed = asked(file, site);
            if (landed === "outside") continue;
            if (site.why) doubts.add(site.why);
            if (!landed) { doubt ??= site.why; continue; }
            doubt ??= site.why; // followed, and still a doubt for the closure.
            if (landed.file === to.file && wanted.has(landed.routine)) {
              const key = keyOf(landed.file, landed.routine);
              at.set(key, landed);
              came.set(key, { previous: keyOf(file, routine), line: site.line });
              return { verdict: "reached", ...routeTo(key) };
            }
            const onward = keyOf(landed.file, landed.routine);
            if (seen.has(onward)) continue;
            if (seen.size >= budget) { overBudget = true; continue; }
            seen.add(onward);
            at.set(onward, landed);
            came.set(onward, { previous: keyOf(file, routine), line: site.line });
            next.push(landed);
            continue;
          }
          /*
           * Item 14's guard, widened by one shape: the file an interface, an
           * abstract class or a *type read out of the text* is declared in is
           * not necessarily the file the method reached at runtime lives in.
           * So the site is a doubt for the closure -- and still followed,
           * since following it can only ever produce a confirmation.
           */
          if (blocking(site)) { doubt ??= "receiver"; doubts.add("receiver"); }
          // Provably outside the repository, so provably not any repo routine.
          if (site.file === EXTERNAL_RECEIVER) continue;
          const landing = { file: site.file, routine: site.name };
          const key = keyOf(site.file, site.name);
          if (site.file === to.file && wanted.has(site.name)) {
            at.set(key, landing);
            came.set(key, { previous: keyOf(file, routine), line: site.line });
            return { verdict: "reached", ...routeTo(key) };
          }
          if (seen.has(key)) continue;
          if (seen.size >= budget) { overBudget = true; continue; }
          seen.add(key);
          at.set(key, landing);
          came.set(key, { previous: keyOf(file, routine), line: site.line });
          next.push(landing);
        }

        /* The second pass: this body's own constructions, joined to its own
         * unplaced method calls. See the comment above the first. */
        for (const site of body.sites) {
          if (site.file !== undefined && site.file !== EXTERNAL_RECEIVER) {
            const declares = listedIn(site.file);
            if (declares?.read && !declares.bodies.some((one) => one.routine === site.name)) {
              if (!typeFiles.includes(site.file)) typeFiles.push(site.file);
            }
          }
          if (site.file === undefined && site.why === "receiver" && site.name) {
            unplacedMethods.push({ name: site.name, line: site.line });
          }
        }
        for (const method of unplacedMethods) {
          for (const typeFile of typeFiles) {
            const declares = listedIn(typeFile);
            if (!declares?.read) continue;
            if (!declares.bodies.some((one) => one.routine === method.name)) continue;
            const landing = { file: typeFile, routine: method.name };
            const key = keyOf(typeFile, method.name);
            if (typeFile === to.file && wanted.has(method.name)) {
              at.set(key, landing);
              came.set(key, { previous: keyOf(file, routine), line: method.line });
              return { verdict: "reached", ...routeTo(key) };
            }
            if (seen.has(key)) continue;
            if (seen.size >= budget) { overBudget = true; continue; }
            seen.add(key);
            at.set(key, landing);
            came.set(key, { previous: keyOf(file, routine), line: method.line });
            next.push(landing);
          }
        }
      }
    }
    frontier = next;
  }

  if (overBudget) return { verdict: "withheld", why: "budget" };
  if (frontier.length > 0) return { verdict: "withheld", why: "depth" };
  if (doubt) return { verdict: "withheld", why: "open-body", detail: doubt, doubts: [...doubts] };
  if (unreadableHop) return { verdict: "withheld", why: "unreadable-hop" };
  return { verdict: "never", checked: read, sites };
}
