/**
 * Names a language hands every file without the file saying so (#337 part C).
 *
 * `isinstance(x, int)` in Python, `Number(v)` in TypeScript, `Ok(())` in Rust.
 * None of them is a name the file forgot to import, and none of them can reach
 * a file in any repository -- so reporting them as "the file never says where
 * this came from" described a gap in the text that is not there, and left
 * bodies open that nothing was actually in doubt about. `is_stdlib_dataclass`
 * in pydantic makes exactly one call, `hasattr`, and that one name was the
 * whole of what stood between it and a verdict.
 *
 * ## Where these lists come from
 *
 * Not written by hand. Each is dumped from the language's own account of
 * itself, so there is no list-keeper to be wrong and the commands can be run
 * again when a toolchain moves:
 *
 *   ts / tsx / js  the globals of a bare ECMAScript realm, which is the
 *                  language and nothing the host added:
 *                    node -e "const vm = require('node:vm');
 *                      console.log(Object.getOwnPropertyNames(
 *                        vm.runInNewContext('globalThis')).sort().join('\n'))"
 *                  Deliberately *not* `globalThis` in Node, which also carries
 *                  `Request`, `Response`, `Headers`, `File`, `URL` and the
 *                  module names -- every one of which a repository really does
 *                  declare, and four of which are declared in this corpus.
 *
 *   python         python3 -c "import builtins; print('\n'.join(dir(builtins)))"
 *
 *   rust           the prelude and the exported macros, read out of the
 *                  toolchain's own source:
 *                    S=$(rustc --print sysroot)/lib/rustlib/src/rust/library
 *                    grep -hoE '^\s*pub use [^;]+;' \
 *                      $S/core/src/prelude/v1.rs $S/std/src/prelude/v1.rs
 *                    grep -rhoE '^\s*macro_rules! [a-z_]+' \
 *                      $S/core/src/macros/mod.rs $S/std/src/macros.rs \
 *                      $S/alloc/src/macros.rs
 *                  Macros belong in the same set because `calleeOf` reads a
 *                  `macro_invocation`'s name through its `macro` field exactly
 *                  as it reads a call's through `function`: `vec![1]` arrives
 *                  here as the bare name `vec`.
 *
 * ## The one hazard, and what it costs
 *
 * A repository can declare a name of its own that shadows one of these, and
 * then a call on that name means the repository's. The languages settle most
 * of it themselves: Python, Rust and ECMAScript modules all require a file to
 * declare or import a name before it can use one, and this is asked only where
 * the file does neither -- so a shadowing declaration somewhere else in the
 * repository cannot be what the call means.
 *
 * What the languages do not settle is a wildcard import, which brings in names
 * nothing can enumerate and could perfectly well bring in a `list` of its own.
 * `callsIn` refuses there, which is the rule `throughWildcards` already
 * applies one level up: follow only to an answer the text settles, and treat
 * anything else as the doubt it is.
 *
 * `scripts/measure-builtins.mts` is the referee. It scans all fifteen corpus
 * repositories with a text scan that shares no machinery with this reader and
 * reports every name in these lists that a repository declares for itself.
 */
import type { Language } from "./parse";

/** The globals of a bare ECMAScript realm -- the language, not the host. */
const ECMASCRIPT = [
  "AggregateError", "Array", "ArrayBuffer", "AsyncDisposableStack", "Atomics",
  "BigInt", "BigInt64Array", "BigUint64Array", "Boolean", "DataView", "Date",
  "DisposableStack", "Error", "EvalError", "FinalizationRegistry", "Float16Array",
  "Float32Array", "Float64Array", "Function", "Infinity", "Int16Array", "Int32Array",
  "Int8Array", "Intl", "Iterator", "JSON", "Map", "Math", "NaN", "Number", "Object",
  "Promise", "Proxy", "RangeError", "ReferenceError", "Reflect", "RegExp", "Set",
  "SharedArrayBuffer", "String", "SuppressedError", "Symbol", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet", "WebAssembly", "console",
  "decodeURI", "decodeURIComponent", "encodeURI", "encodeURIComponent", "escape",
  "eval", "globalThis", "isFinite", "isNaN", "parseFloat", "parseInt", "undefined",
  "unescape",
];

/** `dir(builtins)`, less the dunders. */
const PYTHON = [
  "ArithmeticError", "AssertionError", "AttributeError", "BaseException",
  "BaseExceptionGroup", "BlockingIOError", "BrokenPipeError", "BufferError",
  "BytesWarning", "ChildProcessError", "ConnectionAbortedError", "ConnectionError",
  "ConnectionRefusedError", "ConnectionResetError", "DeprecationWarning", "EOFError",
  "Ellipsis", "EncodingWarning", "EnvironmentError", "Exception", "ExceptionGroup",
  "False", "FileExistsError", "FileNotFoundError", "FloatingPointError",
  "FutureWarning", "GeneratorExit", "IOError", "ImportError", "ImportWarning",
  "IndentationError", "IndexError", "InterruptedError", "IsADirectoryError",
  "KeyError", "KeyboardInterrupt", "LookupError", "MemoryError",
  "ModuleNotFoundError", "NameError", "None", "NotADirectoryError", "NotImplemented",
  "NotImplementedError", "OSError", "OverflowError", "PendingDeprecationWarning",
  "PermissionError", "ProcessLookupError", "PythonFinalizationError",
  "RecursionError", "ReferenceError", "ResourceWarning", "RuntimeError",
  "RuntimeWarning", "StopAsyncIteration", "StopIteration", "SyntaxError",
  "SyntaxWarning", "SystemError", "SystemExit", "TabError", "TimeoutError", "True",
  "TypeError", "UnboundLocalError", "UnicodeDecodeError", "UnicodeEncodeError",
  "UnicodeError", "UnicodeTranslateError", "UnicodeWarning", "UserWarning",
  "ValueError", "Warning", "ZeroDivisionError", "abs", "aiter", "all", "anext",
  "any", "ascii", "bin", "bool", "breakpoint", "bytearray", "bytes", "callable",
  "chr", "classmethod", "compile", "complex", "copyright", "credits", "delattr",
  "dict", "dir", "divmod", "enumerate", "eval", "exec", "exit", "filter", "float",
  "format", "frozenset", "getattr", "globals", "hasattr", "hash", "help", "hex",
  "id", "input", "int", "isinstance", "issubclass", "iter", "len", "license", "list",
  "locals", "map", "max", "memoryview", "min", "next", "object", "oct", "open",
  "ord", "pow", "print", "property", "quit", "range", "repr", "reversed", "round",
  "set", "setattr", "slice", "sorted", "staticmethod", "str", "sum", "super",
  "tuple", "type", "vars", "zip",
];

/** The std prelude, plus the macros std exports -- one namespace to this reader. */
const RUST = [
  "align_of", "align_of_val", "AsMut", "AsRef", "assert", "assert_eq", "assert_ne",
  "AsyncFn", "AsyncFnMut", "AsyncFnOnce", "Box", "cfg", "cfg_accessible", "cfg_eval",
  "Clone", "column", "compile_error", "concat", "concat_bytes", "const_format_args",
  "Copy", "dbg", "Debug", "debug_assert", "debug_assert_eq", "debug_assert_ne",
  "Default", "define_opaque", "deref", "derive_const", "DoubleEndedIterator", "drop",
  "Drop", "env", "eprint", "eprintln", "Eq", "Err", "ExactSizeIterator", "Extend",
  "file", "Fn", "FnMut", "FnOnce", "format", "format_args", "format_args_nl", "From",
  "Hash", "include", "include_bytes", "include_str", "Into", "IntoIterator",
  "Iterator", "line", "log_syntax", "matches", "module_path", "None", "Ok", "Option",
  "option_env", "Ord", "panic", "PartialEq", "PartialOrd", "print", "println",
  "Result", "Send", "size_of", "size_of_val", "Sized", "Some", "String", "stringify",
  "Sync", "todo", "ToOwned", "ToString", "trace_macros", "type_ascribe",
  "unimplemented", "Unpin", "unreachable", "vec", "Vec", "write", "writeln",
];

/**
 * A total record, so a new language cannot quietly inherit somebody else's
 * built-ins -- which would be the worst shape this could fail in: a name
 * placed outside the repository on the strength of a list that is not about
 * that language at all.
 */
export const PROVIDED: Record<Language, ReadonlySet<string>> = {
  ts: new Set(ECMASCRIPT),
  tsx: new Set(ECMASCRIPT),
  js: new Set(ECMASCRIPT),
  python: new Set(PYTHON),
  rust: new Set(RUST),
};

/** Whether the language itself puts this name in every file's scope. */
export function providedByLanguage(name: string, language: Language): boolean {
  return PROVIDED[language].has(name);
}
