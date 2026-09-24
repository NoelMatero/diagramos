/**
 * The referee for "this value cannot be called" when a compiler is the reader
 * (#343).
 *
 * `parts.ts` now asks the TypeScript checker and pyright what a value's type
 * is and whether anything could call it. A referee that asked either of them
 * the same question would share the reader's machinery and could only agree,
 * which is the one thing `AGENTS.md`'s measurement gate forbids.
 *
 * So this one does not ask what the type is. It **writes the call** -- `name()`
 * on the line after the declaration, in a copy of the file -- and asks a
 * checker whether the program still type-checks:
 *
 *   TypeScript   the compiler's own diagnostics on the rewritten file, which
 *                is the call-resolution path (`resolveCallExpression`) and
 *                not the type API the reader reads: unions, `Function`, type
 *                parameters and `any` are the compiler's to get right, not a
 *                list of ours
 *   Python       mypy, which shares nothing with pyright at all, on a copy of
 *                the tree; the call is placed by CPython's own `ast`, not by
 *                the tree-sitter grammar the reader walks
 *
 * Three answers per declaration, and the third is not a guess:
 *
 *   lacks     the checker refuses the call: "not callable"
 *   has       the checker read the line and accepted the call -- or refused
 *             it only for its arguments, which is a call it could make
 *   unknown   the checker never read the line, the value is `any`, or the
 *             declaration has no line after it a call could go on
 *
 * A probe is only believed where the checker proves it read the line, because
 * both skip code: mypy does not check what it thinks is unreachable, and
 * silence there is not agreement.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import ts from "typescript";

import { mypyCommand } from "./resolution-python-mypy";

export type ProbeReading = "has" | "lacks" | "unknown";

/**
 * One declaration's answer: whether the call was refused, and whether the
 * declaration is a value at all -- a variable, a parameter, a property. A
 * value is never a type, which is `type`'s half of the same question.
 */
export interface ProbeAnswer {
  callable: ProbeReading;
  value: boolean;
  /** Which checker settled `callable`, where one did: the measurement reports the split. */
  by?: "typescript" | "mypy" | "pyright";
}

/** One declaration: a file, the 0-based line its name is on, and the name. */
export interface ProbeSite { file: string; line: number; name: string }

export const probeKey = (file: string, line: number, name: string): string => `${file}\t${line}\t${name}`;

/* --------------------------------------------------------------- TypeScript */

/** "This expression is not callable", and its `?.()` and possibly-nullish cousins. */
const NOT_CALLABLE = new Set([2349, 2721, 2722, 2723]);
/**
 * Refusals that prove the value *can* be called: the arguments are wrong, or
 * it is a class that wants `new` -- which `@calls` into a class accepts.
 */
const CALLABLE_BUT = new Set([2348, 2554, 2555, 2556, 2575, 2769, 2345]);

interface Insertion { at: number; text: string }

/** Where a call to this declaration can be written, and how it is spelled there. */
function insertionFor(
  node: ts.Identifier | ts.PrivateIdentifier, sourceFile: ts.SourceFile, index: number,
): Insertion | undefined {
  /*
   * A declaration file holds no statements, so a call written into one is
   * refused for being there rather than for what it calls. Its declarations
   * are left unjudged, and counted, rather than read off a diagnostic about
   * where the probe was put.
   */
  if (sourceFile.isDeclarationFile) return undefined;
  const name = node.text;
  const call = `\n;(${name})?.(); /*dgm-probe-${index}*/\n`;
  let declaration: ts.Node = node.parent;
  while (ts.isBindingElement(declaration) || ts.isObjectBindingPattern(declaration)
    || ts.isArrayBindingPattern(declaration)) {
    declaration = declaration.parent;
  }
  const blockStart = (body: ts.Node | undefined): number | undefined =>
    body && ts.isBlock(body) ? body.getStart(sourceFile) + 1 : undefined;

  if (ts.isVariableDeclaration(declaration)) {
    const list = declaration.parent;
    const holder = list?.parent;
    if (ts.isCatchClause(list)) {
      const at = blockStart(list.block);
      return at === undefined ? undefined : { at, text: call };
    }
    if (!holder) return undefined;
    if (ts.isVariableStatement(holder)) {
      const container = holder.parent;
      if (ts.isBlock(container) || ts.isSourceFile(container) || ts.isModuleBlock(container)
        || ts.isCaseClause(container) || ts.isDefaultClause(container)) {
        return { at: holder.getEnd(), text: call };
      }
      return undefined;
    }
    if (ts.isForOfStatement(holder) || ts.isForInStatement(holder) || ts.isForStatement(holder)) {
      const at = blockStart(holder.statement);
      return at === undefined ? undefined : { at, text: call };
    }
    return undefined;
  }
  if (ts.isParameter(declaration)) {
    const routine = declaration.parent;
    const at = ts.isFunctionLike(routine) ? blockStart((routine as { body?: ts.Node }).body) : undefined;
    return at === undefined ? undefined : { at, text: call };
  }
  // A `#private` field is only readable inside its class, which is where
  // this probe is written.
  if (ts.isPropertyDeclaration(declaration)
    && (ts.isIdentifier(declaration.name) || ts.isPrivateIdentifier(declaration.name))) {
    const owner = declaration.parent;
    if (!ts.isClassLike(owner)) return undefined;
    const ambient = ts.getCombinedModifierFlags(owner as ts.Declaration) & ts.ModifierFlags.Ambient;
    if (ambient) return undefined;
    const isStatic = ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static;
    const method = `\n${isStatic ? "static " : ""}__dgmProbe${index}() { this.${name}?.(); /*dgm-probe-${index}*/ }\n`;
    return { at: owner.getEnd() - 1, text: method };
  }
  /*
   * A member of a type has no statement to follow, and usually no name to
   * reach it by: `{ angle: number }` in a parameter or an alias. So the type
   * is written again, verbatim, in a function at the end of the file that
   * declares every type parameter in scope where it was written -- and the
   * property is read off that and called. A name the copy cannot see from
   * there (a type declared inside a function) is a diagnostic, and so an
   * `unknown`, never an answer.
   */
  if (sourceFile.fileName.match(/\.[mc]?jsx?$/)) return undefined;
  const wrap = (expression: string, from: ts.Node) => {
    const parameters: string[] = [];
    for (let up: ts.Node | undefined = from; up && !ts.isSourceFile(up); up = up.parent) {
      const declared = (up as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
      if (declared) parameters.unshift(...declared.map((one) => one.getText(sourceFile)));
    }
    const generic = parameters.length > 0 ? `<${parameters.join(", ")}>` : "";
    return {
      at: sourceFile.getEnd(),
      text: `\nfunction __dgmProbe${index}${generic}() { ;(${expression})?.(); /*dgm-probe-${index}*/ }\n`,
    };
  };
  const qualified = (named: ts.Node & { name: ts.Node }): string | undefined => {
    const parts = [named.name.getText(sourceFile)];
    for (let up = named.parent; !ts.isSourceFile(up); up = up.parent) {
      if (ts.isModuleBlock(up)) continue;
      if (!ts.isModuleDeclaration(up)) return undefined;
      parts.unshift(up.name.getText(sourceFile));
    }
    return parts.join(".");
  };
  const key = JSON.stringify(name);
  if (ts.isPropertySignature(declaration)) {
    const owner = declaration.parent;
    if (ts.isTypeLiteralNode(owner)) {
      return wrap(`(undefined as unknown as (${owner.getText(sourceFile)}))[${key}]`, owner);
    }
    if (ts.isInterfaceDeclaration(owner)) {
      const named = qualified(owner);
      if (!named) return undefined;
      const names = owner.typeParameters?.map((one) => one.name.text) ?? [];
      const applied = names.length > 0 ? `${named}<${names.join(", ")}>` : named;
      return wrap(`(undefined as unknown as ${applied})[${key}]`, owner);
    }
    return undefined;
  }
  if (ts.isEnumMember(declaration)) {
    const named = qualified(declaration.parent);
    return named ? wrap(`${named}[${key}]`, declaration.parent) : undefined;
  }
  return undefined;
}

/** The declaration name nodes on this line with this text. */
function declarationNamesOn(
  sourceFile: ts.SourceFile, line: number, name: string,
): (ts.Identifier | ts.PrivateIdentifier)[] {
  const found: (ts.Identifier | ts.PrivateIdentifier)[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === name
      && sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line === line
      && (node.parent as { name?: ts.Node }).name === node) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/**
 * Ask the TypeScript compiler to call every site, one program per config.
 *
 * `configFor` is the tree's own nearest `tsconfig.json`, so a probe resolves
 * its imports the way the project does; `checkJs` is forced on so a `.js`
 * file's probe is checked at all.
 */
export function probeCallsTs(sites: readonly ProbeSite[]): Map<string, ProbeAnswer> {
  const answers = new Map<string, ProbeAnswer>();
  const byFile = new Map<string, ProbeSite[]>();
  for (const site of sites) byFile.set(site.file, [...(byFile.get(site.file) ?? []), site]);

  const byConfig = new Map<string, string[]>();
  for (const file of byFile.keys()) {
    const config = ts.findConfigFile(path.dirname(file), ts.sys.fileExists) ?? "";
    byConfig.set(config, [...(byConfig.get(config) ?? []), file]);
  }

  let index = 0;
  for (const [config, files] of byConfig) {
    let options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, jsx: ts.JsxEmit.Preserve,
    };
    let roots: string[] = [];
    if (config) {
      const parsed = ts.getParsedCommandLineOfConfigFile(config, {}, {
        ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {},
      });
      if (parsed) { options = parsed.options; roots = parsed.fileNames; }
    }
    options = { ...options, allowJs: true, checkJs: true, noEmit: true, skipLibCheck: true };

    const rewritten = new Map<string, string>();
    const probes: { key: string; file: string; start: number; end: number }[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const kind = file.endsWith("x") ? ts.ScriptKind.TSX
        : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
      const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
      const insertions: (Insertion & { key: string })[] = [];
      for (const site of byFile.get(file)!) {
        const key = probeKey(site.file, site.line, site.name);
        const node = declarationNamesOn(tree, site.line, site.name)[0];
        const insertion = node ? insertionFor(node, tree, index) : undefined;
        if (!insertion) { answers.set(key, { callable: "unknown", value: false }); continue; }
        insertions.push({ ...insertion, key });
        index += 1;
      }
      insertions.sort((a, b) => a.at - b.at);
      let text = "";
      let cursor = 0;
      for (const insertion of insertions) {
        text += source.slice(cursor, insertion.at);
        const start = text.length;
        text += insertion.text;
        probes.push({ key: insertion.key, file, start, end: text.length });
        cursor = insertion.at;
      }
      text += source.slice(cursor);
      /*
       * `// @ts-nocheck` tells the compiler to report nothing in this file,
       * and a probe that hears nothing reads as a call accepted -- which is
       * how two generated excalidraw files first came back as 56 wrong lacks.
       * The pragma is spelled out of existence in the copy, same length.
       */
      rewritten.set(path.resolve(file), text.replace(/@ts-nocheck/g, "@ts-n0check"));
    }

    const host = ts.createCompilerHost(options, true);
    const original = host.getSourceFile.bind(host);
    host.getSourceFile = (fileName, language, onError, shouldCreate) => {
      const text = rewritten.get(path.resolve(fileName));
      return text !== undefined
        ? ts.createSourceFile(fileName, text, language, true)
        : original(fileName, language, onError, shouldCreate);
    };
    const program = ts.createProgram([...new Set([...roots, ...files])], options, host);
    const checker = program.getTypeChecker();
    for (const file of files) {
      const sourceFile = program.getSourceFile(file);
      if (!sourceFile) {
        for (const probe of probes.filter((one) => one.file === file)) {
          answers.set(probe.key, { callable: "unknown", value: true });
        }
        continue;
      }
      const diagnostics = program.getSemanticDiagnostics(sourceFile);
      for (const probe of probes.filter((one) => one.file === file)) {
        const inside = diagnostics.filter((one) =>
          one.start !== undefined && one.start >= probe.start && one.start < probe.end);
        const callable = readProbe(inside, sourceFile, probe, checker);
        answers.set(probe.key, { callable, value: true, ...(callable === "unknown" ? {} : { by: "typescript" as const }) });
      }
    }
  }
  return answers;
}

function readProbe(
  diagnostics: readonly ts.Diagnostic[],
  sourceFile: ts.SourceFile,
  probe: { start: number; end: number },
  checker: ts.TypeChecker,
): ProbeReading {
  if (diagnostics.some((one) => NOT_CALLABLE.has(one.code))) return "lacks";
  if (diagnostics.some((one) => !CALLABLE_BUT.has(one.code))) return "unknown";
  /*
   * Accepted, or refused only over its arguments. An `any` is accepted too,
   * and says nothing -- so the callee's own type is looked at, only to tell
   * that one case apart.
   */
  let callee: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (callee) return;
    if (node.getStart(sourceFile) >= probe.start && node.getEnd() <= probe.end
      && ts.isCallExpression(node)) { callee = node.expression; return; }
    if (node.getEnd() > probe.start && node.getStart(sourceFile) < probe.end) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!callee) return "unknown";
  const type = checker.getTypeAtLocation(callee);
  const members = type.isUnion() ? type.types : [type];
  return members.some((one) => one.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) ? "unknown" : "has";
}

/* ------------------------------------------------------------------- Python */

/** `0 + ''` refused, in mypy's words or pyright's: the line was checked. */
const SENTINEL = /Unsupported operand types for \+|Operator "\+" not supported/;

/**
 * Whether a revealed type is, or may be, `Any`: mypy accepts any call on one,
 * and that acceptance says nothing. Only the top level counts -- a
 * `list[Any]` is a list, and a list is never called.
 */
function mayBeAny(revealed: string): boolean {
  const type = /Revealed type is "(.*)"/.exec(revealed)?.[1] ?? "";
  const union = /^Union\[(.*)\]$/.exec(type)?.[1] ?? type;
  const members: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of union) {
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if ((character === "|" || character === ",") && depth === 0) { members.push(current.trim()); current = ""; continue; }
    current += character;
  }
  members.push(current.trim());
  return members.some((one) => /^(Any|Untyped)\b/.test(one) || one === "");
}

/**
 * Where CPython's own parser says a call to each site can go, and the source
 * with every call written in. Runs as a separate `python3` process so nothing
 * here touches the reader's tree-sitter grammar.
 *
 * The line written is `name(); reveal_type(name); 0 + ''`. The last is an
 * error every checker reports wherever it reports errors at all, and it is
 * the proof the line was checked: mypy skips what it thinks unreachable, and
 * pyright evaluates a `@no_type_check` routine -- revealing types in it --
 * while reporting nothing, which read as 28 calls accepted in pydantic's v1
 * metaclass. A line without that error is one nobody checked, and not an
 * answer.
 */
const PLACE_PROBES = String.raw`
import ast, json, sys
request = json.load(sys.stdin)
result = {}
for path, sites in request.items():
    try:
        source = open(path, encoding="utf-8").read()
        tree = ast.parse(source)
    except Exception:
        continue
    lines = source.split("\n")
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[child] = node
    wanted = {(line, name) for line, name in sites}
    def own_line(node):
        return lines[node.lineno - 1][:node.col_offset].strip() == ""
    def before_body(body):
        first = body[0]
        return (first.lineno - 1, first.col_offset) if own_line(first) else None
    placed = {}
    tail = []
    def place(line, name, where):
        if where is not None and (line, name) not in placed:
            placed[(line, name)] = where
    # A comprehension's own binding has no line after it: the call goes into
    # the element instead, which runs once per binding. One per element, so
    # every probe line names one site.
    wrapped = {}
    def wrap(line, name, comp):
        element = comp.key if isinstance(comp, ast.DictComp) else comp.elt
        if (line, name) in wrapped or any(one is element for one, _ in wrapped.values()):
            return
        wrapped[(line, name)] = (element, name)
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            key = (node.lineno - 1, node.id)
            if key not in wanted:
                continue
            up = parents.get(node)
            nested = None
            while up is not None and not isinstance(up, ast.stmt):
                if isinstance(up, ast.Lambda):
                    nested = "lambda"
                if nested is None and isinstance(up, ast.comprehension) and node in ast.walk(up.target):
                    nested = parents.get(up)
                up = parents.get(up)
            if nested == "lambda" or up is None:
                continue
            if nested is not None:
                wrap(*key, nested)
                continue
            if isinstance(up, (ast.For, ast.AsyncFor, ast.With, ast.AsyncWith)):
                place(*key, before_body(up.body))
            elif (isinstance(up, ast.AnnAssign) and up.value is None
                  and isinstance(parents.get(up), ast.ClassDef)):
                # Declared in a class body and never assigned there: the name
                # is unbound in the body, so the call goes through an
                # instance instead -- by key for a TypedDict.
                owner = parents.get(up)
                if isinstance(parents.get(owner), ast.Module) and key not in placed:
                    keyed = any(getattr(base, "id", getattr(base, "attr", None)) == "TypedDict"
                                for base in owner.bases)
                    member = "__dgm_x[" + repr(node.id) + "]" if keyed else "__dgm_x." + node.id
                    tail.append((key, owner.name, member))
                    placed[key] = None
            elif isinstance(up, (ast.Assign, ast.AnnAssign, ast.AugAssign)) and own_line(up):
                place(*key, (up.end_lineno, up.col_offset))
        elif isinstance(node, ast.arg):
            key = (node.lineno - 1, node.arg)
            routine = parents.get(parents.get(node))
            if key in wanted and isinstance(routine, (ast.FunctionDef, ast.AsyncFunctionDef)):
                place(*key, before_body(routine.body))
        elif isinstance(node, ast.ExceptHandler) and node.name:
            key = (node.lineno - 1, node.name)
            if key in wanted:
                place(*key, before_body(node.body))
    by_line = {}
    for (line, name), where in placed.items():
        if where is not None:
            by_line.setdefault(where[0], []).append((line, name, where[1]))
    # ast columns are UTF-8 byte offsets; the lines here are text.
    def column(line, byte):
        return len(lines[line].encode("utf-8")[:byte].decode("utf-8", "ignore"))
    edits = []
    starts_on = {}
    for (line, name), (element, _) in wrapped.items():
        first, last = element.lineno - 1, element.end_lineno - 1
        edits.append((last, column(last, element.end_col_offset), ")[-1]"))
        edits.append((first, column(first, element.col_offset), "(" + name + "(), reveal_type(" + name + "), 0 + '', "))
        starts_on.setdefault(first, []).append((line, name))
    for line, at, text in sorted(edits, key=lambda one: (one[0], one[1]), reverse=True):
        lines[line] = lines[line][:at] + text + lines[line][at:]
    out = []
    probes = []
    for index, text in enumerate(lines):
        for line, name in starts_on.get(index, []):
            if len(starts_on[index]) == 1:
                probes.append([line, name, len(out) + 1 + len(by_line.get(index, []))])
        for line, name, indent in by_line.get(index, []):
            probes.append([line, name, len(out) + 1])
            out.append(" " * indent + name + "(); reveal_type(" + name + "); 0 + ''  # dgm-probe")
        out.append(text)
    for line, name, indent in by_line.get(len(lines), []):
        probes.append([line, name, len(out) + 1])
        out.append(" " * indent + name + "(); reveal_type(" + name + "); 0 + ''  # dgm-probe")
    for index, ((line, name), owner, member) in enumerate(tail):
        out.append("def __dgm_probe_" + str(index) + "(__dgm_x: " + owner + ") -> None:")
        probes.append([line, name, len(out) + 1])
        out.append("    " + member + "(); reveal_type(" + member + "); 0 + ''  # dgm-probe")
    result[path] = {"source": "\n".join(out), "probes": probes}
json.dump(result, sys.stdout)
`;

/**
 * Ask mypy to call every site, in a copy of `tree`.
 *
 * `failure` is set, and every site left `unknown`, when mypy or python3 is
 * not on this machine -- which a caller prints rather than reads as zero.
 */
export function probeCallsPython(
  tree: string,
  sites: readonly ProbeSite[],
): { answers: Map<string, ProbeAnswer>; failure?: string; seconds: number } {
  const began = Date.now();
  const answers = new Map<string, ProbeAnswer>();
  for (const site of sites) answers.set(probeKey(site.file, site.line, site.name), { callable: "unknown", value: false });
  const runner = mypyCommand();
  if (!runner) return { answers, failure: "mypy is not on this machine", seconds: 0 };

  const request: Record<string, [number, string][]> = {};
  for (const site of sites) (request[site.file] ??= []).push([site.line, site.name]);
  const placed = spawnSync("python3", ["-c", PLACE_PROBES], {
    input: JSON.stringify(request), encoding: "utf8", maxBuffer: 1024 * 1024 * 1024,
  });
  if (placed.status !== 0) return { answers, failure: `python3: ${placed.stderr.slice(0, 200)}`, seconds: 0 };
  const rewritten = JSON.parse(placed.stdout) as Record<string, { source: string; probes: [number, string, number][] }>;

  const realTree = realpathSync(tree);
  const work = path.join(os.tmpdir(), "diagramos-call-probe", path.basename(realTree));
  const copy = path.join(work, "tree");
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  cpSync(realTree, copy, {
    recursive: true,
    filter: (source) => !/(^|\/)(\.git|\.mypy_cache|\.venv|venv|__pycache__|node_modules|\.tox)$/.test(source),
  });
  const inCopy = (file: string) => path.join(copy, path.relative(realTree, realpathSync(file)));
  const probedFiles: string[] = [];
  for (const [file, { source }] of Object.entries(rewritten)) {
    writeFileSync(inCopy(file), source);
    probedFiles.push(inCopy(file));
  }
  const check = (files: string[], batch: number) => {
    const list = path.join(work, `files-${batch}.txt`);
    writeFileSync(list, files.join("\n"));
    return spawnSync(runner.command, [
      ...runner.leading,
      "--check-untyped-defs", "--ignore-missing-imports", "--no-error-summary", "--hide-error-context",
      "--no-color-output", "--no-pretty", "--show-error-codes", "--follow-imports=silent", "--cache-dir", path.join(work, "cache"),
      `@${list}`,
    ], { cwd: copy, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, timeout: 3_600_000 });
  };
  let runs = [check(probedFiles, 0)];
  /*
   * mypy refuses a whole run when two files would be the same module --
   * poetry's test fixtures hold dozens of `setup.py` with no package above
   * them. Checked again in batches no two of which share a file name, which
   * is the only thing that collides.
   */
  if (runs[0]!.status === 2 && /Duplicate module named/.test(`${runs[0]!.stdout}${runs[0]!.stderr}`)) {
    const batches: string[][] = [];
    const seen = new Map<string, number>();
    for (const file of probedFiles) {
      const index = seen.get(path.basename(file)) ?? 0;
      seen.set(path.basename(file), index + 1);
      (batches[index] ??= []).push(file);
    }
    runs = batches.map((files, index) => check(files, index + 1));
  }
  const broken = runs.find((one) => (one.status ?? 0) > 1 || one.error);
  if (broken) {
    const said = `${broken.error?.message ?? ""} ${broken.stderr ?? ""} ${broken.stdout ?? ""}`.trim().split("\n").slice(-1)[0];
    return { answers, failure: `mypy: ${said.slice(0, 200)}`, seconds: (Date.now() - began) / 1000 };
  }
  const result = { stdout: runs.map((one) => one.stdout).join("\n"), stderr: runs.map((one) => one.stderr).join("\n") };

  /*
   * `pretty = true` in a project's own config -- Flask's -- puts a long path
   * and its message on two lines, and reading only one-line messages missed
   * every "not callable" there while still hearing the reveal: 145 calls read
   * as accepted. `--no-pretty` turns that off, and a message that still
   * starts on the next line is joined to its location.
   */
  const printed = `${result.stdout}\n${result.stderr}`.split("\n");
  const said = new Map<string, string[]>();
  for (let index = 0; index < printed.length; index += 1) {
    let line = printed[index]!;
    if (/^.*?:\d+: (error|note):\s*$/.test(line)) line = `${line} ${(printed[index + 1] ?? "").trim()}`;
    const match = /^(.*?):(\d+): (error|note): (.*)$/.exec(line);
    if (!match) continue;
    const key = `${path.resolve(copy, match[1]!)}:${match[2]}`;
    said.set(key, [...(said.get(key) ?? []), `${match[3]}: ${match[4]}`]);
  }
  for (const [file, { probes }] of Object.entries(rewritten)) {
    for (const [line, name, probeLine] of probes) {
      const messages = said.get(`${inCopy(file)}:${probeLine}`) ?? [];
      const checked = messages.some((one) => SENTINEL.test(one));
      const revealed = checked ? messages.find((one) => one.startsWith("note: Revealed type is")) : undefined;
      const refused = checked && messages.some((one) => /^error: .*not callable/.test(one));
      // Placed by `ast` as a binding -- an assignment, a loop target, a
      // parameter -- so a value, whatever mypy makes of the call.
      const callable = refused ? "lacks" : revealed && !mayBeAny(revealed) ? "has" : "unknown";
      answers.set(probeKey(file, line, name), { callable, value: true, ...(callable === "unknown" ? {} : { by: "mypy" as const }) });
    }
  }

  /*
   * mypy reads an unannotated function's result as `Any`, so `thing = make()`
   * is `Any` to it and most of an unannotated codebase goes unrefereed.
   * pyright infers the result, and its own command-line checker is asked the
   * same written-in call for what mypy left open. That shares pyright's
   * inference with the reader -- not the reader's reading of a type, which
   * is what this probe tests -- and every answer says which checker gave it.
   */
  const open = Object.entries(rewritten).filter(([file, { probes }]) =>
    probes.some(([line, name]) => answers.get(probeKey(file, line, name))?.callable === "unknown"));
  if (open.length > 0) {
    const listed = open.map(([file]) => inCopy(file));
    const checked = spawnSync("npx", [
      "--yes", "-p", "pyright@1.1.406", "pyright", "--outputjson", ...listed,
    ], { cwd: copy, encoding: "utf8", maxBuffer: 1024 * 1024 * 1024, timeout: 3_600_000 });
    let report: { generalDiagnostics?: { file: string; severity: string; message: string; range: { start: { line: number } } }[] } = {};
    try { report = JSON.parse(checked.stdout); } catch { /* pyright did not run: those stay unknown */ }
    const heard = new Map<string, { severity: string; message: string }[]>();
    for (const one of report.generalDiagnostics ?? []) {
      const key = `${path.resolve(one.file)}:${one.range.start.line + 1}`;
      heard.set(key, [...(heard.get(key) ?? []), one]);
    }
    for (const [file, { probes }] of open) {
      for (const [line, name, probeLine] of probes) {
        const key = probeKey(file, line, name);
        if (answers.get(key)?.callable !== "unknown") continue;
        const messages = heard.get(`${realpathSync(inCopy(file))}:${probeLine}`) ?? heard.get(`${inCopy(file)}:${probeLine}`) ?? [];
        const checked = messages.some((one) => one.severity === "error" && SENTINEL.test(one.message));
        const revealed = checked ? messages.find((one) => /^Type of ".*" is "/.test(one.message)) : undefined;
        const refused = checked && messages.some((one) => one.severity === "error"
          && /is not callable|cannot be called/.test(one.message));
        // `Unbound` is a name read where nothing has been assigned to it yet:
        // not a type, and so not an answer about calling one.
        const unknown = revealed && /is "(Unknown|Any|Unbound)"|\| Unknown\b|Unknown \||Unbound/.test(revealed.message);
        const callable = refused ? "lacks" : revealed && !unknown ? "has" : "unknown";
        if (callable !== "unknown") answers.set(key, { callable, value: true, by: "pyright" });
      }
    }
  }
  return { answers, seconds: (Date.now() - began) / 1000 };
}
