/**
 * The Rust half of `measure:compiler-true` (#393, part 3): every pair rustc
 * says is true, read off its MIR by this file's own line patterns.
 *
 *   takes     the type of each argument local, `_1: &Config`
 *   returns   the return local, `-> Result<Config, Error>`
 *   holds     the type of each field a body reads (`((*_1).0: Span)`) or a
 *             struct literal fills (`Position { offset: move _5 }`)
 *   accesses  each field a body reads, by its place in the struct's field list
 *   calls     the function each call lands on: `Span::new(..)`,
 *             `<Lexer as Iterator>::next(..)`, `parse::expr(..)`
 *
 * rustc is not what the product asks about types -- that is rust-analyzer --
 * and the readers judged read tree-sitter nodes. The crates are built (or read
 * from the cache) the way the product builds them, and a routine is matched to
 * its compiled body by `compiledBodiesOf`, which is only the matching.
 *
 * What it cannot see: a type parameter's bound (MIR writes `N`, not what `N`
 * must be); a field no body reads and no literal fills; a struct, enum or
 * function declared under one name twice; anything behind a `cfg` rustc did
 * not build; and conforms, which Rust boards draw as `impl Trait for X` and
 * this licence does not cover.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { Node } from "../../src/engine/parse";
import type { TruePair } from "./compiler-true-ts";

interface Header { args: string[]; ret: string; lines: string[] }

export async function rustTruePairs(root: string): Promise<TruePair[]> {
  const { compileCrates, rustcCacheDir } = await import("../../src/engine/referee-rustc");
  const { compiledBodiesOf } = await import("../../src/engine/compiled-calls");
  const { initEngine, parseSource } = await import("../../src/engine/parse");
  await initEngine();

  const skip = new Set(["target", ".git", "node_modules", "tests", "benches", "examples", "fuzz"]);
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const name of readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (name.endsWith(".rs")) out.push(full);
    }
    return out;
  };
  const absolute = walk(root);
  const files = absolute.map((one) => path.relative(root, one));
  const crates = await compileCrates(root, files, { until: Date.now() + 900_000 });

  // Raw MIR by printed path, one map per Cargo.toml: two crates in one
  // workspace may each print a function as `subcommands`.
  const mirOf = new Map<string, Map<string, Header>>();
  const manifests = new Set<string>();
  for (const file of absolute) {
    for (let dir = path.dirname(file); dir.startsWith(root); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, "Cargo.toml"))) { manifests.add(path.join(dir, "Cargo.toml")); break; }
    }
  }
  for (const manifest of manifests) {
    const key = createHash("sha1").update(manifest).digest("hex").slice(0, 16);
    const dump = path.join(rustcCacheDir(), key, "calls.mir");
    const mir = new Map<string, Header>();
    if (existsSync(dump)) readMir(readFileSync(dump, "utf8"), mir);
    mirOf.set(manifest, mir);
  }

  // What the files declare: types once, their named fields in order, and
  // every routine with the ref a board gives it.
  const typeHomes = new Map<string, string[]>();
  /** Named fields in order, with each one's written type; none for a struct with a `cfg` inside, whose numbering rustc shifts. */
  const fields = new Map<string, string[]>();
  const fieldTypes = new Map<string, Map<string, string>>();
  const typeText = new Map<string, string>();
  interface Routine { ref: string; file: string; name: string; owner?: string; implLine?: number; text: string; params: string }
  const routines: Routine[] = [];
  const sources = new Map<string, string>();
  for (const file of files) {
    const source = readFileSync(path.join(root, file), "utf8");
    sources.set(file, source);
    const tree = parseSource(source, "rust");
    if (!tree) continue;
    const children = (node: Node) => {
      const out: Node[] = [];
      for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);
        if (child) out.push(child);
      }
      return out;
    };
    const lineOf = (node: Node) => source.slice(0, node.startIndex).split("\n").length;
    // Ancestors kept by hand: the engine's node has no parent.
    const visit = (node: Node, parent: Node | undefined, holder: Node | undefined): void => {
      if (/^(struct|enum|trait)_item$/.test(node.type)) {
        const name = node.childForFieldName("name")?.text;
        if (name) {
          typeHomes.set(name, [...(typeHomes.get(name) ?? []), file]);
          typeText.set(name, node.text);
          const body = node.childForFieldName("body");
          if (node.type === "struct_item" && body?.type === "field_declaration_list" && !body.text.includes("#[cfg")) {
            const declared = children(body).filter((one) => one.type === "field_declaration");
            fields.set(name, declared.map((one) => one.childForFieldName("name")?.text ?? ""));
            fieldTypes.set(name, new Map(declared.map((one) => [one.childForFieldName("name")?.text ?? "", one.childForFieldName("type")?.text ?? ""])));
          }
        }
      }
      if (node.type === "function_item") {
        const name = node.childForFieldName("name")?.text;
        const inImpl = parent?.type === "declaration_list" && holder?.type === "impl_item";
        const atTop = parent?.type === "source_file" || (parent?.type === "declaration_list" && holder?.type === "mod_item");
        if (name && (inImpl || atTop)) {
          const owner = inImpl ? holder!.childForFieldName("type")?.text.split("<")[0]!.split("::").pop() : undefined;
          routines.push({
            // The plain name, as the checker asks a Rust ref to be written:
            // `file#Type.method` does not resolve, and #382 still judges it.
            ref: `${file}#${name}`, file, name,
            ...(owner ? { owner, implLine: lineOf(holder!) } : {}),
            text: node.text, params: node.childForFieldName("parameters")?.text ?? "",
          });
        }
        return;
      }
      for (const child of children(node)) visit(child, node, parent);
    };
    visit(tree.rootNode, undefined, undefined);
  }
  const home = (name: string) => {
    const at = typeHomes.get(name);
    return at && at.length === 1 ? at[0] : undefined;
  };
  const refCount = new Map<string, number>();
  for (const routine of routines) refCount.set(routine.ref, (refCount.get(routine.ref) ?? 0) + 1);
  const unique = routines.filter((routine) => refCount.get(routine.ref) === 1);
  // A call's target, by `Type::method` and by a free function's name.
  const byMethod = new Map<string, Routine[]>();
  const byFree = new Map<string, Routine[]>();
  for (const routine of unique) {
    const key = routine.owner ? `${routine.owner}::${routine.name}` : routine.name;
    const map = routine.owner ? byMethod : byFree;
    map.set(key, [...(map.get(key) ?? []), routine]);
  }
  const one = <T,>(list: T[] | undefined) => (list && list.length === 1 ? list[0] : undefined);

  /** Every project type a printed type names, by last segment. `Self` is the owner. */
  const partsOf = (type: string, owner?: string): Array<{ name: string; self: boolean }> => {
    const out = new Map<string, boolean>();
    for (const match of type.matchAll(/((?:\w+::)*)([A-Z]\w*)/g)) {
      // The standard library's own types are not this repository's, whatever they are called.
      if (/^(std|core|alloc)::/.test(match[1]!)) continue;
      const self = match[2] === "Self";
      const name = self ? owner : match[2];
      if (name && home(name) && !out.has(name)) out.set(name, self);
    }
    return [...out].map(([name, self]) => ({ name, self }));
  };
  /**
   * `written` where the text names it; `alias` where it writes `Self` and
   * means the impl's own type, which rustc prints by its name.
   */
  const howOf = (written: string, name: string, self: boolean, owner?: string) =>
    !self && new RegExp(`\\b${name}\\b`).test(written) ? "written"
      : self || (name === owner && /\bSelf\b/.test(written)) ? "alias" : "inferred";

  /**
   * A field's value type, as rustc has it, against the type the field writes.
   * Rust writes every field's type, so a part the declaration does not name is
   * the reading gone wrong -- except `Self`, the one name that stands for
   * another there.
   */
  const heldBy = (struct: string, member: string, type: string) => {
    const written = fieldTypes.get(struct)?.get(member);
    if (written === undefined) return;
    for (const { name } of partsOf(type)) {
      if (name === struct) continue;
      const how = new RegExp(`\\b${name}\\b`).test(written) ? "written" : /\bSelf\b/.test(written) ? "alias" : undefined;
      if (how) add({ word: "holds", from: `${home(struct)}#${struct}`, to: `${home(name)}#${name}`, how });
    }
  };

  const manifestOf = (file: string): string | undefined => {
    for (let dir = path.dirname(path.join(root, file)); dir.startsWith(root); dir = path.dirname(dir)) {
      if (existsSync(path.join(dir, "Cargo.toml"))) return path.join(dir, "Cargo.toml");
    }
    return undefined;
  };

  const pairs: TruePair[] = [];
  const seen = new Set<string>();
  const add = (pair: TruePair) => {
    const key = `${pair.word} ${pair.from} ${pair.to} ${pair.label ?? ""}`;
    if (!seen.has(key)) { seen.add(key); pairs.push(pair); }
  };

  for (const routine of unique) {
    const crate = crates.crateOf(routine.file);
    if (!crate) continue;
    const reading = compiledBodiesOf(crate, routine.file, sources.get(routine.file)!, routine.name);
    if ("why" in reading) continue;
    // The one body that is this routine's: by its impl's line, or the only one.
    const bodies = reading.bodies.filter((body) => routine.implLine
      ? body.path.includes(`${routine.file}:${routine.implLine}:`) || body.path.includes(`/${path.basename(routine.file)}:${routine.implLine}:`)
      : !body.path.includes("<impl at "));
    const body = one(bodies);
    if (!body) continue;
    const manifest = manifestOf(routine.file);
    const header = manifest ? mirOf.get(manifest)?.get(body.path) : undefined;
    if (!header) continue;

    // takes and returns, off the header. A method's receiver is not a parameter.
    const hasSelf = /^\(\s*(&\s*('\w+\s+)?(mut\s+)?)?(mut\s+)?self\b/.test(routine.params);
    header.args.forEach((arg, index) => {
      if (hasSelf && index === 0) return;
      for (const { name, self } of partsOf(arg, routine.owner)) {
        const how = howOf(routine.params, name, self, routine.owner);
        // Rust writes every parameter's type: a part the text does not name is
        // what rustc built behind an `impl Trait` or another crate's alias.
        if (how !== "inferred") add({ word: "takes", from: `${home(name)}#${name}`, to: routine.ref, how });
      }
    });
    const signature = routine.text.slice(0, routine.text.indexOf("{") >= 0 ? routine.text.indexOf("{") : undefined);
    const written = signature.includes("->") ? signature.slice(signature.indexOf("->")) : "";
    for (const { name, self } of partsOf(header.ret, routine.owner)) {
      const how = howOf(written, name, self, routine.owner);
      if (how !== "inferred") add({ word: "returns", from: `${home(name)}#${name}`, to: routine.ref, how });
    }

    // Locals' types, for the base of each field read and each literal's values.
    const locals = new Map<string, string>();
    header.args.forEach((arg, index) => locals.set(String(index + 1), arg));
    for (const line of header.lines) {
      const local = line.match(/^\s+let (?:mut )?_(\d+): (.+);$/);
      if (local) locals.set(local[1]!, local[2]!);
    }
    const baseOf = (type: string | undefined) =>
      type?.replace(/^(&(mut )?|\*(const|mut) )+/, "").replace(/'\w+ /g, "").split("<")[0]!.split("::").pop()!.trim();

    for (const line of header.lines) {
      // Field reads: `(_3.1: T)` and `((*_3).1: T)`. Not in a `drop`: rustc
      // cleaning up the fields a body moved out of nothing reads them.
      for (const read of /^\s+drop\(/.test(line) ? [] : fieldReads(line)) {
        const struct = baseOf(locals.get(read.local));
        if (!struct || !home(struct)) continue;
        const member = fields.get(struct)?.[read.index];
        if (!member) continue;
        heldBy(struct, member, read.type);
        // A read rustc copied in from a method it inlined is the method's, not this routine's.
        if (!new RegExp(`\\.\\s*${member}\\b`).test(routine.text)) continue;
        add({ word: "accesses", from: routine.ref, to: `${home(struct)}#${struct}`, label: member, how: "written" });
      }
      // Struct literals: `_4 = Position { offset: move _5, .. }`.
      const literal = line.match(/^\s+_\d+ = (?:\w+::)*([A-Z]\w*)(?:::<.*?>)? \{ (.*) \};$/);
      if (literal && home(literal[1]!) && fields.has(literal[1]!)) {
        const struct = literal[1]!;
        for (const value of literal[2]!.matchAll(/(\w+): (?:move|copy) _(\d+)/g)) {
          heldBy(struct, value[1]!, locals.get(value[2]!) ?? "");
        }
      }
      // Calls: the function each lands on.
      const call = line.match(/^\s+(?:_\d+|\(\*_\d+\)|\(_\d+\.\d+: .*?\)) = (.+?)\(.*\) -> \[/);
      if (call) {
        const callee = stripGenerics(call[1]!);
        const qualified = callee.match(/^<(?:\w+::)*(\w+) as (?:\w+::)*\w+>::(\w+)$/) ?? callee.match(/^(?:\w+::)*([A-Z]\w*)::(\w+)$/);
        const target = qualified
          ? one(byMethod.get(`${qualified[1]}::${qualified[2]}`))
          : callee.includes("<impl at ")
            ? unique.find((other) => other.owner && callee.endsWith(`::${other.name}`)
              && callee.includes(`${other.file}:${other.implLine}:`))
            // A free function only within the routine's own crate: another
            // crate's `next` is not this workspace's `next`.
            : callee.startsWith("<") ? undefined
            : one((byFree.get(callee.split("::").pop()!) ?? []).filter((other) => manifestOf(other.file) === manifest));
        if (target && target.ref !== routine.ref) {
          const spelled = routine.text.includes(`${target.name}(`) || routine.text.includes(`${target.name}::<`);
          add({ word: "calls", from: routine.ref, to: target.ref, how: spelled ? "written" : "other-name" });
        }
      }
    }
  }
  return pairs;
}

/** `Foo::<'_, P>::bar`, `Vec::<Ast>::new` -> `Foo::bar`, `Vec::new`; `<A<T> as B<U>>::m` -> `<A as B>::m`. */
function stripGenerics(text: string): string {
  let out = "";
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "<" && (text.slice(index - 2, index) === "::" || (depth === 0 && index > 0 && /\w/.test(text[index - 1]!)))) {
      depth += 1;
      if (out.endsWith("::")) out = out.slice(0, -2);
      continue;
    }
    if (depth > 0) {
      if (char === "<") depth += 1;
      else if (char === ">") depth -= 1;
      continue;
    }
    out += char;
  }
  return out;
}

/** Each `(_3.1: T)` / `((*_3).1: T)` on a line, with T read to its closing parenthesis. */
function fieldReads(line: string): Array<{ local: string; index: number; type: string }> {
  const out: Array<{ local: string; index: number; type: string }> = [];
  for (const match of line.matchAll(/\((?:\(\*_(\d+)\)|_(\d+))\.(\d+): /g)) {
    let depth = 0;
    let end = match.index! + match[0].length;
    for (; end < line.length; end += 1) {
      const char = line[end]!;
      if ("(<[".includes(char)) depth += 1;
      else if (")>]".includes(char)) {
        if (depth === 0) break;
        depth -= 1;
      }
    }
    out.push({ local: (match[1] ?? match[2])!, index: Number(match[3]), type: line.slice(match.index! + match[0].length, end) });
  }
  return out;
}

/** Every function's header and body lines, by printed path. A closure's calls join its function's; its locals are numbered apart, so nothing else does. */
function readMir(text: string, out: Map<string, Header>): void {
  let open: { lines: string[]; host?: Header } | undefined;
  let skipping = false;
  let ctfe = false;
  const isCall = (line: string) => / -> \[/.test(line);
  for (const line of text.split("\n")) {
    if (open || skipping) {
      if (line === "}") {
        if (open?.host) open.host.lines.push(...open.lines.filter(isCall));
        open = undefined;
        skipping = false;
      } else open?.lines.push(line);
      continue;
    }
    if (line.startsWith("// MIR FOR CTFE")) { ctfe = true; continue; }
    if (line.startsWith(" ") || line.startsWith("//") || !line.endsWith("{")) continue;
    const header = line.match(/^(?:const )?fn (.*) \{$/);
    if (!header || ctfe) { skipping = true; ctfe = false; continue; }
    const rest = header[1]!;
    let depth = 0;
    let cut = -1;
    for (let index = 0; index < rest.length; index += 1) {
      const char = rest[index]!;
      if ("<{[".includes(char)) depth += 1;
      else if (">}]".includes(char)) depth -= 1;
      else if (char === "(" && depth === 0) { cut = index; break; }
    }
    if (cut < 0) { skipping = true; continue; }
    let printed = rest.slice(0, cut);
    const nested = printed.search(/::\{[\w -]+#\d+\}/);
    if (nested >= 0) printed = printed.slice(0, nested);
    const host = out.get(printed) ?? { args: [], ret: "", lines: [] };
    out.set(printed, host);
    if (nested >= 0) { open = { lines: [], host }; continue; }
    const signature = rest.slice(cut);
    const arrow = signature.lastIndexOf(") -> ");
    host.args = splitTop(signature.slice(1, arrow >= 0 ? arrow : signature.length - 1)).map((arg) => arg.replace(/^_\d+: /, ""));
    host.ret = arrow >= 0 ? signature.slice(arrow + 5) : "()";
    open = host;
  }
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if ("<([{".includes(char)) depth += 1;
    else if (">)]}".includes(char)) depth -= 1;
    else if (char === "," && depth === 0) { parts.push(text.slice(start, index).trim()); start = index + 1; }
  }
  if (text.slice(start).trim()) parts.push(text.slice(start).trim());
  return parts;
}
