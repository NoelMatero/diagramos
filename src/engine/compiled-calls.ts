/**
 * What rustc says a Rust function calls (#357).
 *
 * ## The bad outcome
 *
 * Half the wrong `@calls` arrows planted on Rust boards went unanswered, and
 * the wall was one thing: a call written inside a macro. clap writes
 * `ok!(self.parse(..))` all over its parser, so `get_matches_with` reads as a
 * routine that makes two calls when it makes fourteen. The text reader sees a
 * token tree and has to stop -- it cannot close a body around calls nobody can
 * see. rust-analyzer's call hierarchy has the same hole and hides it: it leaves
 * every call inside a macro off the list without saying so (#355), which is
 * how #355's "trust the language server" arm called a correct clap arrow wrong.
 *
 * rustc does not have the hole. `--emit=mir` prints every body after macro
 * expansion, with every call it makes as a terminator, and a call it cannot
 * pin down -- through a function pointer, through a closure somebody passed
 * in -- is printed as exactly that rather than left out. #355 put it to the
 * planted bench: Rust went from 26 to 52 of 73 planted mistakes caught with
 * no correct arrow called wrong, and on its own it found the call on all 20
 * correct Rust arrows it could read.
 *
 * ## What this file is, and is not
 *
 * The pure half: read a dump, find the body a board's routine is, and say
 * whether that body could reach the head. Building the dump is
 * `referee-rustc.ts`'s; deciding what an arrow is told is `calls.ts`'s.
 *
 * Everything here errs one way. A body that cannot be matched to exactly one
 * declaration with the same number of parameters is no answer, and so is one
 * whose declaration build settings can switch parts of. The caller then falls
 * back to the text reading, which is what it did before this existed.
 *
 * ## The four ways a "never" from this list would be wrong
 *
 * Every one of them is a call that happens and is not written as a call to
 * the head's name. The review on #357 named them, and each is a guard below:
 *
 *   a call through a trait       `<T as Transport>::handle` runs whichever
 *                                `handle` `T` has, and that one may call the
 *                                head; on a type parameter, `Self`, `dyn` or
 *                                `impl Trait` nothing is refuted at all
 *   a function passed as a value `map(double)` calls nothing named `double`
 *                                here; the name is in the body, which is
 *                                enough to stay quiet
 *   a call the language makes    `a + b`, `?`, `format!("{}", x)` and a
 *                                value going out of scope run a trait's
 *                                method without the method's name anywhere;
 *                                a head in `impl Trait for X` whose `X` the
 *                                body mentions is left alone
 *   code the build left out      `#[cfg(..)]` on the routine, on what holds
 *                                it, or inside it -- rustc compiled one
 *                                setting, and a call in another is not in
 *                                the list
 */
import path from "node:path";

import { parseSource, type Node } from "./parse";

/** One call rustc lists in a body. */
export type CompiledCall =
  /**
   * A call to a function rustc named. `name` is the last segment: `handle` for
   * `<T as Transport>::handle`. `through` is the type on the left of `as`,
   * when the call was written through a trait -- `T` there, `Http` in
   * `<Http as Transport>::handle`.
   */
  | { kind: "named"; name: string; through?: string }
  /** A call whose target is a value: a function pointer, a closure passed in, `dyn Fn`. */
  | { kind: "opaque"; wrote: string };

/** One function's body, with its closures and its `async` body folded in. */
export interface CompiledBody {
  /** The path rustc printed, without parameters: `<impl at src/a.rs:4:1: 4:9>::run`, `parse`. */
  path: string;
  /** How many parameters the header declares, `self` included. */
  params: number;
  calls: CompiledCall[];
  /**
   * How many values the body drops. A drop runs the value's `Drop`, if its
   * type has one, and MIR writes it as `drop(_n)` rather than as a call.
   */
  drops: number;
  /**
   * Every identifier the body mentions, locals' names from `debug` lines
   * included. Two readers use it and both err the safe way with more words:
   * a head the body so much as names is not refuted, and a call the text
   * shows is looked for here before the list is trusted at all.
   */
  words: Set<string>;
  /**
   * Every type the body creates a value of, by its last path segment (#362):
   * the head of every aggregate rustc writes -- `Widget { .. }`, `Tagged(..)`,
   * `Shape::Circle { .. }` gives both `Shape` and `Circle` -- and the type of
   * every value a call hands back, read off the local the call writes into.
   * `Widget::default()`, `x.clone()` and `x.into()` into a `Widget` all land
   * here, which is the point: the text cannot say what `x.clone()` makes, and
   * this can. A reference is looked through (`&mut Widget` counts), which is
   * the quiet side for an accusation resting on this set being without B.
   */
  made: Set<string>;
}

/** One crate's bodies, indexed the two ways a declaration can be found. */
export interface CompiledCrate {
  /** Repo-relative files rustc read to build the crate: every module, and nothing else. */
  files: ReadonlySet<string>;
  /** The crate's root file, repo-relative: `src/lib.rs`. */
  root: string;
  /** Methods, by the `impl` holding them: `src/a.rs:12` -> the bodies declared inside it. */
  byImpl: Map<string, CompiledBody[]>;
  /** Everything else, by its last segment. */
  byName: Map<string, CompiledBody[]>;
}

/** Where a dump's relative paths start from, and where the board's start from. */
export interface CompiledPlaces {
  /** Absolute: the directory cargo ran rustc in, which is the workspace root. */
  workspace: string;
  /** Absolute: the repository the board lives in. */
  repo: string;
  /** Absolute: the crate's root file. */
  root: string;
}

/**
 * A dump and its dep-info, read into a crate.
 *
 * `depInfo` is the Makefile rule rustc writes with `--emit=dep-info`: the
 * first rule's prerequisites are every source file the crate was built from.
 * That is what tells a file rustc compiled from one it never saw -- a binary
 * target's `main.rs`, a module switched off by a feature -- and the second kind
 * must be no answer, never a routine that calls nothing.
 */
export function readCompiledCrate(mir: string, depInfo: string, places: CompiledPlaces): CompiledCrate {
  const toRepo = (written: string): string | undefined => {
    const relative = path.relative(places.repo, path.resolve(places.workspace, written));
    if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    return relative.split(path.sep).join("/");
  };

  const files = new Set<string>();
  const rule = depInfo.split("\n").find((line) => line.includes(": "));
  if (rule) {
    const prerequisites = rule.slice(rule.indexOf(": ") + 2);
    for (const written of prerequisites.split(/(?<!\\) /)) {
      const file = written.replace(/\\ /g, " ").trim();
      if (!file.endsWith(".rs")) continue;
      const inRepo = toRepo(file);
      if (inRepo) files.add(inRepo);
    }
  }

  const bodies = bodiesIn(mir);
  const byImpl = new Map<string, CompiledBody[]>();
  const byName = new Map<string, CompiledBody[]>();
  const add = (into: Map<string, CompiledBody[]>, key: string, body: CompiledBody) => {
    into.set(key, [...(into.get(key) ?? []), body]);
  };
  for (const body of bodies) {
    const segments = segmentsOf(body.path);
    const at = segments.findIndex((segment) => segment.startsWith("<impl at "));
    if (at >= 0) {
      /*
       * `<impl at FILE:LINE:COL: LINE:COL>::method`. Anything longer after the
       * impl is a function declared inside a method's body, which a board's
       * routine is never matched to -- see `compiledBodiesOf`.
       */
      if (segments.length !== at + 2) continue;
      const span = segments[at]!.match(/^<impl at (.+):(\d+):\d+: \d+:\d+>$/);
      const file = span ? toRepo(span[1]!) : undefined;
      if (file) add(byImpl, `${file}:${span![2]}`, body);
      continue;
    }
    add(byName, segments[segments.length - 1]!, body);
  }
  const root = toRepo(places.root) ?? places.root;
  return { files, root, byImpl, byName };
}

/**
 * The bodies in a dump, closures folded into the function that wrote them.
 *
 * A closure, an `async` block and an `async fn`'s own body are each printed as
 * a body of their own -- `later::{closure#0}` -- and each is part of what the
 * function they are written in calls. Left apart, `async fn later()` would be
 * a routine whose only call is building a future.
 *
 * `// MIR FOR CTFE` introduces the second copy of a `const fn`, the one
 * compile-time evaluation uses. It is the same function, and counting it
 * twice would make every `const fn` look ambiguous.
 */
function bodiesIn(mir: string): CompiledBody[] {
  const all: CompiledBody[] = [];
  let open: CompiledBody | undefined;
  let locals = new Map<string, string>();
  let skipping = false;
  let ctfe = false;
  for (const line of mir.split("\n")) {
    if (open || skipping) {
      if (line === "}") { open = undefined; skipping = false; continue; }
      if (!open) continue;
      readBodyLine(line, open, locals);
      continue;
    }
    if (line.startsWith("// MIR FOR CTFE")) { ctfe = true; continue; }
    if (line.startsWith(" ") || line.startsWith("//") || !line.endsWith("{")) continue;
    const header = line.match(/^(?:const )?fn (.*)$/);
    if (!header || ctfe) { skipping = true; ctfe = false; continue; }
    const split = splitHeader(header[1]!);
    if (!split) { skipping = true; continue; }
    open = {
      path: split.path,
      params: (split.params.match(/(?:^|, )_\d+: /g) ?? []).length,
      calls: [],
      drops: 0,
      words: new Set(),
      made: new Set(),
    };
    locals = new Map();
    all.push(open);
  }

  /*
   * Fold, innermost first, so a closure inside a closure lands on its
   * function and not on the closure that was already folded away.
   */
  const byPath = new Map<string, CompiledBody[]>();
  for (const body of all) byPath.set(body.path, [...(byPath.get(body.path) ?? []), body]);
  const kept: CompiledBody[] = [];
  for (const body of all) {
    const segments = segmentsOf(body.path);
    const nested = segments.findIndex((segment) => /^\{[\w -]+#\d+\}$/.test(segment));
    if (nested < 0) { kept.push(body); continue; }
    const owners = byPath.get(segments.slice(0, nested).join("::")) ?? [];
    for (const owner of owners) {
      owner.calls.push(...body.calls);
      owner.drops += body.drops;
      for (const word of body.words) owner.words.add(word);
      for (const type of body.made) owner.made.add(type);
    }
  }
  return kept;
}

/** `path(params) -> ret {` split at the parameter list's own parenthesis. */
function splitHeader(rest: string): { path: string; params: string } | undefined {
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index];
    if (char === "<" || char === "{" || char === "[") depth += 1;
    else if (char === ">" || char === "}" || char === "]") depth -= 1;
    else if (char === "(" && depth === 0) {
      const close = matching(rest, index);
      if (close < 0) return undefined;
      return { path: rest.slice(0, index), params: rest.slice(index + 1, close) };
    }
  }
  return undefined;
}

/** The index of the bracket closing the one at `open`, or -1. */
function matching(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "<": ">", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "-" && text[index + 1] === ">") { index += 1; continue; }
    if (pairs[char]) stack.push(pairs[char]!);
    else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

/** A path's `::` segments, not splitting inside `<..>` or `{..}`. */
function segmentsOf(written: string): string[] {
  const segments: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < written.length; index += 1) {
    const char = written[index];
    if (char === "-" && written[index + 1] === ">") { index += 1; continue; }
    if (char === "<" || char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === ">" || char === "}" || char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && char === ":" && written[index + 1] === ":") {
      segments.push(written.slice(start, index));
      start = index + 2;
      index += 1;
    }
  }
  segments.push(written.slice(start));
  return segments.filter((segment) => segment !== "");
}

/** A terminator that transfers control: `... -> [return: bb1, unwind continue];`. */
const TERMINATOR = /^\s+(.*) -> (?:\[[^\]]*\]|unwind [^;]*|bb\d+);$/;
/** Terminators that are not calls. `drop` is counted apart; the rest move control and run nothing. */
const NOT_A_CALL = /^(?:goto|switchInt|assert|falseEdge|falseUnwind|yield|drop)\b/;

/** `let mut _3: std::vec::Vec<Widget>;` -- a local and its type, which MIR declares before any statement. */
const LOCAL = /^\s+let (?:mut )?(_\d+): (.+);$/;
/** `_3 = Widget { .. }`, `(_1.0: T) = Tagged(..)` -- an assignment whose value is an aggregate, not a call. */
const AGGREGATE = /^\s+\S.*? = (?:const )?((?:[A-Za-z_]\w*(?:::<.*?>)?::)*[A-Za-z_]\w*)(?:::<.*?>)?\s*[{(;]/;

/** The last path segment of a type, looking through references and pointers: `&mut a::Widget<T>` -> `Widget`. */
export function baseTypeOf(written: string): string {
  const bare = written.replace(/^(?:&(?:'\w+ )?(?:mut )?|\*(?:const|mut) )+/, "").trim();
  return segmentsOf(stripGenerics(bare)).pop()?.trim() ?? bare;
}

function readBodyLine(line: string, body: CompiledBody, locals: Map<string, string>): void {
  for (const word of line.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []) body.words.add(word);
  const local = line.match(LOCAL);
  if (local) { locals.set(local[1]!, local[2]!); return; }
  const terminator = line.match(TERMINATOR);
  if (!terminator) {
    // Not a call, so a `Name {`, `Name(` or `Name;` on the right is a value built in place.
    const aggregate = line.match(AGGREGATE);
    if (aggregate && !/^(?:move|copy|const)$/.test(aggregate[1]!)) {
      for (const segment of segmentsOf(stripGenerics(aggregate[1]!)).slice(-2)) body.made.add(segment);
    }
    return;
  }
  // Whatever a call writes into is a value it handed back.
  const destination = terminator[1]!.match(/^(_\d+) = /);
  const type = destination ? locals.get(destination[1]!) : undefined;
  if (type) body.made.add(baseTypeOf(type));
  const written = terminator[1]!.replace(/^_\d+ = /, "");
  if (/^drop\(/.test(written)) { body.drops += 1; return; }
  if (NOT_A_CALL.test(written)) return;
  const call = callOf(written);
  if (call) body.calls.push(call);
}

/** What a call terminator calls, or `undefined` for a closure the body wrote itself. */
function callOf(written: string): CompiledCall | undefined {
  if (written.startsWith("asm!")) return { kind: "opaque", wrote: written };
  const callee = calleeOf(written);
  if (callee === undefined || /^(?:move |copy )?_\d+$/.test(callee) || callee.startsWith("(")) {
    return { kind: "opaque", wrote: written };
  }
  if (callee.startsWith("<")) {
    const close = matching(callee, 0);
    if (close < 0) return { kind: "opaque", wrote: written };
    const inner = callee.slice(1, close);
    const as = lastTopLevel(inner, " as ");
    const method = segmentsOf(callee.slice(close + 1))[0]?.replace(/<.*$/, "");
    if (as < 0 || !method) return { kind: "opaque", wrote: written };
    const self = inner.slice(0, as);
    const trait = stripGenerics(inner.slice(as + 4));
    const traitName = segmentsOf(trait).pop() ?? "";
    if (/^(?:Async)?Fn(?:Mut|Once)?$/.test(traitName)) {
      /*
       * Calling something through the `Fn` traits. A closure this body wrote
       * is folded in already, so calling it adds nothing. A function item --
       * `fn(u8) -> u8 {double}` -- names the function it is. Anything else is
       * a value somebody handed in, and it can be anything at all.
       */
      if (/^\{(?:closure|coroutine)@/.test(self) || self.startsWith("{async")) return undefined;
      const item = self.match(/\{([^{}]+)\}$/);
      if (self.startsWith("fn(") && item) {
        const name = segmentsOf(stripGenerics(item[1]!)).pop();
        if (name) return { kind: "named", name };
      }
      return { kind: "opaque", wrote: written };
    }
    return { kind: "named", name: method, through: self };
  }
  const name = segmentsOf(stripGenerics(callee)).pop();
  if (!name || !/^[A-Za-z_]\w*$/.test(name)) return { kind: "opaque", wrote: written };
  return { kind: "named", name };
}

/** The callee in `callee(args)`, split at the argument list. */
function calleeOf(written: string): string | undefined {
  let depth = 0;
  for (let index = 0; index < written.length; index += 1) {
    const char = written[index];
    if (char === "-" && written[index + 1] === ">") { index += 1; continue; }
    if (char === "<" || char === "{" || char === "[") depth += 1;
    else if (char === ">" || char === "}" || char === "]") depth -= 1;
    else if (char === "(" && depth === 0) return index === 0 ? "(" : written.slice(0, index);
  }
  return undefined;
}

function lastTopLevel(text: string, needle: string): number {
  let depth = 0;
  let found = -1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "-" && text[index + 1] === ">") { index += 1; continue; }
    if (char === "<" || char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === ">" || char === "}" || char === ")" || char === "]") depth -= 1;
    else if (depth === 0 && text.startsWith(needle, index)) found = index;
  }
  return found;
}

/** `a::<T>::b` -> `a::::b`. A function type's `->` is not a bracket, and would close one. */
function stripGenerics(written: string): string {
  let out = written.replace(/->/g, "\u2192");
  let before: string;
  do { before = out; out = out.replace(/<[^<>]*>/g, ""); } while (out !== before);
  return out;
}

/* ------------------------------------------- a board's routine, in the dump */

/**
 * The bodies a routine in a file is, or why there is no saying.
 *
 * `not-compiled`  rustc never read the file: a binary target, an example, a
 *                 module a feature left out. Never "calls nothing".
 * `not-matched`   no single body is the declaration, or one is and its
 *                 parameter count disagrees. A function declared inside
 *                 another is always this -- rustc prints it as if it stood on
 *                 its own.
 * `switched-off`  `cfg` on the routine, on what holds it, or inside it. What
 *                 rustc read is one setting's body, and a call in another
 *                 setting's is not in it.
 */
export type CompiledReading =
  /**
   * `generics` is every type parameter in scope at the declarations, `Self`
   * in a trait's: the names a call through a trait can be made on without
   * saying which type it is.
   */
  | { bodies: CompiledBody[]; generics: Set<string> }
  | { why: "not-compiled" | "not-matched" | "switched-off" };

/**
 * Every declaration named `routine` in the file, each matched to its one
 * body -- the same "all of them" rule `closedBodyRefutes` applies to an
 * overload set, so a name two `impl` blocks both declare is answered for
 * both or not at all.
 *
 * How a declaration is found, by what rustc prints for it:
 *
 *   a method in an `impl`    the impl's own span: `<impl at src/a.rs:12:1: ..>`,
 *                            which starts on the `impl` keyword's line
 *   a trait's default body   `Trait::method`
 *   anything else            its module path, `parser::parse` -- or the bare
 *                            name, which rustc prints only for a name that is
 *                            unique in the crate
 */
export function compiledBodiesOf(
  crate: CompiledCrate,
  file: string,
  source: string,
  routine: string,
): CompiledReading {
  if (!crate.files.has(file)) return { why: "not-compiled" };
  const tree = parseSource(source, "rust");
  if (!tree) return { why: "not-matched" };

  const declarations = declarationsNamed(tree.rootNode, routine);
  if (declarations.length === 0) return { why: "not-matched" };

  const bodies: CompiledBody[] = [];
  const generics = new Set<string>();
  for (const declaration of declarations) {
    if (declaration.switchedOff) return { why: "switched-off" };
    const body = bodyOf(crate, file, source, declaration, routine);
    if (!body || body.params !== parameterCount(declaration.node)) return { why: "not-matched" };
    bodies.push(body);
    for (const holder of [...declaration.ancestors, declaration.node]) {
      if (holder.type === "trait_item") generics.add("Self");
      const parameters = holder.childForFieldName("type_parameters")?.text ?? "";
      for (const match of parameters.matchAll(/(?:^<|,)\s*(?:const\s+)?([A-Za-z_]\w*)/g)) generics.add(match[1]!);
    }
  }
  return { bodies, generics };
}

/** A function declaration, what holds it (outermost first), and whether `cfg` reaches it. */
interface Declaration {
  node: Node;
  ancestors: Node[];
  switchedOff: boolean;
}

const CFG = /\bcfg(?:_attr)?\b/;

/**
 * Every function with a body named `routine`, walked down from the root so
 * each one arrives knowing what holds it -- the engine's `Node` has no
 * parent.
 *
 * `switchedOff` is `cfg` anywhere that decides which of the routine's code
 * rustc compiled: an attribute on it or on anything holding it, an inner
 * attribute of a module holding it, or `cfg` inside its own text -- `#[cfg]`
 * on a statement, `cfg!()`, `cfg_attr`.
 */
function declarationsNamed(root: Node, routine: string): Declaration[] {
  const found: Declaration[] = [];
  const visit = (node: Node, ancestors: Node[], off: boolean) => {
    const children: Node[] = [];
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child?.isNamed) children.push(child);
    }
    const inner = off || children.some((child) => child.type === "inner_attribute_item" && CFG.test(child.text));
    const holding = [...ancestors, node];
    let attributed = false;
    for (const child of children) {
      if (child.type === "attribute_item") { attributed ||= CFG.test(child.text); continue; }
      if (child.type === "line_comment" || child.type === "block_comment") continue;
      const childOff = inner || attributed;
      attributed = false;
      if (child.type === "function_item" && child.childForFieldName("name")?.text === routine
        && child.childForFieldName("body")) {
        found.push({ node: child, ancestors: holding, switchedOff: childOff || CFG.test(child.text) });
      }
      visit(child, holding, childOff);
    }
  };
  visit(root, [], false);
  return found;
}

function bodyOf(
  crate: CompiledCrate,
  file: string,
  source: string,
  declaration: Declaration,
  routine: string,
): CompiledBody | undefined {
  const modules: string[] = [];
  let holder: Node | undefined;
  for (const up of [...declaration.ancestors].reverse()) {
    /*
     * A function declared inside another's body. rustc prints it as though
     * it stood on its own -- `inner`, not `outer::inner` -- so its path says
     * nothing about where it is.
     */
    if (up.type === "function_item" || up.type === "block" || up.type === "closure_expression") return undefined;
    if ((up.type === "impl_item" || up.type === "trait_item") && !holder) { holder = up; continue; }
    if (up.type === "mod_item") {
      const name = up.childForFieldName("name")?.text;
      if (!name) return undefined;
      modules.unshift(name);
    }
  }
  const only = (found: CompiledBody[]): CompiledBody | undefined => (found.length === 1 ? found[0] : undefined);

  if (holder?.type === "impl_item") {
    const line = source.slice(0, holder.startIndex).split("\n").length;
    return only((crate.byImpl.get(`${file}:${line}`) ?? []).filter((body) => segmentsOf(body.path).pop() === routine));
  }
  const named = crate.byName.get(routine) ?? [];
  if (holder?.type === "trait_item") {
    const trait = holder.childForFieldName("name")?.text;
    return only(named.filter((body) => {
      const segments = segmentsOf(body.path);
      return segments.length >= 2 && segments[segments.length - 2] === trait;
    }));
  }
  const within = modulePathOf(file, crate.root);
  if (!within) return undefined;
  const expected = [...within, ...modules, routine].join("::");
  const exact = named.filter((body) => segmentsOf(body.path).join("::") === expected);
  if (exact.length > 0) return only(exact);
  // The bare name: rustc trimmed the path because nothing else in the crate shares it.
  return named.length === 1 && segmentsOf(named[0]!.path).length === 1 ? named[0] : undefined;
}

/** `src/parser/mod.rs` under `src/lib.rs` -> `["parser"]`; `undefined` for a file outside the crate's tree. */
function modulePathOf(file: string, root: string): string[] | undefined {
  const relative = path.posix.relative(path.posix.dirname(root), file);
  if (relative.startsWith("..")) return undefined;
  if (relative === path.posix.basename(root)) return [];
  const segments = relative.replace(/\.rs$/, "").split("/");
  if (segments[segments.length - 1] === "mod") segments.pop();
  return segments.every((segment) => /^[A-Za-z_]\w*$/.test(segment)) ? segments : undefined;
}

function parameterCount(declaration: Node): number {
  const parameters = declaration.childForFieldName("parameters");
  let count = 0;
  for (let index = 0; index < (parameters?.childCount ?? 0); index += 1) {
    const child = parameters!.child(index);
    if (child?.isNamed && !["attribute_item", "line_comment", "block_comment"].includes(child.type)) count += 1;
  }
  return count;
}

/* ------------------------------------------------ could it reach the head? */

/**
 * Why a compiled body cannot say the head is never called.
 *
 * `computed`           one call's target is a value
 * `same-name`          the body calls, or names, something called what the
 *                      head is called -- whose it is, rustc's list does not say
 *                      by name, and a trait call names no implementation at all
 * `abstract-receiver`  a call goes through a trait on a type parameter,
 *                      `Self`, `dyn` or `impl Trait` -- it runs whichever
 *                      implementation the value's type has, and that may be
 *                      the head, or call it
 * `called-implicitly`  the head is a method of a trait the repository does
 *                      not declare, on a type the body handles, and the
 *                      language or a library calls those without the name
 *                      being written: an operator, `?`, formatting, a drop
 */
export type CompiledWithheld = "computed" | "same-name" | "called-implicitly" | "abstract-receiver";

export function compiledRefutes(
  bodies: readonly CompiledBody[],
  head: {
    names: readonly string[];
    source: string;
    /** Whether a trait the head implements is declared in this repository. Its methods run only when called by name. */
    ownTrait?: (written: string) => boolean;
  },
  /** Type parameters in scope at the tail: `CompiledReading.generics`. */
  generics: ReadonlySet<string> = new Set(),
): { sites: number } | { why: CompiledWithheld } {
  const names = new Set(head.names);
  for (const body of bodies) {
    if (body.calls.some((call) => call.kind === "opaque")) return { why: "computed" };
  }
  /*
   * A call through a trait on a value whose type the body does not fix runs
   * whichever implementation that type has -- and that implementation may be
   * where the head is called. The text reading's rule for an interface
   * (docs/claim-vocabulary.md item 14), applied to the compiler's list: the
   * chain check that would turn such an arrow into "one level up" cannot
   * follow a call to an implementation nobody named.
   */
  const dispatched = (through: string): boolean => {
    const bare = through.replace(/^&(?:mut )?/, "").replace(/^'\w+ /, "");
    return /^(?:dyn|impl) /.test(bare) || bare.startsWith("<") || generics.has(bare.match(/^[A-Za-z_]\w*/)?.[0] ?? "");
  };
  for (const body of bodies) {
    if (body.calls.some((call) => call.kind === "named" && call.through !== undefined && dispatched(call.through))) {
      return { why: "abstract-receiver" };
    }
  }
  for (const body of bodies) {
    if (body.calls.some((call) => call.kind === "named" && names.has(call.name))) return { why: "same-name" };
    if ([...names].some((name) => body.words.has(name))) return { why: "same-name" };
  }
  const unwritten = traitImplsOf(head.source, names).filter((one) => !head.ownTrait?.(one.trait));
  for (const body of bodies) {
    for (const one of unwritten) {
      // A generic tail hands values of any type to library code that runs their traits' methods.
      if (one.blanket || generics.size > 0) return { why: "called-implicitly" };
      if (one.method === "drop" && body.drops > 0) return { why: "called-implicitly" };
      if (one.types.some((type) => body.words.has(type))) return { why: "called-implicitly" };
    }
  }
  return { sites: bodies.reduce((sum, body) => sum + body.calls.length, 0) };
}

/** One of the head's routines that is a method of a trait implementation. */
export interface TraitImpl {
  method: string;
  /** The trait as written, generics stripped: `Add`, `fmt::Display`, `crate::t::Handler`. */
  trait: string;
  /** Every type named in the implementing type: `Wrapper<Item>` -> `Wrapper`, `Item`. */
  types: string[];
  /** `impl<T> Trait for T`: the implementing type is anything at all. */
  blanket: boolean;
}

/**
 * Which of the head's routines are trait methods, and on what type.
 *
 * `impl Add for V` puts `add` where `a + b` reaches it, `impl From<E> for
 * Error` where `?` does, `impl Display for Report` where `format!` does, and
 * `impl Drop for Guard` where the end of a scope does. None of them writes the
 * method's name in the caller, and the compiler's call goes to `add`,
 * `from_residual`, `new_display` and a `drop` terminator respectively -- and
 * a library's generic code (`sort`, `HashMap::insert`, `serde_json::to_string`)
 * runs a trait's method on the caller's behalf the same way.
 */
export function traitImplsOf(source: string, names: ReadonlySet<string>): TraitImpl[] {
  const found: TraitImpl[] = [];
  const tree = parseSource(source, "rust");
  if (!tree) return found;
  const visit = (node: Node) => {
    const trait = node.type === "impl_item" ? node.childForFieldName("trait") : null;
    if (trait) {
      const methods = node.childForFieldName("body");
      for (let index = 0; index < (methods?.childCount ?? 0); index += 1) {
        const method = methods!.child(index);
        const name = method?.type === "function_item" ? method.childForFieldName("name")?.text : undefined;
        if (!name || !names.has(name)) continue;
        const generics = new Set(node.childForFieldName("type_parameters")?.text.match(/(?<!')\b[A-Za-z_]\w*/g) ?? []);
        const written = (node.childForFieldName("type")?.text ?? "").replace(/'\w+/g, "");
        const words = (written.match(/[A-Za-z_]\w*/g) ?? []).filter((word) => !["dyn", "mut", "const"].includes(word));
        found.push({
          method: name,
          trait: stripGenerics(trait.text),
          types: words.filter((word) => !generics.has(word)),
          blanket: words.length === 0 || generics.has(words[0]!),
        });
      }
    }
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index);
      if (child?.isNamed) visit(child);
    }
  };
  visit(tree.rootNode);
  return found;
}
