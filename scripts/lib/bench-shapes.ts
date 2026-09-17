/**
 * Where a declaration writes its parameter types, return type, fields, bases
 * and members -- the *regions* #296's answer key asks the language tools about.
 *
 * A region is only a span of text. What a name inside it means is always asked
 * of the tool (`definition`), never decided here; this file only says where to
 * look. TypeScript reads its own AST. Rust and Python are read from text with
 * brackets balanced, which is enough to find a region and nothing more.
 *
 * Nothing here imports `src/engine`.
 */
import ts from "typescript";

import { blankPython, blankRust, sourceOf, type Language, type Sym } from "./bench-tooling";

export interface Span { start: number; end: number }

export interface Signature {
  params: Array<{ receiver: boolean; type?: Span }>;
  /** `null` when none is written; Rust's unwritten return type is `()`. */
  returns: Span | null;
  bodyStart: number;
}

export interface Fields {
  typed: Span[];
  /** Fields whose type is not written, so a type absent from `typed` may still be held. */
  unannotated: number;
  /** Fields can come from somewhere else: a base class, an index signature. */
  open: boolean;
}

export interface Members {
  /** Member name to the offsets of its declarations' names. */
  names: Map<string, number[]>;
  open: boolean;
}

export interface ImplBlock {
  start: number;
  end: number;
  header: Span;
  traitName?: string;
  traitAt?: number;
  selfAt?: number;
  selfName?: string;
}

/** Index just past the bracket matching the one at `open`, or -1. */
export function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if ((c === "-" || c === "=") && text[i + 1] === ">") { i++; continue; }
    if (pairs[c]) stack.push(pairs[c]!);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    } else if (c === ")" || c === "]" || c === "}") {
      // A `<` that was a comparison rather than a bracket: drop it and retry.
      while (stack.length > 0 && stack[stack.length - 1] === ">") stack.pop();
      if (c === stack[stack.length - 1]) {
        stack.pop();
        if (stack.length === 0) return i + 1;
      }
    }
  }
  return -1;
}

/** Split `[start, end)` at top-level commas. */
export function splitTop(text: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  let depth = 0;
  let from = start;
  for (let i = start; i < end; i++) {
    const c = text[i]!;
    if ((c === "-" || c === "=") && text[i + 1] === ">") { i++; continue; }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth = Math.max(0, depth - 1);
    else if (c === "," && depth === 0) { out.push({ start: from, end: i }); from = i + 1; }
  }
  out.push({ start: from, end });
  return out.filter((s) => text.slice(s.start, s.end).trim().length > 0);
}

function firstTop(text: string, start: number, end: number, test: (i: number) => boolean): number {
  let depth = 0;
  for (let i = start; i < Math.min(end, text.length); i++) {
    const c = text[i]!;
    if (depth === 0 && test(i)) return i;
    if ((c === "-" || c === "=") && text[i + 1] === ">") { i++; continue; }
    if ("([{<".includes(c)) depth++;
    else if (")]}>".includes(c)) depth = Math.max(0, depth - 1);
  }
  return -1;
}

const skipWs = (text: string, i: number) => { while (i < text.length && /\s/.test(text[i]!)) i++; return i; };

/* ------------------------------------------------------------------ Rust */

function rustSignature(sym: Sym): Signature | undefined {
  const text = blankRust(sourceOf(sym.file));
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "<") { i = matchBracket(text, i); if (i < 0) return undefined; i = skipWs(text, i); }
  if (text[i] !== "(") return undefined;
  const close = matchBracket(text, i);
  if (close < 0) return undefined;
  const params = splitTop(text, i + 1, close - 1).map((p) => {
    const raw = text.slice(p.start, p.end).replace(/#\[[^\]]*\]/g, (s) => " ".repeat(s.length));
    const receiver = /^\s*(&\s*('\w+\s*)?)?(mut\s+)?self\b/.test(raw);
    const colon = firstTop(raw, 0, raw.length, (k) => raw[k] === ":" && raw[k + 1] !== ":" && raw[k - 1] !== ":");
    return { receiver, ...(colon >= 0 ? { type: { start: p.start + colon + 1, end: p.end } } : {}) };
  });
  let j = skipWs(text, close);
  let returns: Span | null = null;
  const stop = (k: number) => text[k] === "{" || text[k] === ";" || /^where\b/.test(text.slice(k, k + 6));
  if (text.startsWith("->", j)) {
    const end = firstTop(text, j + 2, sym.end + 1, stop);
    if (end < 0) return undefined;
    returns = { start: j + 2, end };
    j = end;
  }
  const bodyStart = firstTop(text, j, sym.end + 1, (k) => text[k] === "{" || text[k] === ";");
  return { params, returns, bodyStart: bodyStart < 0 ? sym.end : bodyStart };
}

function rustItemKeyword(sym: Sym): string {
  const text = sourceOf(sym.file).slice(Math.max(0, sym.start - 4), sym.nameStart);
  return /\b(struct|enum|union|trait|type|fn|impl|mod|const|static)\s+$/.exec(text)?.[1] ?? "";
}

function rustFields(sym: Sym): Fields | undefined {
  const text = blankRust(sourceOf(sym.file));
  const keyword = rustItemKeyword(sym);
  if (keyword === "trait") return { typed: [], unannotated: 0, open: true };
  if (keyword !== "struct" && keyword !== "union" && keyword !== "enum") return undefined;
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "<") { i = matchBracket(text, i); if (i < 0) return undefined; i = skipWs(text, i); }
  if (/^where\b/.test(text.slice(i, i + 6))) {
    const next = firstTop(text, i, sym.end + 1, (k) => text[k] === "{" || text[k] === ";");
    if (next < 0) return undefined;
    i = next;
  }
  const typed: Span[] = [];
  const stripLead = (s: Span): Span => {
    const raw = text.slice(s.start, s.end).replace(/#\[[^\]]*\]/g, (m) => " ".repeat(m.length));
    const lead = /^\s*(pub(\s*\([^)]*\))?\s+)?/.exec(raw)![0].length;
    return { start: s.start + lead, end: s.end };
  };
  const typeOfField = (part: Span, tuple: boolean) => {
    const s = stripLead(part);
    if (tuple) { typed.push(s); return; }
    const raw = text.slice(s.start, s.end);
    const colon = firstTop(raw, 0, raw.length, (k) => raw[k] === ":" && raw[k + 1] !== ":" && raw[k - 1] !== ":");
    if (colon >= 0) typed.push({ start: s.start + colon + 1, end: s.end });
  };
  if (keyword === "struct" || keyword === "union") {
    if (text[i] === ";") return { typed, unannotated: 0, open: false };
    if (text[i] !== "{" && text[i] !== "(") return undefined;
    const close = matchBracket(text, i);
    if (close < 0) return undefined;
    for (const part of splitTop(text, i + 1, close - 1)) typeOfField(part, text[i] === "(");
    return { typed, unannotated: 0, open: false };
  }
  if (text[i] !== "{") return undefined;
  const close = matchBracket(text, i);
  if (close < 0) return undefined;
  // An enum variant's payload is the nearest thing an enum has to a field.
  for (const variant of splitTop(text, i + 1, close - 1)) {
    const v = stripLead(variant);
    const raw = text.slice(v.start, v.end);
    const open = raw.search(/[({]/);
    if (open < 0) continue;
    const inner = matchBracket(text, v.start + open);
    if (inner < 0) continue;
    for (const part of splitTop(text, v.start + open + 1, inner - 1)) typeOfField(part, raw[open] === "(");
  }
  return { typed, unannotated: 0, open: false };
}

export function rustImplBlocks(file: string): ImplBlock[] {
  const text = blankRust(sourceOf(file));
  const out: ImplBlock[] = [];
  for (const m of text.matchAll(/(^|[\s;}])impl\b/g)) {
    const start = m.index! + m[1]!.length;
    let i = skipWs(text, start + 4);
    if (text[i] === "<") { i = matchBracket(text, i); if (i < 0) continue; }
    const open = firstTop(text, i, text.length, (k) => text[k] === "{" || text[k] === ";");
    if (open < 0 || text[open] !== "{") continue;
    const close = matchBracket(text, open);
    if (close < 0) continue;
    const headerText = text.slice(i, open).replace(/\bwhere\b[\s\S]*$/, "");
    const forAt = /\bfor\b/.exec(headerText);
    let traitName: string | undefined;
    let traitAt: number | undefined;
    let typePart = headerText;
    let typeOffset = i;
    if (forAt) {
      const before = headerText.slice(0, forAt.index);
      const trait = /((?:[A-Za-z_]\w*::)*)([A-Za-z_]\w*)\s*(?:<[\s\S]*)?$/.exec(before.trim());
      if (trait) {
        traitName = trait[2];
        traitAt = i + before.lastIndexOf(trait[2]!);
      }
      typePart = headerText.slice(forAt.index + 3);
      typeOffset = i + forAt.index + 3;
    }
    const self = /^[\s&!]*(?:'\w+\s+)?(?:mut\s+)?(?:dyn\s+)?(?:[A-Za-z_]\w*::)*([A-Za-z_]\w*)/.exec(typePart);
    out.push({
      start, end: close, header: { start: i, end: open },
      ...(traitName ? { traitName, traitAt } : {}),
      ...(self ? { selfAt: typeOffset + self[0].length - self[1]!.length, selfName: self[1] } : {}),
    });
  }
  return out;
}

/* ---------------------------------------------------------------- Python */

function pythonSignature(sym: Sym): Signature | undefined {
  const text = blankPython(sourceOf(sym.file));
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "[") { i = matchBracket(text, i); if (i < 0) return undefined; i = skipWs(text, i); }
  if (text[i] !== "(") return undefined;
  const close = matchBracket(text, i);
  if (close < 0) return undefined;
  const around = sourceOf(sym.file).slice(Math.max(0, sym.start - 200), sym.start + 40);
  const params = splitTop(text, i + 1, close - 1).flatMap((p, index) => {
    const raw = text.slice(p.start, p.end).trim();
    if (raw === "/" || raw === "*") return [];
    const colon = firstTop(text, p.start, p.end, (k) => text[k] === ":");
    const eq = firstTop(text, p.start, p.end, (k) => text[k] === "=");
    const name = /^\s*\**\s*(\w+)/.exec(text.slice(p.start, p.end))?.[1];
    const receiver = index === 0 && sym.containerKind === "type" && (name === "self" || name === "cls")
      && !/@staticmethod/.test(around);
    const type = colon >= 0 ? { start: colon + 1, end: eq > colon ? eq : p.end } : undefined;
    return [{ receiver, ...(type ? { type } : {}) }];
  });
  const j = skipWs(text, close);
  const end = firstTop(text, j, text.length, (k) => text[k] === ":");
  if (end < 0) return undefined;
  const returns: Span | null = text.startsWith("->", j) ? { start: j + 2, end } : null;
  return { params, returns, bodyStart: end + 1 };
}

/** A class body's text, with the indentation its own statements are written at. */
function pythonClassBody(sym: Sym): { text: string; indent: string; start: number } | undefined {
  const text = blankPython(sourceOf(sym.file));
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "[") i = matchBracket(text, i);
  if (i >= 0 && text[i] === "(") i = matchBracket(text, i);
  if (i < 0) return undefined;
  const colon = text.indexOf(":", i);
  if (colon < 0) return undefined;
  const start = text.indexOf("\n", colon) + 1;
  const body = text.slice(start, sym.end);
  const indent = /^([ \t]+)\S/m.exec(body)?.[1];
  if (indent === undefined) return undefined;
  return { text: body, indent, start };
}

function pythonBases(sym: Sym): Span[] | undefined {
  const text = blankPython(sourceOf(sym.file));
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "[") i = matchBracket(text, i);
  if (i < 0) return undefined;
  if (text[i] !== "(") return [];
  const close = matchBracket(text, i);
  if (close < 0) return undefined;
  return splitTop(text, i + 1, close - 1)
    .filter((s) => !/^\s*(\w+\s*=|\*)/.test(text.slice(s.start, s.end)));
}

const PY_PLAIN_BASES = new Set([
  "object", "Generic", "Protocol", "ABC", "ABCMeta", "TypedDict", "NamedTuple",
  "Enum", "IntEnum", "StrEnum", "Exception", "BaseException", "ValueError", "TypeError", "RuntimeError",
  "str", "int", "dict", "list", "tuple", "set", "float",
]);

const baseHeadName = (text: string, span: Span) =>
  text.slice(span.start, span.end).trim().replace(/\[[\s\S]*$/, "").split(".").pop()!.trim();

function pythonFields(sym: Sym): Fields | undefined {
  const body = pythonClassBody(sym);
  if (!body) return undefined;
  const typed: Span[] = [];
  let unannotated = 0;
  const own = new RegExp(`^${body.indent}([A-Za-z_]\\w*)[ \\t]*:[ \\t]*([^=\\n]+)`, "gm");
  for (const m of body.text.matchAll(own)) {
    const at = body.start + m.index! + m[0].length - m[2]!.length;
    typed.push({ start: at, end: at + m[2]!.length });
  }
  for (const m of body.text.matchAll(new RegExp(`^${body.indent}([A-Za-z_]\\w*)[ \\t]*=(?!=)`, "gm"))) {
    if (!m[1]!.startsWith("__")) unannotated++;
  }
  for (const m of body.text.matchAll(/\bself\.[A-Za-z_]\w*[ \t]*:[ \t]*([^=\n]+)=/g)) {
    const at = body.start + m.index! + m[0].indexOf(m[1]!, m[0].indexOf(":"));
    typed.push({ start: at, end: at + m[1]!.length });
  }
  for (const _ of body.text.matchAll(/\bself\.[A-Za-z_]\w*[ \t]*=(?!=)/g)) unannotated++;
  const text = sourceOf(sym.file);
  const open = (pythonBases(sym) ?? []).some((b) => !PY_PLAIN_BASES.has(baseHeadName(text, b)));
  return { typed, unannotated, open };
}

function pythonMembers(sym: Sym): Members | undefined {
  const body = pythonClassBody(sym);
  if (!body) return undefined;
  const names = new Map<string, number[]>();
  const add = (name: string, at: number) => names.set(name, [...(names.get(name) ?? []), at]);
  for (const m of body.text.matchAll(new RegExp(`^${body.indent}(?:async[ \\t]+)?def[ \\t]+([A-Za-z_]\\w*)`, "gm"))) {
    add(m[1]!, body.start + m.index! + m[0].length - m[1]!.length);
  }
  for (const m of body.text.matchAll(new RegExp(`^${body.indent}([A-Za-z_]\\w*)[ \\t]*[:=]`, "gm"))) {
    add(m[1]!, body.start + m.index! + body.indent.length);
  }
  for (const m of body.text.matchAll(/\bself\.([A-Za-z_]\w*)[ \t]*(?::[^=\n]*)?=(?!=)/g)) {
    add(m[1]!, body.start + m.index! + 5);
  }
  const text = sourceOf(sym.file);
  const open = /def[ \t]+__getattr__|__slots__|def[ \t]+__getattribute__/.test(body.text)
    || (pythonBases(sym) ?? []).some((b) => !PY_PLAIN_BASES.has(baseHeadName(text, b)));
  return { names, open };
}

/* ------------------------------------------------------------ TypeScript */

const tsSources = new Map<string, ts.SourceFile>();
function tsSource(file: string): ts.SourceFile {
  let source = tsSources.get(file);
  if (!source) {
    source = ts.createSourceFile(file, sourceOf(file), ts.ScriptTarget.Latest, true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    tsSources.set(file, source);
  }
  return source;
}

function tsNodeAt(sym: Sym): ts.Node | undefined {
  const source = tsSource(sym.file);
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (found) return;
    if (ts.isConstructorDeclaration(node) && sym.name === "constructor"
      && node.getStart(source) <= sym.nameStart && sym.nameStart < node.getEnd()) { found = node; return; }
    const name = (node as ts.NamedDeclaration).name;
    if (name && name.getStart(source) === sym.nameStart) { found = node; return; }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function tsFunctionOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionLike(node)) return node;
  const init = (node as ts.VariableDeclaration).initializer;
  if (!init) return undefined;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return init;
  if (ts.isCallExpression(init)) {
    // `const Menu = forwardRef((props, ref) => ...)`, `memo(...)`.
    const inner = init.arguments.find((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    if (inner) return inner as ts.SignatureDeclaration;
  }
  return undefined;
}

function tsSignature(sym: Sym): Signature | undefined {
  const node = tsNodeAt(sym);
  const fn = node && tsFunctionOf(node);
  if (!fn) return undefined;
  const source = tsSource(sym.file);
  const params = fn.parameters.map((p) => ({
    receiver: ts.isIdentifier(p.name) && p.name.text === "this",
    ...(p.type ? { type: { start: p.type.getStart(source), end: p.type.getEnd() } } : {}),
  }));
  const returns = fn.type ? { start: fn.type.getStart(source), end: fn.type.getEnd() } : null;
  const body = (fn as ts.FunctionLikeDeclarationBase).body;
  return { params, returns, bodyStart: body ? body.getStart(source) : fn.getEnd() };
}

function tsMembersOf(node: ts.Node): ReadonlyArray<ts.ClassElement | ts.TypeElement> | undefined {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return node.members;
  if (ts.isInterfaceDeclaration(node)) return node.members;
  if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) return node.type.members;
  const init = (node as ts.VariableDeclaration).initializer;
  if (init && ts.isClassExpression(init)) return init.members;
  return undefined;
}

function tsHeritage(node: ts.Node): ts.ExpressionWithTypeArguments[] {
  const clauses = (node as ts.ClassDeclaration | ts.InterfaceDeclaration).heritageClauses ?? [];
  return clauses.flatMap((c) => [...c.types]);
}

const tsExtendsSomething = (node: ts.Node) => ((node as ts.ClassDeclaration).heritageClauses ?? [])
  .some((c) => c.token === ts.SyntaxKind.ExtendsKeyword);

function tsFields(sym: Sym): Fields | undefined {
  const node = tsNodeAt(sym);
  if (!node) return undefined;
  const source = tsSource(sym.file);
  const members = tsMembersOf(node);
  if (!members) {
    // A type alias that is not an object literal: a union, a mapped type, a conditional.
    return ts.isTypeAliasDeclaration(node) ? { typed: [], unannotated: 0, open: true } : undefined;
  }
  const typed: Span[] = [];
  let unannotated = 0;
  let open = tsExtendsSomething(node);
  for (const m of members) {
    if (ts.isPropertyDeclaration(m) || ts.isPropertySignature(m)) {
      if (m.type) typed.push({ start: m.type.getStart(source), end: m.type.getEnd() });
      else unannotated++;
    } else if (ts.isIndexSignatureDeclaration(m)) {
      open = true;
    } else if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        if (!ts.getModifiers(p)?.length) continue;
        if (p.type) typed.push({ start: p.type.getStart(source), end: p.type.getEnd() });
        else unannotated++;
      }
    }
  }
  return { typed, unannotated, open };
}

function tsBases(sym: Sym): Span[] | undefined {
  const node = tsNodeAt(sym);
  if (!node) return undefined;
  const source = tsSource(sym.file);
  return tsHeritage(node).map((h) => ({ start: h.expression.getStart(source), end: h.expression.getEnd() }));
}

function tsMembers(sym: Sym): Members | undefined {
  const node = tsNodeAt(sym);
  if (!node) return undefined;
  const members = tsMembersOf(node);
  if (!members) return undefined;
  const source = tsSource(sym.file);
  const names = new Map<string, number[]>();
  const add = (name: string, at: number) => names.set(name, [...(names.get(name) ?? []), at]);
  let open = tsExtendsSomething(node);
  for (const m of members) {
    if (ts.isIndexSignatureDeclaration(m)) { open = true; continue; }
    if (ts.isConstructorDeclaration(m)) {
      for (const p of m.parameters) {
        if (ts.getModifiers(p)?.length && ts.isIdentifier(p.name)) add(p.name.text, p.name.getStart(source));
      }
      continue;
    }
    const name = m.name;
    if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name))) {
      add(name.text, name.getStart(source));
    }
  }
  return { names, open };
}

/* ------------------------------------------------------------------- API */

export function signatureOf(language: Language, sym: Sym): Signature | undefined {
  if (language === "rust") return rustSignature(sym);
  if (language === "python") return pythonSignature(sym);
  return tsSignature(sym);
}

export function fieldsOf(language: Language, sym: Sym): Fields | undefined {
  if (language === "rust") return rustFields(sym);
  if (language === "python") return pythonFields(sym);
  return tsFields(sym);
}

export function basesOf(language: Language, sym: Sym): Span[] | undefined {
  if (language === "python") return pythonBases(sym);
  if (language === "ts") return tsBases(sym);
  // A Rust trait's supertraits. A struct's conformances are found through
  // `impl` blocks instead, which is the whole reason `@conforms` may not
  // accuse in Rust.
  if (rustItemKeyword(sym) !== "trait") return undefined;
  const text = blankRust(sourceOf(sym.file));
  let i = skipWs(text, sym.nameStart + sym.name.length);
  if (text[i] === "<") i = matchBracket(text, i);
  if (i < 0) return undefined;
  i = skipWs(text, i);
  if (text[i] !== ":") return [];
  const end = firstTop(text, i + 1, sym.end, (k) => text[k] === "{" || /^where\b/.test(text.slice(k, k + 6)));
  if (end < 0) return undefined;
  const out: Span[] = [];
  let at = i + 1;
  for (const part of text.slice(i + 1, end).split("+")) {
    out.push({ start: at, end: at + part.length });
    at += part.length + 1;
  }
  return out;
}

/** Rust members live in `impl` blocks, so the caller gathers them from `rustImplBlocks`. */
export function membersOf(language: Language, sym: Sym): Members | undefined {
  if (language === "python") return pythonMembers(sym);
  if (language === "ts") return tsMembers(sym);
  return undefined;
}

export function rustKeyword(sym: Sym): string {
  return rustItemKeyword(sym);
}

export const isTsx = (file: string) => file.endsWith(".tsx");
