/**
 * classify.mts <set>: every call that keeps a missed wrong @calls arrow's tail open, labelled
 * finer than the checker's own reason, by reading the source around it.
 * Input: walls-<set>.jsonl (tail-body / tail-site lines from the map patch, plus the
 * per-pass callSitesIn lines), rows-<set>.json. Output: sites-<set>.jsonl, one line per site.
 */
import path from "node:path";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const REPO = "/Users/noelmatero/board-ai-map2";
const { initEngine, parseSource, languageOf } = await import(path.join(REPO, "src/engine/parse.ts"));
await initEngine();
const SET = process.argv[2]!;
const O = "/Users/noelmatero/bench-map2/trace";
const ROOT: Record<string, string> = {
  main: "/Users/noelmatero/board-ai/.corpus",
  holdout: "/Users/noelmatero/.board-ai-holdout/corpus",
  "holdout-b": "/Users/noelmatero/.board-ai-holdout-b/corpus",
};
type Row = { id: number; project: string; frm: string; to: string };
const rows: Row[] = JSON.parse(readFileSync(`${O}/rows-${SET}.json`, "utf8"));
const byId = new Map(rows.map((r) => [r.id, r]));
const lines = readFileSync(`${O}/walls-${SET}.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

const FN = new Set(["function_declaration", "generator_function_declaration", "method_definition", "arrow_function",
  "function_expression", "function", "generator_function", "function_definition", "lambda", "function_item", "closure_expression",
  "function_signature_item"]);
const CLASSY = new Set(["class_declaration", "abstract_class_declaration", "class_definition", "class", "struct_item", "enum_item", "trait_item", "interface_declaration"]);
const MEMBER = new Set(["member_expression", "attribute", "field_expression"]);
const TS_HOST = new Set("setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask structuredClone fetch Response Request Headers URL URLSearchParams TextEncoder TextDecoder AbortController AbortSignal Blob File FormData ReadableStream WritableStream TransformStream WebSocket Event EventTarget crypto performance atob btoa process Buffer require module exports global globalThis window document navigator Worker MessageChannel BroadcastChannel DOMException Bun Deno".split(" "));
const ES = new Set("AggregateError Array ArrayBuffer BigInt Boolean DataView Date Error EvalError FinalizationRegistry Function Intl JSON Map Math Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError URIError WeakMap WeakRef WeakSet console decodeURI decodeURIComponent encodeURI encodeURIComponent isFinite isNaN parseFloat parseInt".split(" "));
const PY = new Set("abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip BaseException Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration StopAsyncIteration NotImplementedError OSError AssertionError ImportError LookupError ArithmeticError ZeroDivisionError UnicodeDecodeError UnicodeEncodeError GeneratorExit KeyboardInterrupt SystemExit Warning DeprecationWarning UserWarning RuntimeWarning NotImplemented Ellipsis".split(" "));
const RS = new Set("Ok Err Some None Box String Vec Default Option Result drop Into From ToString ToOwned Clone Iterator IntoIterator".split(" "));
const RS_STD_MACROS = new Set("println print eprintln eprint writeln write format format_args vec assert assert_eq assert_ne debug_assert debug_assert_eq debug_assert_ne panic unreachable unimplemented todo matches cfg dbg concat stringify include_str include_bytes env option_env line column file module_path compile_error thread_local".split(" "));

function langOf(file: string): string { const l = languageOf(file); return l === "tsx" ? "ts" : l; }
const trees = new Map<string, { tree: any; source: string }>();
function treeOf(project: string, file: string) {
  const key = `${project}/${file}`;
  if (trees.has(key)) return trees.get(key)!;
  const p = path.join(ROOT[SET]!, project, file);
  if (!existsSync(p)) { trees.set(key, undefined as any); return undefined; }
  const source = readFileSync(p, "utf8");
  const tree = parseSource(source, languageOf(file));
  const v = { tree, source };
  trees.set(key, v);
  return v;
}
function* walk(n: any): Generator<any> { yield n; for (let i = 0; i < n.namedChildCount; i++) yield* walk(n.namedChild(i)); }
function ancestors(n: any): any[] { const out = []; for (let p = n.parent; p; p = p.parent) out.push(p); return out; }
function fnOf(n: any): any { // the function node a declaration stands for
  if (FN.has(n.type)) return n;
  const v = n.childForFieldName?.("value");
  if (v && FN.has(v.type)) return v;
  return undefined;
}
/** Identifiers a parameter list binds, skipping types and defaults. */
function bound(n: any, out = new Set<string>()): Set<string> {
  if (!n) return out;
  if (["identifier", "shorthand_property_identifier_pattern", "self", "this"].includes(n.type)) { out.add(n.text); return out; }
  for (let i = 0; i < n.childCount; i++) {
    const f = n.fieldNameForChild(i);
    if (f === "type" || f === "value" && n.type !== "pair_pattern" || f === "default_value" || f === "return_type") continue;
    const c = n.child(i); if (c && c.isNamed) bound(c, out);
  }
  return out;
}
function paramsOf(fn: any): Set<string> {
  const p = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  return bound(p);
}
/** How `name` is declared directly in scope `s` (not descending into nested functions other than `via`). */
function declaredIn(s: any, name: string, lang: string): { how: string; value?: string } | undefined {
  const body = FN.has(s.type) ? s.childForFieldName("body") ?? s : s;
  let found: { how: string; value?: string } | undefined;
  const visit = (n: any) => {
    if (found) return;
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (found) return;
      const nm = c.childForFieldName?.("name");
      if ((FN.has(c.type) || CLASSY.has(c.type)) && nm?.text === name && c.type !== "arrow_function") { found = { how: CLASSY.has(c.type) ? "class" : "nested-function" }; return; }
      if (c.type === "variable_declarator" || c.type === "let_declaration" || c.type === "assignment" || c.type === "assignment_expression" || c.type === "named_expression" || c.type === "augmented_assignment") {
        const left = c.childForFieldName("name") ?? c.childForFieldName("pattern") ?? c.childForFieldName("left");
        if (left && bound(left).has(name)) {
          const v = c.childForFieldName("value") ?? c.childForFieldName("right");
          found = { how: v && FN.has(v.type) ? "function-literal" : "assigned", value: v?.text.replace(/\s+/g, " ").slice(0, 60) };
          return;
        }
      }
      if (["for_statement", "for_in_statement", "for_expression", "for_in_clause", "for_of_statement"].includes(c.type)) {
        const left = c.childForFieldName("left") ?? c.childForFieldName("pattern");
        if (left && bound(left).has(name)) { found = { how: "loop", value: (c.childForFieldName("right") ?? c.childForFieldName("value"))?.text.slice(0, 60) }; return; }
      }
      if (["match_arm", "let_condition", "if_let_expression", "while_let_expression"].includes(c.type)) {
        const pat = c.childForFieldName("pattern");
        if (pat && bound(pat).has(name)) { found = { how: "pattern" }; return; }
      }
      if (["with_item", "as_pattern", "except_clause", "catch_clause"].includes(c.type) && c.text.match(new RegExp(`\\bas\\s+${name}\\b|\\(\\s*${name}\\s*\\)`))) { found = { how: "with-or-except" }; return; }
      if (["import_statement", "import_from_statement", "use_declaration", "future_import_statement"].includes(c.type) && new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(c.text)) { found = { how: "imported" }; return; }
      if (FN.has(c.type) || CLASSY.has(c.type)) {
        if (s.type === "program" || s.type === "module" || s.type === "source_file") {
          // a top-level scope: its functions' insides are not top-level
          if (CLASSY.has(c.type)) continue;
          continue;
        }
        continue;
      }
      visit(c);
    }
  };
  visit(body);
  return found;
}
const declCache = new Map<string, boolean>();
function repoDeclaresMethod(project: string, name: string, lang: string): boolean {
  const key = `${project}|${name}|${lang}`;
  if (declCache.has(key)) return declCache.get(key)!;
  const root = path.join(ROOT[SET]!, project);
  const e = name.replace(/\$/g, "\\$");
  const [inc, re] = lang === "python" ? [["--include=*.py"], `def\\s+${e}\\b`]
    : lang === "rust" ? [["--include=*.rs"], `fn\\s+${e}\\b`]
    : [["--include=*.ts", "--include=*.tsx", "--include=*.js", "--include=*.mjs"], `(function\\s*\\*?\\s*${e}\\b|^\\s*(public|private|protected|static|async|override|readonly|get|set|\\s)*\\*?${e}\\s*[(<=:?]|[{,]\\s*${e}\\s*[(:]|\\b${e}\\s*=\\s*(async\\s*)?(\\(|function))`];
  let yes = false;
  try {
    execFileSync("grep", ["-rqE", ...inc, "--exclude-dir=node_modules", "--exclude-dir=target", "--exclude-dir=.git", re, root], { stdio: "ignore" });
    yes = true;
  } catch { yes = false; }
  declCache.set(key, yes);
  return yes;
}

/** The site's call node: by the name's offset, or (computed) the non-name callee on that line. */
function callNodeAt(tree: any, site: any, routineNode: any): any {
  if (site.nameAt) {
    let n = tree.rootNode.descendantForIndex(site.nameAt.start, site.nameAt.end);
    for (let k = 0; n && k < 6; k++, n = n.parent) {
      if (["call_expression", "call", "new_expression", "macro_invocation"].includes(n.type)) return n;
    }
    return undefined;
  }
  for (const n of indexOf(tree).calls.get(site.line) ?? []) {
    const f = n.childForFieldName("function") ?? n.childForFieldName("constructor");
    if (!f) continue;
    if (["identifier", "scoped_identifier", "member_expression", "attribute", "field_expression", "generic_function"].includes(f.type)) continue;
    return n;
  }
  return undefined;
}
const indexes = new WeakMap<any, { decl: Map<number, any[]>; calls: Map<number, any[]> }>();
function indexOf(tree: any) {
  let ix = indexes.get(tree);
  if (ix) return ix;
  ix = { decl: new Map(), calls: new Map() };
  const cursor = tree.rootNode.walk();
  let done = false;
  while (!done) {
    const n = cursor.currentNode;
    const row = n.startPosition.row + 1;
    if (n.isNamed) {
      if (["call_expression", "call", "new_expression"].includes(n.type)) { const a = ix.calls.get(row) ?? []; a.push(n); ix.calls.set(row, a); }
      else if (n.type === "impl_item" || FN.has(n.type) || n.type === "variable_declarator" || n.type === "assignment" || n.type === "public_field_definition" || n.type === "pair" || CLASSY.has(n.type) || n.type === "decorated_definition") { const a = ix.decl.get(row) ?? []; a.push(n); ix.decl.set(row, a); }
    }
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) { if (!cursor.gotoParent()) { done = true; break; } }
  }
  indexes.set(tree, ix);
  return ix;
}
function routineNodeFor(tree: any, rline: number, routine: string, at?: any): any {
  const cands = (indexOf(tree).decl.get(rline) ?? []).filter((n: any) => {
    const nm = n.childForFieldName?.("name") ?? n.childForFieldName?.("left") ?? n.childForFieldName?.("key");
    return nm?.text === routine || n.type === "impl_item";
  });
  if (at) {
    const ups = new Set(ancestors(at).map((a: any) => a.id));
    const c = cands.find((n: any) => ups.has(n.id));
    if (c) return fnOf(c) ?? c;
  }
  const c = cands[0];
  return c ? fnOf(c) ?? c : undefined;
}

function classify(site: any, row: Row, lang: string): { label: string; detail: string } {
  const t = treeOf(row.project, site.file);
  const why: string = site.why;
  if (why === "macro") return { label: "inside a Rust macro", detail: "" };
  if (why === "abstract-receiver") return { label: lang === "rust" ? "trait call" : lang === "python" ? "Protocol/ABC call" : "interface call", detail: site.name };
  if (why === "overridden") return { label: "a method subclasses override", detail: site.name };
  if (why === "elsewhere") return { label: "a re-export it doesn't follow", detail: site.name };
  if (why === "ambiguous") return { label: "a name declared twice in the file", detail: site.name };
  if (why === "unplaced") return { label: "a library import it doesn't place", detail: site.name };
  if (!t?.tree) return { label: `${why} (source unread)`, detail: site.name };
  const rn0 = routineNodeFor(t.tree, site.rline, site.routine);
  const call = callNodeAt(t.tree, site, rn0);
  const text = (call?.text ?? "").replace(/\s+/g, " ").slice(0, 80);
  const rn = call ? routineNodeFor(t.tree, site.rline, site.routine, call) ?? rn0 : rn0;
  if (why === "dynamic") {
    if (["getattr", "setattr", "vars", "globals", "locals"].includes(site.name)) return { label: "getattr / setattr", detail: text };
    if (["eval", "exec", "__import__", "Function"].includes(site.name)) return { label: "eval / exec / import by name", detail: text };
    if (lang === "rust") return { label: "a trait method named call (Service::call)", detail: text };
    if (lang === "python") {
      const f = call?.childForFieldName("function");
      if (f && f.type === "identifier") return { label: "local holding a function", detail: `python call(): ${text}` };
      return { label: repoDeclaresMethod(row.project, site.name, lang) ? "a repo method named call read as dynamic" : "a method named call/apply (Python)", detail: text };
    }
    // TS f.call(...) / f.apply(...): what is f?
    const f = call?.childForFieldName("function");
    const obj = f && MEMBER.has(f.type) ? f.childForFieldName("object") : undefined;
    return { label: ".call / .apply on a function value", detail: `${obj?.type ?? "?"}: ${text}` };
  }
  if (why === "computed") {
    if (!call) return { label: "computed call (unlocated)", detail: "" };
    let f = call.childForFieldName("function") ?? call.childForFieldName("constructor");
    if (!f) return { label: "computed call (unlocated)", detail: text };
    if (f.type === "super") return { label: "super(...) constructor call", detail: text };
    if (call.type === "new_expression") return { label: "new on an expression", detail: text };
    if (f.type === "subscript_expression" || f.type === "subscript" || f.type === "index_expression") return { label: "obj[k]() — a function looked up by key", detail: text };
    if (f.type === "call_expression" || f.type === "call") return { label: "a call's result called: f(x)(y)", detail: text };
    if (f.type === "non_null_expression") { const inner = f.namedChild(0); return { label: inner && MEMBER.has(inner.type) ? "a function stored in a field: (self.f)(x)" : "local holding a function", detail: text }; }
    if (f.type === "await_expression" || f.type === "instantiation_expression") return { label: "TS generic call after await read as an expression", detail: text };
    if (f.type === "import") return { label: "dynamic import()", detail: text };
    if (f.type === "parenthesized_expression") {
      const inner = f.namedChild(0);
      if (inner && FN.has(inner.type)) return { label: "a function written and called on the spot", detail: text };
      if (inner && MEMBER.has(inner.type)) return { label: "a function stored in a field: (self.f)(x)", detail: text };
      return { label: "an expression called", detail: `${inner?.type}: ${text}` };
    }
    if (FN.has(f.type)) return { label: "a function written and called on the spot", detail: text };
    if (f.type === "generic_function") return { label: "computed: generic call", detail: text };
    return { label: "an expression called", detail: `${f.type}: ${text}` };
  }
  const name: string = site.name;
  if (why === "local-callee" || why === "unbound") {
    if (lang === "rust" && call?.type === "macro_invocation") return { label: RS_STD_MACROS.has(name) ? "built-in / prelude name misread" : "a Rust macro it doesn't follow", detail: text };
    if (lang === "rust" && RS.has(name)) return { label: "built-in / prelude name misread", detail: text };
    if (lang === "python" && PY.has(name)) return { label: "built-in / prelude name misread", detail: text };
    if (lang === "ts" && ES.has(name)) return { label: "built-in / prelude name misread", detail: text };
    if (lang === "ts" && TS_HOST.has(name)) return { label: "host global (setTimeout, fetch) misread", detail: text };
    // a parameter of the routine, or of a closure inside it
    const ups = call ? ancestors(call) : [];
    const stop = rn ? ups.findIndex((a: any) => a.id === rn.id) : -1;
    const inner = stop >= 0 ? ups.slice(0, stop).filter((a) => FN.has(a.type)) : [];
    for (const a of inner) if (paramsOf(a).has(name)) return { label: "callback parameter", detail: `of an inner closure: ${text}` };
    if (rn && FN.has(rn.type) && paramsOf(rn).has(name)) return { label: "callback parameter", detail: text };
    for (const a of [...inner]) { const d = declaredIn(a, name, lang); if (d) return labelLocal(d, text); }
    if (rn) { const d = declaredIn(rn, name, lang); if (d) return labelLocal(d, text); }
    // an enclosing function
    const outer = stop >= 0 ? ups.slice(stop + 1).filter((a) => FN.has(a.type)) : [];
    for (const a of outer) {
      if (paramsOf(a).has(name)) return { label: "closure-captured name", detail: `outer parameter: ${text}` };
      const d = declaredIn(a, name, lang); if (d) return { label: "closure-captured name", detail: `outer ${d.how}: ${text}` };
    }
    // class body or file level
    const cls = ups.find((a) => CLASSY.has(a.type));
    if (cls) { const d = declaredIn(cls, name, lang); if (d && d.how !== "nested-function") return { label: "module-level value called", detail: `class-level ${d.how}: ${d.value ?? ""} | ${text}` }; }
    const top = declaredIn(t.tree.rootNode, name, lang);
    if (top?.how === "imported") return { label: why === "unbound" ? "imported name not resolved" : "imported value called", detail: text };
    if (top) return { label: "module-level value called", detail: `${top.how}: ${top.value ?? ""} | ${text}` };
    const wild = /from\s+\S+\s+import\s+\*|use\s+[\w:]+::\*|export\s+\*\s+from/.test(t.source);
    if (wild) return { label: "a name from a wildcard import", detail: text };
    if (lang === "rust" && /^[A-Z]/.test(name)) return { label: "a Rust enum variant or pattern name", detail: text };
    return { label: "a name declared nowhere visible", detail: text };
  }
  if (why === "receiver") {
    const f = call?.childForFieldName("function") ?? call?.childForFieldName("constructor");
    if (!call || !f) return { label: "untyped value: unlocated", detail: name };
    if (!MEMBER.has(f.type)) {
      if (f.type === "identifier" || f.type === "this" || f.type === "self") return { label: "a method on self the class doesn't declare", detail: text };
      if (f.type === "scoped_identifier") return { label: "untyped value: Type::method", detail: text };
      return { label: `untyped value: ${f.type}`, detail: text };
    }
    let obj = f.childForFieldName("object") ?? f.childForFieldName("value");
    while (obj && ["parenthesized_expression", "non_null_expression", "await_expression", "as_expression", "reference_expression", "try_expression"].includes(obj.type)) obj = obj.namedChild(0);
    const declared = repoDeclaresMethod(row.project, name, lang);
    const tail = declared ? "" : " — method name nowhere in the repo";
    const shape = (() => {
      if (!obj) return "other";
      if (["self", "this"].includes(obj.type) || ["self", "this", "cls"].includes(obj.text)) return "a method on self the class doesn't declare";
      if (MEMBER.has(obj.type)) {
        let root = obj; while (root && MEMBER.has(root.type)) root = root.childForFieldName("object") ?? root.childForFieldName("value");
        if (root && (["self", "this"].includes(root.type) || ["self", "this", "cls"].includes(root.text))) return "a field of unknown type";
        return "an attribute chain of unknown type";
      }
      if (obj.type === "identifier") {
        if (rn && FN.has(rn.type) && paramsOf(rn).has(obj.text)) return "a parameter of unknown type";
        const ups = ancestors(call);
        for (const a of ups.filter((x) => FN.has(x.type))) { if (paramsOf(a).has(obj.text)) return "a parameter of unknown type"; if (declaredIn(a, obj.text, lang)) return "a local of unknown type"; }
        return "a module-level or imported value of unknown type";
      }
      if (obj.type === "call_expression" || obj.type === "call") return "the result of a call";
      if (obj.type === "subscript_expression" || obj.type === "subscript" || obj.type === "index_expression") return "an item taken from a collection";
      if (/string|template|array|list|dictionary|object|number|integer|literal/.test(obj.type)) return "a literal's method";
      return "other expression";
    })();
    if (shape === "a method on self the class doesn't declare") return { label: shape, detail: text };
    return { label: `untyped value: ${shape}${tail}`, detail: text };
  }
  return { label: why, detail: text };
}
function labelLocal(d: { how: string; value?: string }, text: string) {
  switch (d.how) {
    case "loop": return { label: "loop over functions", detail: `${d.value ?? ""} | ${text}` };
    case "nested-function": return { label: "a function defined inside the routine", detail: text };
    case "function-literal": return { label: "a function defined inside the routine", detail: `literal: ${text}` };
    case "pattern": return { label: "a Rust enum variant or pattern name", detail: text };
    case "imported": return { label: "imported value called", detail: text };
    case "class": return { label: "a class defined inside the routine", detail: text };
    default: return { label: "local holding a function", detail: `${d.how}: ${d.value ?? ""} | ${text}` };
  }
}

// Where a tail names a class, struct or trait: the line spans its routines live in (Rust: every impl for it).
const spans: Record<number, Array<[number, number]>> = {};
for (const row of rows) {
  const [file, sym] = row.frm.split("#");
  if (!sym) continue;
  const t = treeOf(row.project, file!);
  if (!t?.tree) continue;
  const name = sym.split(/\.|::/).pop()!;
  const got: Array<[number, number]> = [];
  for (const n of walk(t.tree.rootNode)) {
    const nm = n.type === "impl_item" ? n.childForFieldName("type") : n.childForFieldName?.("name");
    if (!nm) continue;
    const plain = nm.text.replace(/<.*$/, "");
    if (plain !== name) continue;
    if (CLASSY.has(n.type) || n.type === "impl_item") got.push([n.startPosition.row + 1, n.endPosition.row + 1]);
  }
  if (got.length) spans[row.id] = got;
}
writeFileSync(`${O}/spans-${SET}.json`, JSON.stringify(spans));
const out: string[] = [];
const memo = new Map<string, { label: string; detail: string }>();
for (const s of lines) {
  if (s.stage !== "tail-site") continue;
  const id = Number(String(s.arrow).split("|")[0]);
  const row = byId.get(id);
  if (!row) continue;
  const [tfile, tsym] = row.frm.split("#");
  const tname = (tsym ?? "").split(/\.|::/).pop();
  const inSpan = (spans[id] ?? []).some(([a, b]) => a <= s.rline && s.rline <= b);
  if (s.file !== tfile || !(s.routine.replace(/^#/, "") === tname || inSpan)) continue;
  const lang = langOf(s.file);
  const key = `${row.project}|${s.file}|${s.line}|${s.name}|${s.why}|${s.routine}|${s.rline}|${JSON.stringify(s.nameAt)}`;
  let c = memo.get(key);
  if (!c) {
    try { c = classify(s, row, lang); } catch (e) { c = { label: `${s.why} (classifier error)`, detail: String(e).slice(0, 80) }; }
    memo.set(key, c);
  }
  if (out.length % 500 === 0) console.error(SET, out.length, memo.size);
  out.push(JSON.stringify({ set: SET, id, file: s.file, routine: s.routine, rline: s.rline, line: s.line, why: s.why, name: s.name, lang, ...c }));
}
writeFileSync(`${O}/sites-${SET}.jsonl`, out.join("\n") + "\n");

console.log(SET, out.length, "sites");
process.exit(0);
