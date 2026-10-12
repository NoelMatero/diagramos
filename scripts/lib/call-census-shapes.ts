/**
 * The shape of a call the checker could not place, for `measure:call-census`
 * (#467).
 *
 * The checker's own reason (`receiver`, `unbound`, `computed`, ...) says which
 * branch of `placeOf` gave up. That is too coarse to tell one fix from
 * another: `unbound` holds a built-in read as a local, a host global, a name
 * from a wildcard import and a Rust enum variant, and each is a different
 * issue. So this reads the source around the call and names the shape, with
 * the labels of the #466 map (`~/bench-map-calls/classify.mts`), so the
 * census and the map can be read side by side. Layer 1's issues (#468-#471)
 * are written against these labels; `ISSUE_OF` says which issue each one
 * belongs to.
 *
 * Measure only. Nothing in `src/` reads this.
 */
import type { Language, Node as EngineNode } from "../../src/engine/parse";

/**
 * The engine's `Node` declares only what `src/` reads. web-tree-sitter's nodes
 * carry these too, and a measurement that walks up and sideways needs them.
 */
export interface Node extends EngineNode {
  parent: Node | null;
  namedChildCount: number;
  namedChild(index: number): Node | null;
  child(index: number): Node | null;
  childForFieldName(field: string): Node | null;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  descendantForIndex(start: number, end: number): Node | null;
}

export const FN = new Set([
  "function_declaration", "generator_function_declaration", "method_definition", "arrow_function",
  "function_expression", "function", "generator_function", "function_definition", "lambda", "function_item",
  "closure_expression", "function_signature_item",
]);
export const CLASSY = new Set([
  "class_declaration", "abstract_class_declaration", "class_definition", "class", "struct_item", "enum_item",
  "trait_item", "interface_declaration",
]);
const MEMBER = new Set(["member_expression", "attribute", "field_expression"]);

const TS_HOST = new Set(("setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate queueMicrotask "
  + "structuredClone fetch Response Request Headers URL URLSearchParams TextEncoder TextDecoder AbortController "
  + "AbortSignal Blob File FormData ReadableStream WritableStream TransformStream WebSocket Event EventTarget crypto "
  + "performance atob btoa process Buffer require module exports global globalThis window document navigator Worker "
  + "MessageChannel BroadcastChannel DOMException Bun Deno").split(" "));
const ES = new Set(("AggregateError Array ArrayBuffer BigInt Boolean DataView Date Error EvalError FinalizationRegistry "
  + "Function Intl JSON Map Math Number Object Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol "
  + "SyntaxError TypeError URIError WeakMap WeakRef WeakSet console decodeURI decodeURIComponent encodeURI "
  + "encodeURIComponent isFinite isNaN parseFloat parseInt").split(" "));
const PY = new Set(("abs aiter all anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile "
  + "complex delattr dict dir divmod enumerate eval exec filter float format frozenset getattr globals hasattr hash hex "
  + "id input int isinstance issubclass iter len list locals map max memoryview min next object oct open ord pow print "
  + "property range repr reversed round set setattr slice sorted staticmethod str sum super tuple type vars zip "
  + "BaseException Exception ValueError TypeError KeyError IndexError AttributeError RuntimeError StopIteration "
  + "StopAsyncIteration NotImplementedError OSError AssertionError ImportError LookupError ArithmeticError "
  + "ZeroDivisionError UnicodeDecodeError UnicodeEncodeError GeneratorExit KeyboardInterrupt SystemExit Warning "
  + "DeprecationWarning UserWarning RuntimeWarning NotImplemented Ellipsis").split(" "));
const RS = new Set("Ok Err Some None Box String Vec Default Option Result drop Into From ToString ToOwned Clone Iterator IntoIterator".split(" "));
const RS_STD_MACROS = new Set(("println print eprintln eprint writeln write format format_args vec assert assert_eq "
  + "assert_ne debug_assert debug_assert_eq debug_assert_ne panic unreachable unimplemented todo matches cfg dbg concat "
  + "stringify include_str include_bytes env option_env line column file module_path compile_error thread_local").split(" "));

/** Which layer-1 issue a shape belongs to, as #467's prediction table groups them. */
export const ISSUE_OF: Record<string, string> = {
  "built-in / prelude name misread": "#468",
  "a name from a wildcard import": "#468",
  "host global (setTimeout, fetch) misread": "#468",
  "a re-export it doesn't follow": "#468",
  "untyped value: Type::method": "#468",
  "a `$` name": "#468",
  "a #private method": "#468",
  "a name declared twice in the file": "#468",
  "a method on self the class doesn't declare": "#468",
  "a library import it doesn't place": "#469",
  "imported name not resolved": "#469",
  "imported value called": "#469",
  "untyped value — method name nowhere in the repo": "#469",
  "computed: generic call": "#470",
  "TS generic call after await read as an expression": "#470",
  "a method named call/apply": "#470",
  "a repo method named call read as dynamic": "#470",
  "a trait method named call (Service::call)": "#470",
  "inside a Rust macro": "#471",
  "a Rust macro it doesn't follow": "#471",
};

export function ancestors(n: Node): Node[] {
  const out: Node[] = [];
  for (let p = n.parent; p; p = p.parent) out.push(p);
  return out;
}

/** Identifiers a parameter list binds, skipping types and defaults. */
function bound(n: Node | null | undefined, out = new Set<string>()): Set<string> {
  if (!n) return out;
  if (["identifier", "shorthand_property_identifier_pattern", "self", "this"].includes(n.type)) { out.add(n.text); return out; }
  for (let i = 0; i < n.childCount; i++) {
    const f = n.fieldNameForChild(i);
    if (f === "type" || (f === "value" && n.type !== "pair_pattern") || f === "default_value" || f === "return_type") continue;
    const c = n.child(i);
    if (c && c.isNamed) bound(c, out);
  }
  return out;
}
function paramsOf(fn: Node): Set<string> {
  return bound(fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter"));
}

/** How `name` is declared directly in scope `s`, not descending into nested functions. */
function declaredIn(s: Node, name: string): { how: string; value?: string } | undefined {
  const body = FN.has(s.type) ? s.childForFieldName("body") ?? s : s;
  let found: { how: string; value?: string } | undefined;
  const escaped = name.replace(/[$]/g, "\\$");
  const visit = (n: Node): void => {
    for (let i = 0; i < n.namedChildCount && !found; i++) {
      const c = n.namedChild(i)!;
      const nm = c.childForFieldName("name");
      if ((FN.has(c.type) || CLASSY.has(c.type)) && nm?.text === name && c.type !== "arrow_function") {
        found = { how: CLASSY.has(c.type) ? "class" : "nested-function" };
        return;
      }
      if (["variable_declarator", "let_declaration", "assignment", "assignment_expression", "named_expression", "augmented_assignment"].includes(c.type)) {
        const left = c.childForFieldName("name") ?? c.childForFieldName("pattern") ?? c.childForFieldName("left");
        if (left && bound(left).has(name)) {
          const v = c.childForFieldName("value") ?? c.childForFieldName("right");
          found = { how: v && FN.has(v.type) ? "function-literal" : "assigned", value: v?.text.replace(/\s+/g, " ").slice(0, 60) };
          return;
        }
      }
      if (["for_statement", "for_in_statement", "for_expression", "for_in_clause", "for_of_statement"].includes(c.type)) {
        const left = c.childForFieldName("left") ?? c.childForFieldName("pattern");
        if (left && bound(left).has(name)) { found = { how: "loop" }; return; }
      }
      if (["match_arm", "let_condition", "if_let_expression", "while_let_expression"].includes(c.type)) {
        const pat = c.childForFieldName("pattern");
        if (pat && bound(pat).has(name)) { found = { how: "pattern" }; return; }
      }
      if (["with_item", "as_pattern", "except_clause", "catch_clause"].includes(c.type)
        && new RegExp(`\\bas\\s+${escaped}\\b|\\(\\s*${escaped}\\s*\\)`).test(c.text)) { found = { how: "with-or-except" }; return; }
      if (["import_statement", "import_from_statement", "use_declaration", "future_import_statement"].includes(c.type)
        && new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`).test(c.text)) { found = { how: "imported" }; return; }
      if (FN.has(c.type) || CLASSY.has(c.type)) continue;
      visit(c);
    }
  };
  visit(body);
  return found;
}

function labelLocal(d: { how: string }): string {
  switch (d.how) {
    case "loop": return "loop over functions";
    case "nested-function": case "function-literal": return "a function defined inside the routine";
    case "pattern": return "a Rust enum variant or pattern name";
    case "imported": return "imported value called";
    case "class": return "a class defined inside the routine";
    default: return "local holding a function";
  }
}

export interface ShapeInput {
  /** The checker's first-pass reason. */
  why: string;
  name: string;
  language: Language;
  /** The call node, when it was found again in the tree. */
  call: Node | undefined;
  /** The routine node the call is in. */
  routine: Node | undefined;
  root: Node;
  /** The whole file's text, for the wildcard test. */
  source: string;
  /** Whether any file in the tree declares a routine by this name. */
  declares: (name: string) => boolean;
}

/** The shape label for one call the checker did not place. */
export function shapeOf(input: ShapeInput): string {
  const { why, name, language: lang, call, routine: rn, root, source, declares } = input;
  if (why === "macro") return "inside a Rust macro";
  if (why === "elsewhere") return "a re-export it doesn't follow";
  if (why === "ambiguous") return "a name declared twice in the file";
  if (why === "unplaced") return "a library import it doesn't place";
  if (lang !== "python" && lang !== "rust" && name.includes("$")) return "a `$` name";
  if (name.startsWith("#")) return "a #private method";
  if (why === "dynamic") {
    if (["getattr", "setattr", "vars", "globals", "locals"].includes(name)) return "getattr / setattr";
    if (["eval", "exec", "__import__", "Function"].includes(name)) return "eval / exec / import by name";
    if (lang === "rust") return "a trait method named call (Service::call)";
    if (lang === "python") {
      const f = call?.childForFieldName("function");
      if (f && f.type === "identifier") return "local holding a function";
      return declares(name) ? "a repo method named call read as dynamic" : "a method named call/apply";
    }
    const f = call?.childForFieldName("function");
    const obj = f && MEMBER.has(f.type) ? f.childForFieldName("object") : undefined;
    if (obj && declares(name) && obj.type !== "identifier") return "a repo method named call read as dynamic";
    return "a method named call/apply";
  }
  if (why === "computed") {
    if (!call) return "computed call (unlocated)";
    const f = call.childForFieldName("function") ?? call.childForFieldName("constructor");
    if (!f) return "computed call (unlocated)";
    if (f.type === "super") return "super(...) constructor call";
    if (call.type === "new_expression") return "new on an expression";
    if (["subscript_expression", "subscript", "index_expression"].includes(f.type)) return "obj[k]() — a function looked up by key";
    if (f.type === "call_expression" || f.type === "call") return "a call's result called: f(x)(y)";
    if (f.type === "non_null_expression") {
      const inner = f.namedChild(0);
      return inner && MEMBER.has(inner.type) ? "a function stored in a field: (self.f)(x)" : "local holding a function";
    }
    if (f.type === "await_expression" || f.type === "instantiation_expression") return "TS generic call after await read as an expression";
    if (f.type === "import") return "dynamic import()";
    if (f.type === "parenthesized_expression") {
      const inner = f.namedChild(0);
      if (inner && FN.has(inner.type)) return "a function written and called on the spot";
      if (inner && MEMBER.has(inner.type)) return "a function stored in a field: (self.f)(x)";
      return "an expression called";
    }
    if (FN.has(f.type)) return "a function written and called on the spot";
    if (f.type === "generic_function") return "computed: generic call";
    return "an expression called";
  }
  if (why === "local-callee" || why === "unbound") {
    if (lang === "rust" && call?.type === "macro_invocation") {
      return RS_STD_MACROS.has(name) ? "built-in / prelude name misread" : "a Rust macro it doesn't follow";
    }
    if (lang === "rust" && RS.has(name)) return "built-in / prelude name misread";
    if (lang === "python" && PY.has(name)) return "built-in / prelude name misread";
    if (lang !== "python" && lang !== "rust" && ES.has(name)) return "built-in / prelude name misread";
    if (lang !== "python" && lang !== "rust" && TS_HOST.has(name)) return "host global (setTimeout, fetch) misread";
    const ups = call ? ancestors(call) : [];
    const stop = rn ? ups.findIndex((a) => a.id === rn.id) : -1;
    const inner = stop >= 0 ? ups.slice(0, stop).filter((a) => FN.has(a.type)) : [];
    for (const a of inner) if (paramsOf(a).has(name)) return "callback parameter";
    if (rn && FN.has(rn.type) && paramsOf(rn).has(name)) return "callback parameter";
    for (const a of inner) { const d = declaredIn(a, name); if (d) return labelLocal(d); }
    if (rn) { const d = declaredIn(rn, name); if (d) return labelLocal(d); }
    const outer = stop >= 0 ? ups.slice(stop + 1).filter((a) => FN.has(a.type)) : [];
    for (const a of outer) if (paramsOf(a).has(name) || declaredIn(a, name)) return "closure-captured name";
    const cls = ups.find((a) => CLASSY.has(a.type));
    if (cls) { const d = declaredIn(cls, name); if (d && d.how !== "nested-function") return "module-level value called"; }
    const top = declaredIn(root, name);
    if (top?.how === "imported") return why === "unbound" ? "imported name not resolved" : "imported value called";
    if (top) return "module-level value called";
    if (/from\s+\S+\s+import\s+\*|use\s+[\w:]+::\*|export\s+\*\s+from/.test(source)) return "a name from a wildcard import";
    if (lang === "rust" && /^[A-Z]/.test(name)) return "a Rust enum variant or pattern name";
    return "a name declared nowhere visible";
  }
  if (why === "receiver") {
    const f = call?.childForFieldName("function") ?? call?.childForFieldName("constructor");
    if (!call || !f) return "untyped value: unlocated";
    if (!MEMBER.has(f.type)) {
      if (f.type === "identifier" || f.type === "this" || f.type === "self") return "a method on self the class doesn't declare";
      if (f.type === "scoped_identifier") return "untyped value: Type::method";
      return `untyped value: ${f.type}`;
    }
    let obj = f.childForFieldName("object") ?? f.childForFieldName("value");
    while (obj && ["parenthesized_expression", "non_null_expression", "await_expression", "as_expression", "reference_expression", "try_expression"].includes(obj.type)) {
      obj = obj.namedChild(0);
    }
    if (obj && (["self", "this"].includes(obj.type) || ["self", "this", "cls"].includes(obj.text))) {
      return "a method on self the class doesn't declare";
    }
    if (!declares(name)) return "untyped value — method name nowhere in the repo";
    if (!obj) return "untyped value: other";
    if (MEMBER.has(obj.type)) {
      let r: Node | null = obj;
      while (r && MEMBER.has(r.type)) r = r.childForFieldName("object") ?? r.childForFieldName("value");
      if (r && (["self", "this"].includes(r.type) || ["self", "this", "cls"].includes(r.text))) return "untyped value: a field of unknown type";
      return "untyped value: an attribute chain of unknown type";
    }
    if (obj.type === "identifier") {
      for (const a of ancestors(call).filter((x) => FN.has(x.type))) {
        if (paramsOf(a).has(obj.text)) return "untyped value: a parameter of unknown type";
        if (declaredIn(a, obj.text)) return "untyped value: a local of unknown type";
      }
      return "untyped value: a module-level or imported value";
    }
    if (obj.type === "call_expression" || obj.type === "call") return "untyped value: the result of a call";
    if (["subscript_expression", "subscript", "index_expression"].includes(obj.type)) return "untyped value: an item taken from a collection";
    if (/string|template|array|list|dictionary|object|number|integer|literal/.test(obj.type)) return "untyped value: a literal's method";
    return "untyped value: other expression";
  }
  return why;
}
