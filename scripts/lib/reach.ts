/**
 * The backward reach walks behind `measure:reach` (#58).
 *
 * In a module of their own so each shape they handle can be tested on its own,
 * rather than only through a corpus run whose referee reaches three doors per
 * project. `scripts/measure-reach.mts` says what the walks are for and how they
 * are scored; this file is the walks.
 *
 * `S(D)` is every routine that could possibly reach door `D`, built backwards
 * from the door and over-approximated on purpose: a routine outside it provably
 * cannot reach the door. Two walks build it.
 *
 * - `calls` indexes a routine by the names it **calls**.
 * - `mentions` indexes every name a routine's text **uses**, called or not,
 *   treats a bare call to a name the file binds as a call to anything, and counts
 *   naming a class as running its constructor.
 *
 * Either way, a routine holding a call with no readable name joins every set.
 */
import path from "node:path";

import { refereeRoutines, stripNoise } from "./call-scan";
import { sourceFiles } from "./source-files";

import { callSitesIn, type CallSide } from "../../src/engine/calls";
import { readDependencies } from "../../src/engine/deps";
import { createWorkspace } from "../../src/engine/drift";
import { outsideCallsIn, type OutsideKind } from "../../src/engine/outside";
import { each, languageOf, parseSource, resetEngineCache, type Language, type Node } from "../../src/engine/parse";
import { type ConfigCache } from "../../src/engine/resolve";

export const TEST_PATH = /(^|\/)(tests?|__tests__|spec|benches|examples|fixtures|testing)(\/|$)|\.(test|spec)\.|(^|\/)test_[^/]*\.py$|_test\.(py|rs)$/;

export type Family = "ts" | "python" | "rust";
export const familyOf = (language: Language): Family | undefined =>
  language === "ts" || language === "tsx" || language === "js" ? "ts"
    : language === "python" ? "python" : language === "rust" ? "rust" : undefined;

export type Walk = "calls" | "mentions";
export const WALKS: readonly Walk[] = ["calls", "mentions"];

/**
 * What the text-scan referee is given, with the two Rust shapes that are not
 * calls taken out first.
 *
 * The scan finds a call by the shape of `name(`, which in Rust also matches
 * inside an attribute -- `#[cfg(any(feature = "std"))]` -- and it does not know
 * that a capitalised callee is a tuple-struct or enum-variant construction.
 * Those two were the whole of the first run's 13.0% "unseen" on anyhow: `cfg`
 * 21, `any` 12, `all` 6, then `Err`, `Ok`, `Some`. Neither is a call node in the
 * grammar, so counting them measured the referee rather than the reader.
 */
function refereeInput(source: string, language: Language): string {
  const stripped = stripNoise(source, language);
  if (language !== "rust") return stripped;
  return stripped.replace(/#!?\[[^\n]*\]/g, (text) => " ".repeat(text.length));
}

/* -- names in a file, and the ones it binds ------------------------------- */

/** A name a reader would recognise, wherever a grammar puts one -- `calls.ts`'s own rule. */
const NAME_LEAF = /identifier$|^field_identifier$|^property_identifier$/;

/** An operator that binds its left-hand side rather than reading it. */
function bindsLeft(node: Node): boolean {
  const operator = node.childForFieldName("operator");
  if (!operator) return true; // `x = ..`, `for x in ..`: the grammar gives it no operator field
  const text = operator.text;
  if (text === "in" || text === "of") return true;
  return text.endsWith("=") && !["==", "!=", "<=", ">=", "===", "!=="].includes(text);
}

interface NamedLeaf { line: number; text: string }

/**
 * Every name leaf in a file, and every name the file binds, each with its line.
 *
 * Bindings are read by field, never by node type (`docs/reading-a-grammar.md`):
 * `parameters`, `pattern` and `alias` bind what is under them, `left` binds when
 * the operator is an assignment rather than arithmetic, and `name` binds when the
 * same node carries a `value` -- a declarator, a keyword argument, a default.
 */
function namesIn(source: string, language: Language): { leaves: NamedLeaf[]; bound: Set<string> } | undefined {
  const tree = parseSource(source, language);
  if (!tree) return undefined;
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") lineStarts.push(index + 1);
  const lineOf = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle; else high = middle - 1;
    }
    return low + 1;
  };
  const leaves: NamedLeaf[] = [];
  const bound = new Set<string>();
  const bindUnder = (node: Node) => each(node, (one) => {
    if (one.childCount === 0 && NAME_LEAF.test(one.type)) bound.add(one.text);
  });
  each(tree.rootNode, (node) => {
    if (node.childCount === 0 && NAME_LEAF.test(node.type)) leaves.push({ line: lineOf(node.startIndex), text: node.text });
    for (const field of ["parameters", "pattern", "alias"]) {
      const child = node.childForFieldName(field);
      if (child) bindUnder(child);
    }
    const left = node.childForFieldName("left");
    if (left && bindsLeft(node)) bindUnder(left);
    const name = node.childForFieldName("name");
    if (name && node.childForFieldName("value")) bindUnder(name);
  });
  return { leaves, bound };
}

/** The leaves on lines `[from, to]`, from a list already in document order. */
function leavesWithin(leaves: NamedLeaf[], from: number, to: number): NamedLeaf[] {
  let low = 0;
  let high = leaves.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (leaves[middle]!.line < from) low = middle + 1; else high = middle;
  }
  const out: NamedLeaf[] = [];
  for (let index = low; index < leaves.length && leaves[index]!.line <= to; index += 1) out.push(leaves[index]!);
  return out;
}

/* -- constructors --------------------------------------------------------- */

/**
 * The routines a language runs when an object is built, which code names by the
 * class and never by the method -- `Store(path)`, `new Store(path)`. On httpx's
 * recorded test run that was both false accusations the walk still made:
 * `_init_transport` returns `HTTPTransport(..)`, and only its `__init__` opens
 * the SSL context.
 *
 * A list, and a fact about each language rather than a grammar spelling: no field
 * says a method is a constructor. Rust has none -- `Type::new` is a named call.
 */
const CONSTRUCTORS: Record<Family, ReadonlySet<string>> = {
  python: new Set(["__init__", "__new__", "__post_init__"]),
  ts: new Set(["constructor"]),
  rust: new Set(),
};

interface ClassShape { name: string; bases: string[]; constructors: Set<string> }

/**
 * Every class-like declaration in a file, its bases, and the constructors it
 * declares itself.
 *
 * Found by structure: a node with a `name` and a `body` and no `parameters` holds
 * members -- a class, and harmlessly an interface or a struct, which declare no
 * constructors. Its bases are every name under the children that are not its
 * name, body or type parameters: `(Base)`, `extends Base implements Shape`.
 * Reading too many names there only makes a set larger, the safe direction.
 */
function classesIn(source: string, language: Language): ClassShape[] {
  const family = familyOf(language);
  const tree = parseSource(source, language);
  if (!tree || !family) return [];
  const constructors = CONSTRUCTORS[family];
  const classes: ClassShape[] = [];
  const walk = (node: Node, owner: ClassShape | undefined): void => {
    const name = node.childForFieldName("name");
    const body = node.childForFieldName("body");
    const parameters = node.childForFieldName("parameters") ?? node.childForFieldName("value")?.childForFieldName("parameters");
    let here = owner;
    if (name && name.childCount === 0 && body && !parameters) {
      const own = new Set([name.id, body.id, node.childForFieldName("type_parameters")?.id]);
      const bases: string[] = [];
      for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);
        if (!child || own.has(child.id)) continue;
        each(child, (leaf) => { if (leaf.childCount === 0 && NAME_LEAF.test(leaf.type)) bases.push(leaf.text); });
      }
      here = { name: name.text, bases, constructors: new Set() };
      classes.push(here);
    } else if (name && parameters && owner && constructors.has(name.text)) {
      owner.constructors.add(name.text);
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child) walk(child, here);
    }
  };
  walk(tree.rootNode, undefined);
  return classes;
}

/* -- one repository's routines -------------------------------------------- */

/** A routine, as the walks identify one. `file` is repo-relative. */
export interface Routine {
  id: string;
  file: string;
  name: string;
  line: number;
  language: Language;
  /** The calls written here, with where the reader placed each when it could. */
  sites: Array<{ name: string; file?: string; receiver: boolean; nameAt?: { start: number; end: number } }>;
  /** Every name this routine's text uses, and how often. Its own declared name once less. */
  mentions: Map<string, number>;
  /** A door: this routine talks to the outside directly. */
  door?: OutsideKind;
}

export interface Read {
  routines: Map<string, Routine>;
  /** Routines holding a call to a name, per name. */
  callersOfName: Map<string, Routine[]>;
  /** Routines whose text uses a name at all, per name. */
  mentionersOfName: Map<string, Routine[]>;
  /** A call with no readable name: could be a call to anything. Both walks. */
  unnamedCallers: Set<string>;
  /** A bare call to a name the file binds -- a parameter, a variable. `mentions` only. */
  localCallers: Set<string>;
  /** A constructor routine's id, to the classes in its file that declare it. */
  constructorClasses: Map<string, Set<string>>;
  /** A base class name, to the classes listing it and whether each declares its own constructor. */
  subclasses: Map<string, Array<{ name: string; ownConstructor: boolean }>>;
  refereeUnseen: number;
  refereeSites: number;
}

/** Every routine under `dir` outside test code, indexed for both walks. */
export function readRepo(dir: string): Read {
  const workspace = createWorkspace(dir);
  const configs: ConfigCache = new Map();
  const sources = new Map<string, string>();
  const importsOf = new Map<string, CallSide["imports"]>();
  const read = (rel: string): string | undefined => {
    if (sources.has(rel)) return sources.get(rel);
    const absolute = workspace.resolve(rel);
    if (!absolute || workspace.stat(absolute) !== "file") return undefined;
    const text = workspace.read(absolute);
    sources.set(rel, text);
    return text;
  };
  const imports = (rel: string, source: string): CallSide["imports"] => {
    const cached = importsOf.get(rel);
    if (cached) return cached;
    const declared = readDependencies(rel, source, workspace, configs)?.dependencies ?? [];
    const list = declared.map((one) => ({ specifier: one.specifier, ...(one.file ? { file: one.file } : {}) }));
    importsOf.set(rel, list);
    return list;
  };
  const open = (rel: string) => {
    const source = read(rel);
    const language = languageOf(rel);
    if (source === undefined || !language) return undefined;
    return { source, language, imports: imports(rel, source) };
  };

  const routines = new Map<string, Routine>();
  const callersOfName = new Map<string, Routine[]>();
  const mentionersOfName = new Map<string, Routine[]>();
  const unnamedCallers = new Set<string>();
  const localCallers = new Set<string>();
  const constructorClasses = new Map<string, Set<string>>();
  const subclasses = new Map<string, Array<{ name: string; ownConstructor: boolean }>>();
  let refereeUnseen = 0;
  let refereeSites = 0;
  const index = (into: Map<string, Routine[]>, name: string, routine: Routine) => {
    const list = into.get(name) ?? [];
    if (list[list.length - 1]?.id !== routine.id) list.push(routine);
    into.set(name, list);
  };

  for (const absolute of sourceFiles(dir)) {
    const language = languageOf(absolute);
    if (!language || !familyOf(language)) continue;
    const rel = path.relative(dir, absolute);
    if (TEST_PATH.test(rel)) continue;
    const source = read(rel);
    if (source === undefined || source.length > 1_000_000) continue;

    const reading = callSitesIn({ file: rel, source, language, imports: imports(rel, source), open });
    if (!reading.read) continue;
    const names = namesIn(source, language);
    for (const shape of classesIn(source, language)) {
      for (const constructor of shape.constructors) {
        const id = `${rel}#${constructor}`;
        constructorClasses.set(id, (constructorClasses.get(id) ?? new Set()).add(shape.name));
      }
      for (const base of shape.bases) {
        const list = subclasses.get(base) ?? [];
        list.push({ name: shape.name, ownConstructor: shape.constructors.size > 0 });
        subclasses.set(base, list);
      }
    }

    // Doors, by the reader `measure:doors` already measured.
    const doorRoutines = new Map<string, OutsideKind>();
    for (const call of outsideCallsIn(source, language).calls) {
      if (call.reading.verdict !== "outside" || !call.routine) continue;
      doorRoutines.set(call.routine, call.reading.kind);
    }

    for (const body of reading.bodies) {
      const id = `${rel}#${body.routine}`;
      const mentions = new Map<string, number>();
      for (const leaf of leavesWithin(names?.leaves ?? [], body.line, body.line + body.lines - 1)) {
        mentions.set(leaf.text, (mentions.get(leaf.text) ?? 0) + 1);
      }
      // Its own name in its own declaration is not a use of itself.
      const own = mentions.get(body.routine);
      if (own !== undefined) { if (own <= 1) mentions.delete(body.routine); else mentions.set(body.routine, own - 1); }

      /*
       * Two routines of one name in one file collapse into one id. They are
       * merged, never replaced: a replacement drops the first one's calls, and a
       * dropped call is a caller nobody adds.
       */
      const previous = routines.get(id);
      const routine: Routine = previous ?? {
        id, file: rel, name: body.routine, line: body.line, language, sites: [], mentions: new Map(),
      };
      for (const site of body.sites) {
        routine.sites.push({
          name: site.name, receiver: site.receiver,
          ...(site.file ? { file: site.file } : {}),
          ...(site.nameAt ? { nameAt: site.nameAt } : {}),
        });
      }
      for (const [name, count] of mentions) routine.mentions.set(name, (routine.mentions.get(name) ?? 0) + count);
      if (doorRoutines.has(body.routine)) routine.door = doorRoutines.get(body.routine)!;
      routines.set(id, routine);

      if (body.sites.some((site) => site.name === "")) unnamedCallers.add(id);
      if (body.sites.some((site) => site.name && !site.file && !site.receiver && names?.bound.has(site.name))) {
        localCallers.add(id);
      }
      for (const site of body.sites) if (site.name) index(callersOfName, site.name, routine);
      for (const name of mentions.keys()) index(mentionersOfName, name, routine);
    }

    /*
     * The premise, refereed: a call site the reader never saw is a caller
     * nobody adds. Compared per file rather than per routine, because the scan
     * and the reader bound a routine differently and a call inside a nested
     * closure then lands in two different places without either being wrong.
     */
    const seenInFile = new Set(reading.bodies.flatMap((body) => body.sites.map((site) => site.name)).filter(Boolean));
    for (const one of refereeRoutines(refereeInput(source, language), language)) {
      for (const call of one.calls) {
        if (call.construction) continue; // not a call node in any of these grammars
        if (language === "rust" && /^[A-Z]/.test(call.name)) continue; // `Ok(..)`: a constructor
        refereeSites += 1;
        if (!seenInFile.has(call.name)) refereeUnseen += 1;
      }
    }
  }
  resetEngineCache();
  return {
    routines, callersOfName, mentionersOfName, unnamedCallers, localCallers,
    constructorClasses, subclasses, refereeUnseen, refereeSites,
  };
}

/* -- the backward walks --------------------------------------------------- */

export interface WalkOptions {
  /**
   * Rule a caller out when every use of the name is a call the reader placed at
   * another file. On by default; `--no-prune` measures what trusting a placement
   * is worth, since one placement is a guess: `self.foo()` is placed in the
   * caller's own file, and an inherited `foo` lives in the base class's.
   */
  prune?: boolean;
}

/** Whether `caller` might lead into `target`, by one walk's rule. */
export function mayLeadInto(caller: Routine, target: Routine, walk: Walk, options: WalkOptions = {}): boolean {
  const named = caller.sites.filter((site) => site.name === target.name);
  const uses = walk === "calls" ? named.length : (caller.mentions.get(target.name) ?? 0);
  if (options.prune === false) return uses > 0;
  const elsewhere = named.filter((site) => site.file !== undefined && site.file !== target.file).length;
  return uses > elsewhere;
}

/**
 * The class names whose construction runs this routine: the classes in its file
 * that declare it, and every subclass that inherits it by declaring no
 * constructor of its own. Empty for a routine that is not a constructor.
 *
 * A subclass that declares its own constructor is not added: if that one calls
 * `super().__init__()` it uses the name `__init__`, and joins the set by the
 * ordinary rule before its own class name is ever needed.
 */
export function constructingNames(read: Read, routineId: string): Set<string> {
  const names = new Set(read.constructorClasses.get(routineId) ?? []);
  const frontier = [...names];
  while (frontier.length > 0) {
    const base = frontier.pop()!;
    for (const sub of read.subclasses.get(base) ?? []) {
      if (sub.ownConstructor || names.has(sub.name)) continue;
      names.add(sub.name);
      frontier.push(sub.name);
    }
  }
  return names;
}

/** Whether `caller` names a class whose construction runs `callee`. */
export function constructs(read: Read, caller: Routine, callee: Routine): boolean {
  for (const name of constructingNames(read, callee.id)) if ((caller.mentions.get(name) ?? 0) > 0) return true;
  return false;
}

/** Routines joining every set, whatever the door: a call that could be to anything. */
export function anythingCallers(read: Read, walk: Walk): Set<string> {
  return walk === "calls" ? read.unnamedCallers : new Set([...read.unnamedCallers, ...read.localCallers]);
}

/** Every routine that could possibly reach `door`, over-approximated on purpose. */
export function couldReach(
  door: Routine, read: Read, walk: Walk, options: WalkOptions = {},
): { set: Set<string>; fromAnything: number } {
  const set = new Set<string>([door.id, ...anythingCallers(read, walk)]);
  const fromAnything = set.size - 1;
  const frontier: Routine[] = [...set].map((id) => read.routines.get(id)).filter((one): one is Routine => one !== undefined);
  const index = walk === "calls" ? read.callersOfName : read.mentionersOfName;
  while (frontier.length > 0) {
    const current = frontier.pop()!;
    for (const caller of index.get(current.name) ?? []) {
      if (set.has(caller.id) || !mayLeadInto(caller, current, walk, options)) continue;
      set.add(caller.id);
      frontier.push(caller);
    }
    // Building the object runs the constructor, and the code names only the class.
    // `mentions` only: `calls` stays the baseline it was measured as.
    if (walk !== "mentions") continue;
    for (const name of constructingNames(read, current.id)) {
      for (const caller of read.mentionersOfName.get(name) ?? []) {
        if (set.has(caller.id)) continue;
        set.add(caller.id);
        frontier.push(caller);
      }
    }
  }
  return { set, fromAnything };
}
