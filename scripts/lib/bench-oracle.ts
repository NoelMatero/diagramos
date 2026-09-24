/**
 * The answer key for #296: is this claim true of the code, according to the
 * language's own tooling?
 *
 * Three answers and no fourth. **true** and **false** are only given where the
 * tool could see the whole of what the word asserts; everywhere else the claim
 * is **undecidable** and leaves the score, counted, with the reason it left.
 * Every doubt is spelled out rather than rounded, because an answer key that
 * guesses turns a checker's correct silence into a miss.
 *
 * What makes this worth having is what it does not touch: nothing here, and
 * nothing in `bench-tooling.ts` or `bench-shapes.ts`, imports `src/engine`.
 * The checker is scored against rust-analyzer, pyright and the TypeScript
 * compiler, not against itself -- `tests/bench-planted.test.ts` fails if an
 * engine import ever appears in one of the three.
 *
 * The words are read as `skills/diagram/claims.md` states them to an author,
 * since that is the sentence a board is written from:
 *
 *   needs     from's file imports to's file
 *   takes     the function (to) has a parameter of the type (from)
 *   returns   the function (to) returns the type (from)
 *   holds     the container (from) has a field of the type (to)
 *   builds    from makes a value of the type (to)
 *   calls     from calls to
 *   accesses  from (a routine) reads the member named on the label off to (a type)
 *   conforms  from extends or implements to
 *   feeds     from's result goes into to
 *
 * `feeds` is only ever decided one way: a value's journey can go through a
 * queue or a callback nothing reads, so "no flow found" is never false. What
 * *is* decidable is an end that could not take part at all -- a struct has no
 * result to feed anywhere -- and that is the wrong-kind plant #296 asks for.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import {
  isTsx, rustImplBlocks, rustKeyword,
  basesOf, fieldsOf, membersOf, signatureOf, type Span,
} from "./bench-shapes";
import {
  blankPython, blankRust, blankTs, isOutside, sourceOf,
  type Kind, type Language, type Loc, type Sym, type Tooling,
} from "./bench-tooling";

/*
 * `depends` is judged (`judgeDepends`) and deliberately not in this list: the
 * list drives which claims the planted set *generates*, and adding a word
 * there would change the population the score is measured against, which is
 * the one thing a benchmark may not do quietly (#323).
 */
export const WORDS = ["needs", "takes", "returns", "holds", "builds", "calls", "accesses", "conforms", "feeds"] as const;
export type Word = (typeof WORDS)[number] | "depends";

export type Truth = "true" | "false" | "undecidable";
export interface Answer { truth: Truth; why: string }

export interface ClaimUnderTest {
  word: Word;
  /** `path#symbol` or `path`, repository-relative, as a board writes it. */
  from: string;
  to: string;
  /** The member name, for `accesses`. */
  member?: string;
}

const KEYWORDS: Record<Language, Set<string>> = {
  rust: new Set(["self", "Self", "mut", "ref", "dyn", "impl", "as", "where", "const", "static", "crate", "super",
    "u8", "u16", "u32", "u64", "u128", "usize", "i8", "i16", "i32", "i64", "i128", "isize", "f32", "f64",
    "bool", "char", "str", "String", "Vec", "Option", "Result", "Box", "Rc", "Arc", "HashMap", "HashSet", "BTreeMap",
    "Cow", "Ok", "Err", "Some", "None", "fn", "move", "return", "let", "match", "if", "else", "for", "while", "loop"]),
  python: new Set(["self", "cls", "None", "True", "False", "int", "str", "float", "bool", "bytes", "list", "dict",
    "set", "tuple", "type", "object", "Any", "Optional", "Union", "List", "Dict", "Set", "Tuple", "Callable",
    "Sequence", "Iterable", "Iterator", "Mapping", "Awaitable", "AsyncIterator", "TypeVar", "Generic", "return",
    "if", "else", "for", "while", "def", "class", "import", "from", "as", "in", "not", "and", "or", "is", "await"]),
  ts: new Set(["this", "string", "number", "boolean", "void", "any", "unknown", "never", "null", "undefined", "object",
    "symbol", "bigint", "Array", "Promise", "Record", "Partial", "Readonly", "Map", "Set", "Date", "RegExp", "Error",
    "Function", "readonly", "keyof", "typeof", "infer", "extends", "new", "return", "const", "let", "var", "function",
    "class", "interface", "type", "import", "export", "from", "as", "in", "of", "async", "await", "if", "else", "for", "while"]),
};

const blankOf = (language: Language, text: string) =>
  language === "rust" ? blankRust(text) : language === "python" ? blankPython(text) : blankTs(text);

interface Token { name: string; at: number }

function identifiers(text: string, span: Span, language: Language, keepQuoted = false): Token[] {
  const region = keepQuoted ? text : blankOf(language, text);
  const out: Token[] = [];
  for (const m of region.slice(span.start, span.end).matchAll(/[A-Za-z_]\w*/g)) {
    const name = m[0];
    if (KEYWORDS[language].has(name)) continue;
    // A member or a path tail is still a name worth resolving; a number is not.
    out.push({ name, at: span.start + m.index! });
  }
  return out;
}

/** What the tool says a name at an offset is. */
type Resolved =
  | { kind: "sym"; sym: Sym }
  | { kind: "outside" }
  | { kind: "unlisted"; loc: Loc }
  | { kind: "none" }
  | { kind: "failed" };

export interface Oracle {
  language: Language;
  root: string;
  judge(claim: ClaimUnderTest): Promise<Answer>;
  /** The symbols a `path#symbol` ref could mean, for the mutation script. */
  candidates(ref: string): Promise<Sym[] | undefined>;
  symbolsOf(relative: string): Promise<Sym[] | undefined>;
  version(): string;
  close(): void;
}

/**
 * The kinds each word's two ends must have for the sentence to mean anything.
 * A `@feeds` arrow out of a struct is not unproven, it is wrong: a struct has
 * no result. This is the one thing a claim can be wrong about with no reader
 * at all, and it is the fourth plant #296 asks for.
 */
export function kindProblemFor(word: Word, from: Sym, to: Sym): string | undefined {
  const want = (s: Sym, ok: boolean, role: string, wanted: string) =>
    ok ? undefined : `the ${role} end is a ${describeKind(s)}, and ${wanted}`;
  switch (word) {
    case "calls":
      /*
       * A type at the far end is not a kind mistake. `MessageError(msg)` in
       * Rust, `Client()` in Python and `new Query()` in TypeScript are all
       * calls to something a type declares, and rust-analyzer's own call
       * hierarchy lists the struct -- so whether the call happened is left to
       * the reader below rather than refused here. A field or a constant is
       * a kind mistake: nothing calls one.
       */
      return want(from, isRoutine(from), "from", "only something that runs can call")
        ?? want(to, isRoutine(to) || isType(to), "to", "only something that runs can be called");
    case "feeds":
      return want(from, isRoutine(from), "from", "only something that runs has a result to feed onward")
        ?? want(to, isRoutine(to), "to", "only something that runs can be fed");
    case "takes":
    case "returns":
      return want(from, isType(from), "from", "only a type can be a parameter or a return type")
        ?? want(to, isRoutine(to), "to", "only something that runs has a signature");
    case "holds":
      return want(from, isType(from), "from", "only a type has fields")
        ?? want(to, isType(to), "to", "only a type can be the type of a field");
    case "builds":
      return want(from, isRoutine(from) || isType(from), "from", "only a routine or a type makes values")
        ?? want(to, isType(to) || (isTsx(to.file) && isRoutine(to) && /^[A-Z]/.test(to.name)), "to",
          "only a type (or a component) can be made");
    case "accesses":
      return want(from, isRoutine(from), "from", "only something that runs reads a member")
        ?? want(to, isType(to), "to", "only a type declares members");
    case "conforms":
      return want(from, isType(from), "from", "only a type extends or implements")
        ?? want(to, isType(to), "to", "only a type can be a base");
    case "needs":
    case "depends":
      return undefined;
  }
}

const describeKind = (s: Sym): string => ({
  routine: "routine", type: "type", alias: "type alias", data: "value or field",
  impl: "impl block", module: "module", other: "declaration",
} as Record<Kind, string>)[s.kind];

const isRoutine = (s: Sym) => s.kind === "routine";
const isType = (s: Sym) => s.kind === "type" || s.kind === "alias";

export function createOracle(tooling: Tooling): Oracle {
  const { language, root } = tooling;
  const abs = (relative: string) => path.resolve(root, relative);
  const rel = (file: string) => path.relative(root, file);

  const symbolCache = new Map<string, Sym[] | undefined>();
  async function symbolsOf(relative: string): Promise<Sym[] | undefined> {
    const file = abs(relative);
    if (!symbolCache.has(file)) symbolCache.set(file, existsSync(file) ? await tooling.symbols(file) : undefined);
    return symbolCache.get(file);
  }

  async function candidates(ref: string): Promise<Sym[] | undefined> {
    const [file, name] = ref.split("#");
    if (!name) return undefined;
    const syms = await symbolsOf(file!);
    if (!syms) return undefined;
    return syms.filter((s) => s.name === name || (language === "ts" && s.name === `#${name}`));
  }

  /** Whether a location the tool returned points at this declaration. */
  const denotes = (loc: Loc, sym: Sym) =>
    loc.file === sym.file && loc.start >= sym.start && loc.start <= sym.nameStart + sym.name.length;

  const resolveCache = new Map<string, Resolved>();
  async function resolve(file: string, at: number): Promise<Resolved> {
    const key = `${file}:${at}`;
    const cached = resolveCache.get(key);
    if (cached) return cached;
    const locs = await tooling.definition(file, at);
    let answer: Resolved;
    if (locs === undefined) answer = { kind: "failed" };
    else if (locs.length === 0) answer = { kind: "none" };
    else {
      const local = locs.find((l) => !isOutside(l.file, root));
      if (!local) answer = { kind: "outside" };
      else {
        const syms = (await symbolsOf(rel(local.file))) ?? [];
        const sym = syms.find((s) => denotes(local, s));
        answer = sym ? { kind: "sym", sym } : { kind: "unlisted", loc: local };
      }
    }
    resolveCache.set(key, answer);
    return answer;
  }

  /**
   * Does any name in these spans resolve to `target`?
   *
   * `doubt` is the honest half: a name the tool could not place, an alias that
   * could stand for the target, a generic parameter that could be instantiated
   * with it. Any one of those and an absence proves nothing.
   */
  async function namesReach(
    file: string, spans: Span[], target: Sym, enclosingImpl?: ImplSelf,
  ): Promise<{ match: boolean; doubt?: string }> {
    const text = sourceOf(file);
    let doubt: string | undefined;
    for (const span of spans) {
      for (const token of identifiers(text, span, language, language === "python")) {
        if (token.name === "Self" || (language === "rust" && token.name === "Self")) continue;
        const found = await resolve(file, token.at);
        if (found.kind === "sym") {
          if (found.sym.file === target.file && found.sym.nameStart === target.nameStart) return { match: true };
          if (found.sym.kind === "alias") doubt ??= `a type alias (${found.sym.name}) could stand for it`;
        } else if (found.kind === "failed") doubt ??= `the tool did not answer about ${token.name}`;
        else if (found.kind === "none") doubt ??= `nothing resolved ${token.name}`;
        else if (found.kind === "unlisted") doubt ??= `${token.name} resolves to something undeclared here (a generic or a local)`;
      }
      // Rust's `Self` in a signature means the impl's own type.
      if (language === "rust" && /\bSelf\b/.test(text.slice(span.start, span.end))) {
        if (!enclosingImpl) doubt ??= "Self outside an impl";
        else if (enclosingImpl.selfName === target.name) {
          const at = enclosingImpl.selfAt;
          if (at === undefined) doubt ??= "Self's own type could not be read";
          else {
            const found = await resolve(enclosingImpl.file, at);
            if (found.kind === "sym" && found.sym.file === target.file && found.sym.nameStart === target.nameStart) {
              return { match: true };
            }
            if (found.kind !== "sym") doubt ??= "the impl's own type did not resolve";
          }
        }
      }
    }
    return { match: false, ...(doubt ? { doubt } : {}) };
  }

  interface ImplSelf { file: string; selfName?: string; selfAt?: number }

  /** The `impl` block a Rust routine sits in, which is what `Self` means there. */
  function implAround(sym: Sym): ImplSelf | undefined {
    if (language !== "rust") return undefined;
    const block = rustImplBlocks(sym.file).find((b) => b.start <= sym.start && sym.end <= b.end);
    return block ? { file: sym.file, selfName: block.selfName, selfAt: block.selfAt } : undefined;
  }

  const kindProblem = kindProblemFor;

  /* --------------------------------------------------------------- words */

  async function judgeCalls(from: Sym, to: Sym): Promise<Answer> {
    const calls = await tooling.outgoingCalls(from);
    if (calls?.some((l) => denotes(l, to))) return { truth: "true", why: "the tool's call hierarchy lists it" };
    const body = signatureOf(language, from)?.bodyStart ?? from.start;
    const scan = await scanForCall(from.file, { start: body, end: from.end }, [], to);
    if (scan.called) return { truth: "true", why: "the name is called here and resolves to it" };
    const doubt = calls === undefined ? "the tool would not walk this routine's calls" : scan.doubt;
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "the routine's calls were read and none is it" };
  }

  /**
   * Every place `to`'s name is written in a region, resolved: called there, or
   * a doubt about whether it could be. `skip` is the parts of the region some
   * other reading has already answered for.
   *
   * `decorators` counts a bare `@name` (or `@module.name`) opening a line as a
   * call, which it is: the name is called with what it decorates. Only a
   * type's own scan asks for it -- a routine at the tail keeps the reading its
   * stored key was made with.
   */
  async function scanForCall(
    file: string, region: Span, skip: Span[], to: Sym, decorators = false,
  ): Promise<{ called: boolean; doubt?: string }> {
    const blank = blankOf(language, sourceOf(file));
    let doubt: string | undefined;
    for (const m of blank.slice(region.start, region.end).matchAll(new RegExp(`\\b${escape(to.name)}\\b`, "g"))) {
      const at = region.start + m.index!;
      if (skip.some((s) => s.start <= at && at < s.end)) continue;
      const after = blank.slice(at + to.name.length, at + to.name.length + 40);
      const decorating = decorators && !/^\s*\./.test(after)
        && /(^|\n)[ \t]*@\s*(?:[A-Za-z_$][\w$]*\s*\.\s*)*$/.test(blank.slice(Math.max(0, at - 200), at));
      const calling = decorating || /^\s*(::<[^>]*>)?\s*\(/.test(after);
      const found = await resolve(file, at);
      if (found.kind === "sym" && found.sym.file === to.file && found.sym.nameStart === to.nameStart) {
        if (calling) return { called: true };
        doubt ??= "the name appears without being called (passed as a value, or a path)";
      } else if (found.kind === "failed" || found.kind === "none") {
        doubt ??= `the tool could not say what ${to.name} means at one call site`;
      } else if (found.kind === "sym" && found.sym.kind === "routine" && found.sym.name === to.name && calling) {
        doubt ??= `a call to another ${to.name} is here, and dispatch could reach this one`;
      }
    }
    return { called: false, ...(doubt ? { doubt } : {}) };
  }

  /**
   * `@calls` out of a type, read the way a board means it (#346): the type
   * calls the far end when some routine of its own does, or any other code
   * written inside it -- a field's initialiser, a Python class body.
   *
   * "Its own" is the whole question. A routine it inherits from a base in
   * this repository, or a Rust trait's default method, runs as the type and
   * is written somewhere else, so a type with one of those is never called
   * `false` -- only `undecidable`, with the base named.
   */
  async function judgeCallsFromType(from: Sym, to: Sym): Promise<Answer> {
    const own = await ownCode(from);
    if (typeof own === "string") return { truth: "undecidable", why: own };
    let doubt: string | undefined;
    for (const routine of own.routines) {
      const answer = await judgeCalls(routine, to).then((a) => (writesNoCall(routine, a) ? NO_CALL : a));
      if (answer.truth === "true") return { truth: "true", why: `its routine ${routine.name} calls it` };
      if (answer.truth === "undecidable") doubt ??= `its routine ${routine.name}: ${answer.why}`;
    }
    for (const region of own.regions) {
      /*
       * Each routine was read above from its name on -- a default argument's
       * call is in the tool's own call list -- but a decorator sits before the
       * name and runs when the type is made, so that part is left for this
       * scan. Not the name or the signature: the routine's own name reads as
       * a call to itself, and a parameter's type names the far end without
       * running anything.
       */
      const skip = own.routines.filter((r) => r.file === region.file).map((r) => ({ start: r.nameStart, end: r.end }));
      const scan = await scanForCall(region.file, region, skip, to, true);
      if (scan.called) return { truth: "true", why: "code inside the type calls it" };
      doubt ??= scan.doubt;
    }
    doubt ??= own.inherits;
    if (doubt) return { truth: "undecidable", why: doubt };
    if (own.routines.length === 0) return { truth: "false", why: "the type has no routine, and nothing in it calls it" };
    return { truth: "false", why: "every routine of the type was read and none calls it" };
  }

  const NO_CALL: Answer = { truth: "false", why: "the routine's calls were read and none is it" };

  /**
   * Whether a routine the tool would not walk plainly makes no call at all.
   *
   * pyright answers `null` for the outgoing calls of a routine that makes
   * none, and `null` is also what a server says when it did not answer -- so
   * `def tidy(self): return 1` read as a doubt, and one such method made a
   * whole class undecidable. A body with no bracket to call through and no
   * `new` has nothing for a call hierarchy to list, whichever the tool meant.
   *
   * Only asked on a type's routines. A routine at the tail keeps the answer
   * its stored key already has, since those claims are not being re-read.
   */
  function writesNoCall(routine: Sym, answer: Answer): boolean {
    if (answer.truth !== "undecidable" || answer.why !== "the tool would not walk this routine's calls") return false;
    const body = signatureOf(language, routine)?.bodyStart;
    if (body === undefined) return false;
    const text = blankOf(language, sourceOf(routine.file)).slice(body, routine.end);
    return !/[(]|\bnew\b/.test(text);
  }

  /**
   * The code a type owns: the spans it is written in and the routines in
   * them, plus the reason it may run code written elsewhere. A string is a
   * reason the spans themselves could not be found.
   */
  async function ownCode(type: Sym): Promise<
    string | { regions: Array<Span & { file: string }>; routines: Sym[]; inherits?: string }
  > {
    const routinesIn = async (file: string, span: Span) => ((await symbolsOf(rel(file))) ?? [])
      .filter((s) => s.kind === "routine" && s.start >= span.start && s.end <= span.end && s !== type);
    if (language !== "rust" || rustKeyword(type) === "trait") {
      const region = { file: type.file, start: type.start, end: type.end };
      const routines = await routinesIn(type.file, region);
      if (language === "rust") return { regions: [region], routines };
      const bases = basesOf(language, type);
      if (!bases) return "the declaration's bases could not be read";
      let inherits: string | undefined;
      const text = sourceOf(type.file);
      for (const base of bases) {
        // The base's own name, not a type argument inside it: `Generic[T]`
        // inherits from `Generic`, and `T` says nothing about code.
        const chain = /^\s*((?:[A-Za-z_$][\w$]*\s*\.\s*)*)([A-Za-z_$][\w$]*)/.exec(text.slice(base.start, base.end));
        if (!chain) { inherits ??= "one of its bases could not be read"; continue; }
        const name = chain[2]!;
        const found = await resolve(type.file, base.start + chain[0].length - name.length);
        if (found.kind === "outside") continue;
        inherits ??= found.kind === "sym"
          ? `it inherits from ${found.sym.name}, whose routines run as it and are written elsewhere`
          : `the tool could not say what its base ${name} is`;
      }
      return { regions: [region], routines, ...(inherits ? { inherits } : {}) };
    }
    /*
     * A Rust type's routines are in `impl` blocks anywhere in the crate. Each
     * is its own region, and only a block whose type resolves to this one
     * counts: two modules may each declare a `Value`.
     */
    const regions: Array<Span & { file: string }> = [];
    const routines: Sym[] = [];
    let inherits: string | undefined;
    for (const file of crateFiles(type.file)) {
      if (!sourceOf(file).includes(type.name)) continue;
      for (const block of rustImplBlocks(file)) {
        if (block.selfName !== type.name || block.selfAt === undefined) continue;
        const self = await resolve(file, block.selfAt);
        if (self.kind !== "sym") return `an impl of ${type.name}'s own type could not be resolved`;
        if (self.sym.file !== type.file || self.sym.nameStart !== type.nameStart) continue;
        regions.push({ file, start: block.start, end: block.end });
        routines.push(...await routinesIn(file, block));
        if (block.traitAt === undefined) continue;
        const trait = await resolve(file, block.traitAt);
        if (trait.kind === "outside") continue;
        if (trait.kind !== "sym") { inherits ??= `the tool could not say what trait ${block.traitName} is`; continue; }
        // A trait whose methods all end in `;` gives the type nothing to run.
        const declared = blankRust(sourceOf(trait.sym.file)).slice(trait.sym.start, trait.sym.end);
        if (/\bfn\b[^;{]*\{/.test(declared)) {
          inherits ??= `it implements ${trait.sym.name}, whose default routines run as it and are written elsewhere`;
        }
      }
    }
    return { regions, routines, ...(inherits ? { inherits } : {}) };
  }

  async function judgeSignature(word: "takes" | "returns", type: Sym, fn: Sym): Promise<Answer> {
    const signature = signatureOf(language, fn);
    if (!signature) return { truth: "undecidable", why: "the signature could not be read" };
    const enclosing = implAround(fn);
    if (word === "takes") {
      const spans = signature.params.flatMap((p) => (p.type && !p.receiver ? [p.type] : []));
      const { match, doubt } = await namesReach(fn.file, spans, type, enclosing);
      if (match) return { truth: "true", why: "a parameter names it" };
      const unannotated = signature.params.filter((p) => !p.receiver && !p.type).length;
      const receiverIsIt = signature.params.some((p) => p.receiver)
        && (fn.container === type.name || enclosing?.selfName === type.name);
      if (receiverIsIt) return { truth: "undecidable", why: "its only parameter of that type would be the receiver" };
      if (unannotated > 0) return { truth: "undecidable", why: `${unannotated} parameter(s) have no type written` };
      if (doubt) return { truth: "undecidable", why: doubt };
      return { truth: "false", why: "no parameter names it" };
    }
    if (signature.returns === null) {
      if (language === "rust") return { truth: "false", why: "the function returns nothing" };
      return { truth: "undecidable", why: "no return type is written" };
    }
    const { match, doubt } = await namesReach(fn.file, [signature.returns], type, enclosing);
    if (match) return { truth: "true", why: "the return type names it" };
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "the return type does not name it" };
  }

  async function judgeHolds(container: Sym, held: Sym): Promise<Answer> {
    const fields = fieldsOf(language, container);
    if (!fields) return { truth: "undecidable", why: "the field list could not be read" };
    const { match, doubt } = await namesReach(container.file, fields.typed, held, implAround(container));
    if (match) return { truth: "true", why: "a field names it" };
    if (fields.unannotated > 0) return { truth: "undecidable", why: `${fields.unannotated} field(s) have no type written` };
    if (fields.open) return { truth: "undecidable", why: "fields can come from a base or an index signature" };
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "no field has that type" };
  }

  async function judgeBuilds(maker: Sym, made: Sym): Promise<Answer> {
    const text = sourceOf(maker.file);
    const blank = blankOf(language, text);
    let regions: Span[] = [{ start: maker.start, end: maker.end }];
    let open = false;
    if (maker.kind === "routine") {
      regions = [{ start: signatureOf(language, maker)?.bodyStart ?? maker.start, end: maker.end }];
    } else if (language === "rust") {
      /*
       * A Rust type's routines live in `impl` blocks, which may be anywhere --
       * so each block is its own region and the answer is never a plain no.
       * Reading first-block-start to last-block-end as one span, which this
       * did at first, swallows every other type's impls in between and
       * credits them to this one.
       */
      const blocks = rustImplBlocks(maker.file).filter((b) => b.selfName === maker.name);
      if (blocks.length === 0) return { truth: "undecidable", why: "this type's impl blocks are not in this file" };
      regions = blocks.map((b) => ({ start: b.start, end: b.end }));
      open = true;
    }
    let doubt: string | undefined;
    const names = [made.name, ...(language === "rust" && implAround(maker)?.selfName === made.name ? ["Self"] : [])];
    for (const name of names) for (const region of regions) {
      for (const m of blank.slice(region.start, region.end).matchAll(new RegExp(`\\b${escape(name)}\\b`, "g"))) {
        const at = region.start + m.index!;
        const after = blank.slice(at + name.length, at + name.length + 200);
        const before = blank.slice(Math.max(0, at - 30), at);
        const found = name === "Self" ? undefined : await resolve(maker.file, at);
        if (found && !(found.kind === "sym" && found.sym.file === made.file && found.sym.nameStart === made.nameStart)) {
          if (found.kind === "failed" || found.kind === "none") doubt ??= `the tool could not place ${name} here`;
          continue;
        }
        const construction = constructionAt(language, maker.file, blank, at, name, before, after);
        if (construction === "builds") return { truth: "true", why: "the body constructs one here" };
        if (construction === "maybe") doubt ??= "it is named here but not plainly constructed";
      }
    }
    if (maker.kind === "routine") {
      const returns = signatureOf(language, maker)?.returns;
      if (returns) {
        const { match } = await namesReach(maker.file, [returns], made, implAround(maker));
        if (match) doubt ??= "the routine returns one, so something it calls may make it";
      }
    }
    if (open) return { truth: "undecidable", why: doubt ?? "a type's impls may be in another file" };
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "nothing in it makes one" };
  }

  async function judgeAccesses(reader: Sym, type: Sym, member: string | undefined): Promise<Answer> {
    if (!member || !/^[A-Za-z_]\w*$/.test(member)) {
      return { truth: "undecidable", why: "the arrow names no member" };
    }
    const declared = await memberDeclarations(type, member);
    if (declared === undefined) return { truth: "undecidable", why: "the member list could not be read" };
    if (declared.locations.length === 0) {
      if (declared.open) return { truth: "undecidable", why: "the type's members are open" };
      return { truth: "false", why: `the type declares no ${member}` };
    }
    const body: Span = { start: signatureOf(language, reader)?.bodyStart ?? reader.start, end: reader.end };
    const text = sourceOf(reader.file);
    const blank = blankOf(language, text);
    let doubt: string | undefined;
    for (const m of blank.slice(body.start, body.end).matchAll(new RegExp(`\\b${escape(member)}\\b`, "g"))) {
      const at = body.start + m.index!;
      const before = blank.slice(Math.max(0, at - 2), at);
      if (!/[.]$/.test(before) && !(language === "rust" && /::$/.test(blank.slice(Math.max(0, at - 2), at)))) continue;
      const found = await resolve(reader.file, at);
      if (found.kind === "sym") {
        if (declared.locations.some((l) => l.file === found.sym.file && l.at === found.sym.nameStart)) {
          return { truth: "true", why: "the body reads it off that type" };
        }
      } else if (found.kind === "failed" || found.kind === "none") {
        doubt ??= `the tool could not say whose ${member} is read here`;
      } else if (found.kind === "unlisted") {
        doubt ??= `a ${member} is read here and the tool placed it somewhere undeclared`;
      }
    }
    if (/\{[^{}]*\b(\w+\s*,\s*)*\w+\s*\}\s*=|\.\.\.|getattr\(|\[["'`]/.test(blank.slice(body.start, body.end))) {
      doubt ??= "the body reads members without naming them (destructuring, spread or a computed key)";
    }
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: `nothing in the routine reads that type's ${member}` };
  }

  /** Where a type declares a member, following Rust's impls and giving up on inheritance. */
  async function memberDeclarations(type: Sym, member: string): Promise<{ locations: Array<{ file: string; at: number }>; open: boolean } | undefined> {
    if (language !== "rust") {
      const members = membersOf(language, type);
      if (!members) return undefined;
      const at = members.names.get(member) ?? [];
      return { locations: at.map((a) => ({ file: type.file, at: a })), open: members.open };
    }
    const keyword = rustKeyword(type);
    if (keyword === "trait") {
      const text = blankRust(sourceOf(type.file));
      const found = [...text.slice(type.start, type.end).matchAll(new RegExp(`\\bfn\\s+(${escape(member)})\\b`, "g"))]
        .map((m) => ({ file: type.file, at: type.start + m.index! + m[0].length - member.length }));
      return { locations: found, open: false };
    }
    const fields = fieldsOf(language, type);
    if (!fields) return undefined;
    const locations: Array<{ file: string; at: number }> = [];
    const text = blankRust(sourceOf(type.file));
    // A named field of the struct itself.
    for (const m of text.slice(type.start, type.end).matchAll(new RegExp(`(^|[\\s,{])((?:pub(?:\\([^)]*\\))?\\s+)?)(${escape(member)})\\s*:`, "gm"))) {
      locations.push({ file: type.file, at: type.start + m.index! + m[1]!.length + m[2]!.length });
    }
    // A method, in any `impl` block for this type anywhere in the crate.
    for (const file of crateFiles(type.file)) {
      const source = blankRust(sourceOf(file));
      if (!source.includes(member) || !source.includes(type.name)) continue;
      for (const block of rustImplBlocks(file)) {
        if (block.selfName !== type.name) continue;
        for (const m of source.slice(block.start, block.end).matchAll(new RegExp(`\\bfn\\s+(${escape(member)})\\b`, "g"))) {
          locations.push({ file, at: block.start + m.index! + m[0].length - member.length });
        }
      }
    }
    return { locations, open: false };
  }

  const crateCache = new Map<string, string[]>();
  function crateFiles(file: string): string[] {
    let dir = path.dirname(file);
    for (;;) {
      if (existsSync(path.join(dir, "Cargo.toml")) || dir === root || dir === path.dirname(dir)) break;
      dir = path.dirname(dir);
    }
    const cached = crateCache.get(dir);
    if (cached) return cached;
    const out: string[] = [];
    const walk = (at: string, depth: number) => {
      if (depth > 6) return;
      let entries: string[];
      try { entries = readdirSync(at); } catch { return; }
      for (const entry of entries) {
        if (entry === "target" || entry === ".git" || entry === "tests" || entry === "benches") continue;
        const full = path.join(at, entry);
        let stat;
        try { stat = statSync(full); } catch { continue; }
        if (stat.isDirectory()) walk(full, depth + 1);
        else if (entry.endsWith(".rs")) out.push(full);
      }
    };
    walk(dir, 0);
    crateCache.set(dir, out);
    return out;
  }

  async function judgeConforms(sub: Sym, base: Sym): Promise<Answer> {
    if (language === "rust") {
      if (rustKeyword(base) !== "trait") return { truth: "false", why: "the far end is not a trait, so nothing can implement it" };
      if (rustKeyword(sub) === "trait") {
        const supers = basesOf(language, sub);
        if (!supers) return { truth: "undecidable", why: "the trait header could not be read" };
        const { match, doubt } = await namesReach(sub.file, supers, base);
        if (match) return { truth: "true", why: "it is a supertrait" };
        if (doubt) return { truth: "undecidable", why: doubt };
        return { truth: "false", why: "the trait does not require it" };
      }
      const derive = /#\[derive\(([^)]*)\)\]/g;
      const above = sourceOf(sub.file).slice(Math.max(0, sub.start - 400), sub.nameStart);
      for (const m of above.matchAll(derive)) {
        if (m[1]!.split(",").some((n) => n.trim().split("::").pop() === base.name)) {
          return { truth: "true", why: "it is derived" };
        }
      }
      const impls = await tooling.implementations(base);
      if (impls === undefined) return { truth: "undecidable", why: "the tool would not list the trait's impls" };
      let doubt: string | undefined;
      for (const impl of impls) {
        const block = rustImplBlocks(impl.file).find((b) => b.start >= impl.start - 40 && b.start <= impl.start + 40)
          ?? rustImplBlocks(impl.file).find((b) => b.start <= impl.start && impl.start < b.end);
        if (!block?.selfAt) { doubt ??= "an impl's own type could not be read"; continue; }
        if (block.selfName === sub.name) {
          const found = await resolve(impl.file, block.selfAt);
          if (found.kind === "sym" && found.sym.file === sub.file && found.sym.nameStart === sub.nameStart) {
            return { truth: "true", why: "the trait is implemented for it" };
          }
          if (found.kind !== "sym") doubt ??= "an impl's own type did not resolve";
        } else {
          const found = await resolve(impl.file, block.selfAt);
          if (found.kind === "unlisted") doubt ??= "a blanket impl could cover it";
        }
      }
      if (doubt) return { truth: "undecidable", why: doubt };
      return { truth: "false", why: "no impl of that trait is for this type" };
    }
    const bases = basesOf(language, sub);
    if (!bases) return { truth: "undecidable", why: "the declaration's bases could not be read" };
    if (bases.length === 0) return { truth: "false", why: "it extends and implements nothing" };
    const { match, doubt } = await namesReach(sub.file, bases, base, undefined);
    if (match) return { truth: "true", why: "the declaration names it as a base" };
    // A base of a base is still a supertype, and calling that "wrong" is a
    // dispute about the word rather than a fact, so it leaves the score.
    for (const span of bases) {
      const head = identifiers(sourceOf(sub.file), span, language)[0];
      if (!head) continue;
      const found = await resolve(sub.file, head.at);
      if (found.kind === "sym" && (await reachesBase(found.sym, base, 0))) {
        return { truth: "undecidable", why: "it is a base of a base, not one written here" };
      }
    }
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "the declaration does not name it as a base" };
  }

  async function reachesBase(sym: Sym, base: Sym, depth: number): Promise<boolean> {
    if (depth > 4) return false;
    if (sym.file === base.file && sym.nameStart === base.nameStart) return true;
    const bases = basesOf(language, sym);
    if (!bases) return false;
    for (const span of bases) {
      const head = identifiers(sourceOf(sym.file), span, language)[0];
      if (!head) continue;
      const found = await resolve(sym.file, head.at);
      if (found.kind === "sym" && (await reachesBase(found.sym, base, depth + 1))) return true;
    }
    return false;
  }

  async function judgeNeeds(fromRef: string, toRef: string): Promise<Answer> {
    const fromFile = abs(fromRef.split("#")[0]!);
    const toFile = abs(toRef.split("#")[0]!);
    if (!existsSync(fromFile) || !existsSync(toFile)) return { truth: "undecidable", why: "an end is not a file" };
    if (statSync(fromFile).isDirectory() || statSync(toFile).isDirectory()) {
      return { truth: "undecidable", why: "an end is a directory" };
    }
    if (fromFile === toFile) return { truth: "undecidable", why: "both ends are the same file" };
    const imports = await tooling.importsOf(fromFile);
    if (!imports) return { truth: "undecidable", why: "the file's imports could not be read" };
    let doubt: string | undefined;
    for (const entry of imports) {
      if (entry.file === toFile) {
        if (entry.mod) { doubt ??= "the only link is a `mod` declaration, not a use"; continue; }
        return { truth: "true", why: `it imports it (${entry.text})` };
      }
      if (entry.file === undefined) doubt ??= `an import (${entry.text}) did not resolve`;
    }
    const text = blankOf(language, sourceOf(fromFile));
    if (/\bimport\s+\*|\buse\s+[^;]*::\*/.test(text)) doubt ??= "a glob import could bring it in";
    if (doubt) return { truth: "undecidable", why: doubt };
    return { truth: "false", why: "nothing in it imports that file" };
  }

  /**
   * `@depends`: the same question with the chain allowed (#323).
   *
   * Breadth-first over the compiler's own import edges, so an arrow drawn
   * `app -> database` with files in between is true the way its author meant
   * it. A file the tool could not read anywhere on the walk leaves the answer
   * undecidable rather than false, for the reason `judgeNeeds` does the same:
   * a referee that guesses is worse than one that abstains.
   */
  async function judgeDepends(fromRef: string, toRef: string): Promise<Answer> {
    const direct = await judgeNeeds(fromRef, toRef);
    if (direct.truth !== "false") return direct;
    const toFile = abs(toRef.split("#")[0]!);
    const seen = new Set([abs(fromRef.split("#")[0]!)]);
    const queue = [...seen];
    let doubt: string | undefined;
    for (let next = 0; next < queue.length && seen.size < 2000; next += 1) {
      const imports = await tooling.importsOf(queue[next]!);
      if (!imports) { doubt ??= "a file on the way could not be read"; continue; }
      for (const entry of imports) {
        if (entry.file === undefined) { doubt ??= `an import (${entry.text}) did not resolve`; continue; }
        if (entry.file === toFile) {
          return { truth: "true", why: `it reaches it through ${queue[next]!.split("/").pop()}` };
        }
        if (seen.has(entry.file)) continue;
        seen.add(entry.file);
        queue.push(entry.file);
      }
    }
    return doubt ? { truth: "undecidable", why: doubt } : { truth: "false", why: "nothing it imports leads there" };
  }

  async function judge(claim: ClaimUnderTest): Promise<Answer> {
    if (claim.word === "needs") return judgeNeeds(claim.from, claim.to);
    if (claim.word === "depends") return judgeDepends(claim.from, claim.to);
    const ends: Array<[string, Sym[] | undefined]> = [];
    for (const ref of [claim.from, claim.to]) {
      if (!ref.includes("#")) { ends.push([ref, undefined]); continue; }
      ends.push([ref, await candidates(ref)]);
    }
    const [[fromRef, fromSyms], [toRef, toSyms]] = ends as [[string, Sym[] | undefined], [string, Sym[] | undefined]];
    if (!fromRef.includes("#") || !toRef.includes("#")) {
      return { truth: "undecidable", why: "an end names a file rather than a declaration" };
    }
    if (!fromSyms || !toSyms) return { truth: "undecidable", why: "an end's file could not be read" };
    if (fromSyms.length === 0 || toSyms.length === 0) {
      return { truth: "undecidable", why: "an end names nothing the tool declares" };
    }
    const answers: Answer[] = [];
    for (const from of fromSyms.slice(0, 3)) {
      for (const to of toSyms.slice(0, 3)) {
        answers.push(await judgeOne(claim, from, to));
      }
    }
    const first = answers[0]!;
    if (answers.every((a) => a.truth === first.truth)) return first;
    // Two declarations of one name that disagree: the ref does not say which.
    return { truth: "undecidable", why: "the ref could mean more than one declaration, and they differ" };
  }

  async function judgeOne(claim: ClaimUnderTest, from: Sym, to: Sym): Promise<Answer> {
    /*
     * A type at the tail of `@calls` is read through its own routines (#346),
     * so only the far end's kind is still a mistake. `kindProblemFor` keeps
     * saying a type cannot call: plants are grown from it, and the planted
     * population is not this change's to move.
     */
    if (claim.word === "calls" && from.kind === "type") {
      const far = kindProblem("calls", { ...from, kind: "routine" }, to);
      if (far) return { truth: "false", why: far };
      return judgeCallsFromType(from, to);
    }
    const problem = kindProblem(claim.word, from, to);
    if (problem) return { truth: "false", why: problem };
    switch (claim.word) {
      case "calls": return judgeCalls(from, to);
      case "takes": return judgeSignature("takes", from, to);
      case "returns": return judgeSignature("returns", from, to);
      case "holds": return judgeHolds(from, to);
      case "builds": return judgeBuilds(from, to);
      case "accesses": return judgeAccesses(from, to, claim.member);
      case "conforms": return judgeConforms(from, to);
      case "feeds": return { truth: "undecidable", why: "a value's journey cannot be enumerated" };
      case "needs":
      case "depends":
        return { truth: "undecidable", why: "handled above" };
    }
  }

  return {
    language, root, judge, candidates, symbolsOf,
    version: () => tooling.version(),
    close: () => tooling.close(),
  };
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a name is a value being made rather than merely mentioned.
 *
 * The Rust half has to keep three things apart that all read `Name {`:
 * a struct literal, a pattern being matched, and a **return type followed by
 * the body's own brace** -- `fn glob(&self) -> &Glob {`. The last one is the
 * shape that fooled the first cut of this file, which reported that
 * `GlobMatcher` constructs a `Glob` because its accessor returns one.
 */
export function constructionAt(
  language: Language, file: string, blank: string, at: number, name: string, before: string, after: string,
): "builds" | "maybe" | "no" {
  if (language === "ts") {
    if (/\bnew\s+$/.test(before)) return "builds";
    if (isTsx(file) && /<\s*$/.test(before)) return "builds";
    if (/^\s*\(/.test(after) && /^[A-Z]/.test(name)) return "maybe";
    return "maybe";
  }
  if (language === "python") {
    if (/^\s*\(/.test(after)) return isPattern(after) ? "maybe" : "builds";
    return "maybe";
  }
  // Rust: a struct literal, a tuple struct call, or an enum variant -- unless
  // the same shape is a pattern being matched, or a type rather than a value.
  if (/(->|:|<|\bas|\bimpl|\bfor|\bdyn|\bstruct|\benum|\btrait|\btype|\bfn)\s*[&*]?\s*(mut\s+)?$/.test(before)) {
    return "maybe";
  }
  const variant = /^\s*::\s*[A-Z]\w*/.exec(after);
  const tail = variant ? after.slice(variant[0].length) : after;
  if (/^\s*[{(]/.test(tail)) {
    if (/\b(match|if\s+let|while\s+let|let)\s+[^=;]*$/.test(before) || isPattern(tail)) return "maybe";
    if (/\b(struct|enum|impl|for|fn|trait|type)\s+$/.test(before)) return "no";
    return "builds";
  }
  if (variant) return "builds";
  return "maybe";
}

/** A `Foo { a } =>` or `Foo { a } =` is a pattern, not a value. */
function isPattern(after: string): boolean {
  const open = after.search(/[{(]/);
  if (open < 0) return false;
  const close = matchAfter(after, open);
  if (close < 0) return false;
  return /^\s*(=>|=[^=]|\|)/.test(after.slice(close));
}

function matchAfter(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return -1;
}
