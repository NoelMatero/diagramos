/**
 * A vite plugin that puts an entry hook in every function of a repository's own
 * source, so a vitest run can record which of its routines called which (#273).
 *
 * The Python half of this referee (`reach_trace.py`) needs no instrumentation:
 * `sys.setprofile` is a call hook the interpreter already has. Node has no
 * equivalent that reports an edge -- V8's CPU profiler samples, and on nestjs's
 * suite (276 files, 2,739 tests, 4 seconds of test time inside 19 of wall clock)
 * a 200us profile saw 123 distinct `file#name` frames, nearly all of them
 * anonymous module initialisation. So the hook is inserted instead.
 *
 * Two properties are deliberate:
 *
 * - **Nothing here decides who called whom.** The hook fires on entry and the
 *   runtime reads the real JS stack, which is what keeps this a referee: it
 *   shares no parse, no index and no naming rule with the reader. The ids handed
 *   to the hook exist so the runtime can throttle, never to name a routine.
 * - **Every insertion is line-preserving.** No inserted text contains a newline,
 *   so a line number in a stack trace still points where it did. A suite whose
 *   assertions read line numbers would otherwise start failing for a reason that
 *   has nothing to do with the code under test.
 *
 * TypeScript's own parser finds the functions. That is a second parser rather
 * than the reader's tree-sitter on purpose, and it is used only to find where a
 * body starts -- never to answer the question being refereed.
 */
import { createRequire } from "node:module";
import path from "node:path";

const require_ = createRequire(import.meta.url);
/** The repository's own pinned TypeScript, not whatever the corpus clone installed. */
const ts = require_(path.resolve(import.meta.dirname, "../../node_modules/typescript/lib/typescript.js"));

/**
 * Files that are not a repository's own source: a test is not something anybody
 * draws an arrow from. Written from scratch rather than imported from the
 * reader, which has its own copy of this judgement.
 */
export const NOT_SOURCE = /(^|\/)(__tests__|__mocks__|test|tests|testing|e2e|spec|docs|doc|examples?|samples?|benchmarks?|bench|fixtures|scripts|dist|build|node_modules)(\/|$)|\.(test|spec|bench|d)\.[cm]?[jt]sx?$/;

const SOURCE_EXTENSION = /\.([cm]?[jt]sx?)$/;

/** `id` is a vite module id: an absolute path, sometimes with a query on the end. */
export function repoSourceFile(id, root) {
  const clean = id.replace(/^file:\/\//, "").replace(/[?#].*$/, "");
  if (!SOURCE_EXTENSION.test(clean)) return undefined;
  if (!clean.startsWith(root + path.sep)) return undefined;
  const relative = clean.slice(root.length + 1);
  if (NOT_SOURCE.test(relative)) return undefined;
  return relative;
}

function scriptKindOf(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/.test(file)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

const IS_FUNCTION = (node) =>
  ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
  || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);

/**
 * Where a hook has to go in one file, and the declaration line of each function
 * it goes into.
 *
 * `functions` is returned so a caller can say how much of a file was
 * instrumented; the runtime never sees it.
 */
export function insertionsFor(source, file) {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindOf(file));
  const insertions = [];
  const functions = [];

  const visit = (node) => {
    if (IS_FUNCTION(node) && node.body) {
      const line = tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
      const index = functions.length;
      functions.push({ line });
      if (ts.isBlock(node.body)) {
        let at = node.body.getStart(tree) + 1;
        /*
         * `super(..)` has to stay the first statement of a derived class's
         * constructor: TypeScript refuses a statement in front of it whenever
         * the class has a parameter property or an initialised field, which is
         * most of them. The hook goes after it instead -- behind a semicolon of
         * its own, because a project written without them ends that statement by
         * newline and `super()globalThis.__reach` is a parse error. That cost 45
         * of vite's 67 suites, and the run reported zero failures while it
         * happened.
         */
        let lead = "";
        const first = node.body.statements[0];
        if (ts.isConstructorDeclaration(node) && first && ts.isExpressionStatement(first)
          && ts.isCallExpression(first.expression) && first.expression.expression.kind === ts.SyntaxKind.SuperKeyword) {
          at = first.end;
          lead = ";";
        }
        insertions.push({ at, text: `${lead}globalThis.__reach&&globalThis.__reach(__reachF,${index});` });
      } else {
        // A concise arrow body is an expression: `(hook(), expr)` keeps its value.
        insertions.push({ at: node.body.getStart(tree), text: `(globalThis.__reach&&globalThis.__reach(__reachF,${index}),` });
        insertions.push({ at: node.body.end, text: ")" });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(tree, visit);
  return { insertions, functions };
}

/**
 * The same source with a hook at the top of every function body, and the module
 * bracketed so the runtime can tell initialisation code from an anonymous
 * callback -- a distinction the stack does not carry and `reach_trace.py` gets
 * for free from `<module>`.
 */
export function instrument(source, file, relative) {
  if (source.startsWith("#!")) return undefined; // a shebang has to stay on line 1
  const { insertions, functions } = insertionsFor(source, file);
  if (functions.length === 0) return undefined;
  let out = source;
  for (const one of [...insertions].sort((a, b) => b.at - a.at)) {
    out = out.slice(0, one.at) + one.text + out.slice(one.at);
  }
  const key = JSON.stringify(relative);
  const lines = JSON.stringify(functions.map((one) => one.line));
  // The closing marker goes on a line of its own: a file whose last line is a
  // `//` comment and which ends without a newline would swallow it.
  return `const __reachF=globalThis.__reachFile?globalThis.__reachFile(${key},${lines}):-1;` + out
    + `\n;globalThis.__reachDone&&globalThis.__reachDone(${key});`;
}

/**
 * @param {{ root: string, skip?: string[] }} options `skip` holds paths relative
 * to the root that must not be instrumented. The recording runtime is copied
 * into the clone and is one of them: instrumenting it makes the hook call itself
 * and every one of vue's 183 files died with `Maximum call stack size exceeded`.
 */
export function reachTrace({ root, skip = [] }) {
  return {
    name: "reach-trace",
    // Before vite strips the types, so TypeScript's parser reads real TypeScript.
    enforce: "pre",
    transform(code, id) {
      const relative = repoSourceFile(id, root);
      if (!relative || skip.includes(relative)) return undefined;
      const instrumented = instrument(code, id.replace(/[?#].*$/, ""), relative);
      return instrumented === undefined ? undefined : { code: instrumented, map: null };
    },
  };
}
