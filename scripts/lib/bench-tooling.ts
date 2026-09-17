/**
 * The language tools #296's answer key is read from, behind one interface.
 *
 * rust-analyzer and pyright are asked over LSP; TypeScript is asked in process
 * through its own language service. Nothing here imports `src/engine` -- the
 * point of the answer key is that it shares no machinery with the checker it
 * scores, and `tests/bench-planted.test.ts` fails if that stops being true.
 *
 * Five questions, and every one returns `undefined` when the tool did not
 * answer, which callers must keep apart from an empty answer:
 *
 *   symbols(file)          every declaration in a file, with its kind and span
 *   definition(file, at)   where the name at an offset is declared
 *   outgoingCalls(sym)     the declarations a routine's body calls
 *   implementations(sym)   where a trait is implemented (Rust)
 *   importsOf(file)        the files a file's import statements resolve to
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import type { MessageConnection } from "vscode-jsonrpc/node";

import { PYRIGHT_VERSION } from "./licence-python";

export type Language = "rust" | "python" | "ts";

/** What a declaration is, as far as a claim cares. */
export type Kind = "routine" | "type" | "alias" | "data" | "impl" | "module" | "other";

export interface Sym {
  name: string;
  kind: Kind;
  /** The tool's own word for it, kept for the record. */
  detail: string;
  file: string;
  start: number;
  end: number;
  nameStart: number;
  /** The enclosing declaration's name, when there is one (a method's class or impl). */
  container?: string;
  containerKind?: Kind;
}

export interface Loc { file: string; start: number; end: number }

export interface Tooling {
  language: Language;
  root: string;
  symbols(file: string): Promise<Sym[] | undefined>;
  definition(file: string, at: number): Promise<Loc[] | undefined>;
  outgoingCalls(sym: Sym): Promise<Loc[] | undefined>;
  implementations(sym: Sym): Promise<Loc[] | undefined>;
  /** Resolved files for each import statement; `undefined` entries did not resolve. */
  importsOf(file: string): Promise<Array<{ text: string; file: string | undefined; mod?: boolean }> | undefined>;
  /** The tool's name and version, for the answer key's header. */
  version(): string;
  close(): void;
}

const sourceCache = new Map<string, string>();
export function sourceOf(file: string): string {
  let text = sourceCache.get(file);
  if (text === undefined) {
    try { text = readFileSync(file, "utf8"); } catch { text = ""; }
    sourceCache.set(file, text);
  }
  return text;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}
const startsCache = new Map<string, number[]>();
function startsOf(file: string): number[] {
  let starts = startsCache.get(file);
  if (!starts) { starts = lineStarts(sourceOf(file)); startsCache.set(file, starts); }
  return starts;
}

/*
 * LSP positions count UTF-16 code units, and so do JavaScript string offsets,
 * so a character offset is `line start + character` with no conversion.
 */
export function positionOf(file: string, at: number): { line: number; character: number } {
  const starts = startsOf(file);
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= at) lo = mid; else hi = mid - 1;
  }
  return { line: lo, character: at - starts[lo]! };
}
export function offsetOf(file: string, position: { line: number; character: number }): number {
  const starts = startsOf(file);
  return (starts[position.line] ?? sourceOf(file).length) + position.character;
}

interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }

function locFrom(uri: string, range: LspRange): Loc {
  const file = fileURLToPath(uri);
  return { file, start: offsetOf(file, range.start), end: offsetOf(file, range.end) };
}

/** LSP `SymbolKind` to the few kinds a claim distinguishes. */
function lspKind(kind: number, language: Language): Kind {
  switch (kind) {
    case 6: case 9: case 12: return "routine";
    case 5: case 10: case 11: case 23: return "type";
    case 26: return language === "rust" ? "alias" : "other";
    case 7: case 8: case 13: case 14: case 22: return "data";
    case 19: return language === "rust" ? "impl" : "other";
    case 2: case 3: case 4: return "module";
    default: return "other";
  }
}

const REQUEST_TIMEOUT_MS = 60_000;

async function lspTooling(language: "rust" | "python", root: string): Promise<Tooling> {
  const child: ChildProcessWithoutNullStreams = language === "rust"
    ? spawn("rust-analyzer", [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] })
    : spawn("npx", ["--yes", "-p", `pyright@${PYRIGHT_VERSION}`, "pyright-langserver", "--stdio"],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.stderr.resume();
  const { StreamMessageReader, StreamMessageWriter, createMessageConnection } = await import("vscode-jsonrpc/node");
  const connection: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  let closed = false;
  connection.onError(() => {});
  connection.onClose(() => { closed = true; });
  connection.onRequest(() => null);
  connection.onNotification(() => {});

  let primed = language !== "rust";
  const waiters: Array<() => void> = [];
  connection.onNotification("$/progress", (params: unknown) => {
    const p = params as { token?: string; value?: { kind?: string } };
    if (p?.token === "rustAnalyzer/cachePriming" && p.value?.kind === "end") {
      primed = true;
      for (const w of waiters.splice(0)) w();
    }
  });
  connection.listen();

  const init = await connection.sendRequest("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: {
      textDocument: {
        definition: { linkSupport: true },
        implementation: { linkSupport: true },
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        callHierarchy: {},
      },
      window: { workDoneProgress: true },
    },
    workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
    initializationOptions: language === "rust" ? { cargo: { buildScripts: { enable: true } }, procMacro: { enable: true } } : {},
  }) as { serverInfo?: { name?: string; version?: string } };
  const version = `${init?.serverInfo?.name ?? language} ${init?.serverInfo?.version ?? (language === "python" ? PYRIGHT_VERSION : "?")}`;
  connection.sendNotification("initialized", {});

  const whenPrimed = () => new Promise<void>((resolve) => {
    if (primed || closed) return resolve();
    waiters.push(resolve);
    setTimeout(resolve, 180_000).unref();
  });

  const opened = new Set<string>();
  const open = (file: string) => {
    if (opened.has(file)) return;
    opened.add(file);
    connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToFileURL(file).toString(),
        languageId: language === "rust" ? "rust" : "python",
        version: 1,
        text: sourceOf(file),
      },
    });
  };

  /*
   * Both servers answer "not yet" before they answer for real: rust-analyzer
   * with an error code or `null`, pyright with `null`. An empty array is taken
   * at face value; `null` and not-ready errors are asked again on a ladder.
   */
  const LADDER = [100, 250, 500, 1000, 2000, 4000, 8000];
  let warmed = false;
  async function request<T>(method: string, params: unknown, file: string): Promise<T | undefined> {
    if (closed) return undefined;
    await whenPrimed();
    open(file);
    const ladder = warmed ? LADDER.slice(0, 4) : LADDER;
    for (let attempt = 0; ; attempt++) {
      let result: unknown;
      try {
        const pending = connection.sendRequest(method, params);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), REQUEST_TIMEOUT_MS).unref());
        result = await Promise.race([pending, timeout]);
      } catch (error) {
        const code = (error as { code?: number }).code;
        if ((code === -32801 || code === -32603 || code === -32800) && attempt < ladder.length) {
          await new Promise((r) => setTimeout(r, ladder[attempt]));
          continue;
        }
        return undefined;
      }
      if (result === null || result === undefined) {
        if (attempt < ladder.length) {
          await new Promise((r) => setTimeout(r, ladder[attempt]));
          continue;
        }
        return undefined;
      }
      warmed = true;
      return result as T;
    }
  }

  type DocSymbol = { name: string; kind: number; range: LspRange; selectionRange: LspRange; children?: DocSymbol[]; detail?: string };
  const symbolCache = new Map<string, Sym[] | undefined>();

  async function symbols(file: string): Promise<Sym[] | undefined> {
    if (symbolCache.has(file)) return symbolCache.get(file);
    const result = await request<DocSymbol[]>("textDocument/documentSymbol",
      { textDocument: { uri: pathToFileURL(file).toString() } }, file);
    let out: Sym[] | undefined;
    if (result) {
      out = [];
      const walk = (list: DocSymbol[], container?: DocSymbol) => {
        for (const s of list) {
          let name = s.name;
          let kind = lspKind(s.kind, language);
          // rust-analyzer names an impl block `impl Trait for Type` / `impl Type`.
          if (language === "rust" && /^impl\b/.test(name)) kind = "impl";
          if (language === "python") name = name.replace(/^self\./, "");
          const containerKind = container
            ? (language === "rust" && /^impl\b/.test(container.name) ? "impl" : lspKind(container.kind, language))
            : undefined;
          out!.push({
            name,
            kind,
            detail: `${s.kind}${s.detail ? ` ${s.detail}` : ""}`,
            file,
            start: offsetOf(file, s.range.start),
            end: offsetOf(file, s.range.end),
            nameStart: offsetOf(file, s.selectionRange.start),
            ...(container ? { container: container.name, containerKind } : {}),
          });
          if (s.children) walk(s.children, s);
        }
      };
      walk(result);
    }
    symbolCache.set(file, out);
    return out;
  }

  type LocationLike = { uri?: string; range?: LspRange; targetUri?: string; targetSelectionRange?: LspRange; targetRange?: LspRange };
  const toLocs = (result: LocationLike | LocationLike[] | undefined): Loc[] | undefined => {
    if (result === undefined) return undefined;
    const list = Array.isArray(result) ? result : [result];
    return list.flatMap((l) => {
      const uri = l.targetUri ?? l.uri;
      const range = l.targetSelectionRange ?? l.range;
      if (!uri || !range || !uri.startsWith("file:")) return [];
      return [locFrom(uri, range)];
    });
  };

  async function definition(file: string, at: number): Promise<Loc[] | undefined> {
    const result = await request<LocationLike | LocationLike[]>("textDocument/definition", {
      textDocument: { uri: pathToFileURL(file).toString() },
      position: positionOf(file, at),
    }, file);
    return toLocs(result);
  }

  async function outgoingCalls(sym: Sym): Promise<Loc[] | undefined> {
    type Item = { uri: string; range: LspRange; selectionRange: LspRange; name: string };
    const items = await request<Item[]>("textDocument/prepareCallHierarchy", {
      textDocument: { uri: pathToFileURL(sym.file).toString() },
      position: positionOf(sym.file, sym.nameStart),
    }, sym.file);
    if (!items || items.length === 0) return undefined;
    const calls = await request<Array<{ to: Item }>>("callHierarchy/outgoingCalls", { item: items[0] }, sym.file);
    if (calls === undefined) return undefined;
    return calls.flatMap((c) => c.to.uri.startsWith("file:") ? [locFrom(c.to.uri, c.to.selectionRange)] : []);
  }

  async function implementations(sym: Sym): Promise<Loc[] | undefined> {
    const result = await request<LocationLike | LocationLike[]>("textDocument/implementation", {
      textDocument: { uri: pathToFileURL(sym.file).toString() },
      position: positionOf(sym.file, sym.nameStart),
    }, sym.file);
    if (result === undefined) return undefined;
    const list = Array.isArray(result) ? result : [result];
    // The whole impl block, not its selection: the header is what gets read.
    return list.flatMap((l) => {
      const uri = l.targetUri ?? l.uri;
      const range = l.targetRange ?? l.range;
      if (!uri || !range || !uri.startsWith("file:")) return [];
      return [locFrom(uri, range)];
    });
  }

  async function importsOf(file: string) {
    const text = sourceOf(file);
    const out: Array<{ text: string; file: string | undefined; mod?: boolean }> = [];
    const ask = async (label: string, at: number, mod?: boolean) => {
      if (!isLocalImport(language, label, root, file)) return;
      const found = await definition(file, at);
      const target = found?.find((l) => !isOutside(l.file, root));
      const outside = found !== undefined && found.length > 0 && !target;
      if (outside) return;
      out.push({ text: label, file: target?.file, ...(mod ? { mod } : {}) });
    };
    if (language === "python") {
      const stripped = blankPython(text);
      for (const m of stripped.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+\(?([^)\n]*(?:\n[^)\n]*)*?)\)?[ \t]*$/gm)) {
        const moduleText = m[1]!;
        const moduleAt = m.index! + m[0].indexOf(moduleText, m[0].indexOf("from") + 4);
        if (/\w/.test(moduleText)) {
          const lastDot = moduleText.lastIndexOf(".");
          await ask(moduleText, moduleAt + lastDot + 1);
        }
        // `from . import x` and `from pkg import submodule` name modules after `import`.
        const namesAt = m.index! + m[0].indexOf(m[2]!, m[0].indexOf(" import") + 7);
        for (const n of m[2]!.matchAll(/\b([A-Za-z_]\w*)\b(?:\s+as\s+\w+)?/g)) {
          const at = namesAt + n.index!;
          const found = await definition(file, at);
          const target = found?.find((l) => !isOutside(l.file, root));
          // A name imported from a module is a dependency on that module whether
          // it names a submodule or a symbol; only a submodule adds a file.
          if (target && (target.file.endsWith("__init__.py") || target.start === 0)) {
            out.push({ text: `${moduleText}.${n[1]}`, file: target.file });
          } else if (!/\w/.test(moduleText) || (target === undefined && isLocalImport("python", moduleText, root, file))) {
            out.push({ text: `${moduleText}${n[1]}`, file: target?.file });
          }
        }
      }
      for (const m of stripped.matchAll(/^[ \t]*import[ \t]+([\w.]+(?:[ \t]+as[ \t]+\w+)?(?:[ \t]*,[ \t]*[\w.]+(?:[ \t]+as[ \t]+\w+)?)*)/gm)) {
        const at0 = m.index! + m[0].indexOf(m[1]!);
        for (const n of m[1]!.matchAll(/([\w.]+)(?:[ \t]+as[ \t]+\w+)?/g)) {
          const lastDot = n[1]!.lastIndexOf(".");
          await ask(n[1]!, at0 + n.index! + lastDot + 1);
        }
      }
      return out;
    }
    // Rust: `use` trees, `mod x;` and inline `crate::`/`super::` paths.
    const stripped = blankRust(text);
    for (const m of stripped.matchAll(/\bmod[ \t]+([A-Za-z_]\w*)[ \t]*;/g)) {
      await ask(`mod ${m[1]}`, m.index! + m[0].indexOf(m[1]!), true);
    }
    for (const m of stripped.matchAll(/\buse\s+([^;]+);/g)) {
      const body = m[1]!;
      const base = m.index! + m[0].indexOf(body);
      const head = /^\s*(?:::)?([A-Za-z_]\w*)/.exec(body)?.[1] ?? "";
      for (const seg of body.matchAll(/([A-Za-z_]\w*)(?=\s*(?:[,}]|$|\s+as\b))/g)) {
        if (seg[1] === "self" || seg[1] === "as") continue;
        await ask(`${head}::..${seg[1]}`, base + seg.index!);
      }
    }
    for (const m of stripped.matchAll(/\b(?:crate|super)(?:::[A-Za-z_]\w*)+/g)) {
      const last = m[0].lastIndexOf("::") + 2;
      await ask(m[0], m.index! + last);
    }
    return out;
  }

  return {
    language,
    root,
    symbols,
    definition,
    outgoingCalls,
    implementations,
    importsOf,
    version: () => version,
    close: () => {
      if (closed) return;
      closed = true;
      try { connection.dispose(); } catch { /* gone */ }
      child.kill();
    },
  };
}

/**
 * Whether an import names this repository rather than a library. Only a local
 * import that fails to resolve is a doubt; `import h2` failing to resolve is a
 * package that is not installed, and says nothing about the files on a board.
 */
function isLocalImport(language: Language, label: string, root: string, file: string): boolean {
  if (language === "python") {
    if (label.startsWith(".")) return true;
    const head = label.split(".")[0]!;
    let dir = path.dirname(file);
    for (;;) {
      if (existsSync(path.join(dir, head)) || existsSync(path.join(dir, `${head}.py`))) return true;
      if (dir === root || dir === path.dirname(dir)) return false;
      dir = path.dirname(dir);
    }
  }
  if (language === "rust") {
    if (label.startsWith("mod ")) return true;
    const head = label.split("::")[0]!;
    if (["crate", "super", "self"].includes(head)) return true;
    // A bare first segment is local when this file or its crate root declares it as a module.
    const dir = path.dirname(file);
    return existsSync(path.join(dir, `${head}.rs`)) || existsSync(path.join(dir, head, "mod.rs"));
  }
  return true;
}

export function isOutside(file: string, root: string): boolean {
  const rel = path.relative(root, file);
  return rel.startsWith("..") || path.isAbsolute(rel)
    || /(^|\/)(node_modules|target|\.venv|site-packages|typeshed-fallback)\//.test(rel);
}

/** Blank comments and string bodies, keeping every offset. */
export function blankRust(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|r(#*)"[\s\S]*?"\1|b?"(?:[^"\\]|\\[\s\S])*"|b?'(?:[^'\\\n]|\\[^\n]{1,10})'/g,
    (s) => s.replace(/[^\n]/g, " "));
}
export function blankPython(text: string): string {
  return text.replace(/#[^\n]*|[rbfuRBFU]{0,2}("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')/g,
    (s) => s.replace(/[^\n]/g, " "));
}
export function blankTs(text: string): string {
  return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\[\s\S])*`/g,
    (s) => s.replace(/[^\n]/g, " "));
}

/* ------------------------------------------------------------------------ */
/* TypeScript, through its own language service.                            */
/* ------------------------------------------------------------------------ */

function nearestConfig(file: string, root: string): string | undefined {
  let dir = path.dirname(file);
  for (;;) {
    const candidate = path.join(dir, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (dir === root || dir === path.dirname(dir)) return undefined;
    dir = path.dirname(dir);
  }
}

function tsTooling(root: string): Tooling {
  const services = new Map<string, { service: ts.LanguageService; files: Set<string> }>();

  function serviceFor(file: string) {
    const config = nearestConfig(file, root) ?? "";
    let entry = services.get(config);
    if (!entry) {
      let options: ts.CompilerOptions = { allowJs: true, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true };
      let names: string[] = [];
      if (config) {
        const read = ts.readConfigFile(config, ts.sys.readFile);
        if (!read.error) {
          const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(config));
          options = { ...parsed.options, allowJs: true, skipLibCheck: true, noEmit: true };
          names = parsed.fileNames;
        }
      }
      const files = new Set(names);
      const host: ts.LanguageServiceHost = {
        getScriptFileNames: () => [...files],
        getScriptVersion: () => "1",
        getScriptSnapshot: (name) => {
          const text = ts.sys.readFile(name);
          return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
        },
        getCurrentDirectory: () => (config ? path.dirname(config) : root),
        getCompilationSettings: () => options,
        getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
        fileExists: ts.sys.fileExists,
        readFile: ts.sys.readFile,
        readDirectory: ts.sys.readDirectory,
        directoryExists: ts.sys.directoryExists,
        getDirectories: ts.sys.getDirectories,
      };
      entry = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), files };
      services.set(config, entry);
    }
    if (!entry.files.has(file)) entry.files.add(file);
    return entry;
  }

  const program = (file: string) => serviceFor(file).service.getProgram();

  function kindOf(node: ts.Node): Kind | undefined {
    if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node)
      || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isMethodSignature(node)) return "routine";
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isEnumDeclaration(node)) return "type";
    if (ts.isTypeAliasDeclaration(node)) return "alias";
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)
      || ts.isPropertyAssignment(node) || ts.isEnumMember(node)) {
      const init = (node as ts.VariableDeclaration).initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return "routine";
      if (init && ts.isCallExpression(init) && init.arguments.some((a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
        // `const X = forwardRef((props) => ...)`, `memo(...)`: a component.
        return "routine";
      }
      if (init && ts.isClassExpression(init)) return "type";
      return "data";
    }
    if (ts.isModuleDeclaration(node)) return "module";
    return undefined;
  }

  async function symbols(file: string): Promise<Sym[] | undefined> {
    const source = program(file)?.getSourceFile(file);
    if (!source) return undefined;
    const out: Sym[] = [];
    const visit = (node: ts.Node, container?: { name: string; kind: Kind }) => {
      const kind = kindOf(node);
      let next = container;
      if (kind) {
        const nameNode = ts.isConstructorDeclaration(node)
          ? node.getChildren(source).find((c) => c.kind === ts.SyntaxKind.ConstructorKeyword)
          : (node as ts.NamedDeclaration).name;
        const name = ts.isConstructorDeclaration(node) ? "constructor" : nameNode && (ts.isIdentifier(nameNode) || ts.isPrivateIdentifier(nameNode) || ts.isStringLiteral(nameNode)) ? nameNode.text : undefined;
        if (name !== undefined && nameNode) {
          const start = ts.isVariableDeclaration(node) ? node.parent.parent.getStart(source) : node.getStart(source);
          out.push({
            name, kind, detail: ts.SyntaxKind[node.kind], file,
            start, end: node.getEnd(), nameStart: nameNode.getStart(source),
            ...(container ? { container: container.name, containerKind: container.kind } : {}),
          });
          if (kind === "type" || kind === "alias") next = { name, kind };
        }
      }
      ts.forEachChild(node, (child) => visit(child, next));
    };
    visit(source);
    return out;
  }

  async function definition(file: string, at: number): Promise<Loc[] | undefined> {
    const { service } = serviceFor(file);
    const defs = service.getDefinitionAtPosition(file, at);
    if (defs === undefined) return [];
    return defs.map((d) => ({ file: d.fileName, start: d.textSpan.start, end: d.textSpan.start + d.textSpan.length }));
  }

  async function outgoingCalls(sym: Sym): Promise<Loc[] | undefined> {
    const { service } = serviceFor(sym.file);
    const items = service.prepareCallHierarchy(sym.file, sym.nameStart);
    const item = Array.isArray(items) ? items[0] : items;
    if (!item) return undefined;
    const calls = service.provideCallHierarchyOutgoingCalls(sym.file, item.selectionSpan.start);
    return calls.map((c) => ({ file: c.to.file, start: c.to.selectionSpan.start, end: c.to.selectionSpan.start + c.to.selectionSpan.length }));
  }

  async function importsOf(file: string) {
    const prog = program(file);
    const source = prog?.getSourceFile(file);
    if (!prog || !source) return undefined;
    const out: Array<{ text: string; file: string | undefined }> = [];
    const options = prog.getCompilerOptions();
    const specifiers: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        specifiers.push(node.arguments[0].text);
      } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
        specifiers.push(node.argument.literal.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const spec of specifiers) {
      const resolved = ts.resolveModuleName(spec, file, options, ts.sys).resolvedModule;
      const target = resolved?.resolvedFileName;
      if (target && isOutside(target, root)) continue;
      if (!target && !spec.startsWith(".")) continue; // a package that is not installed
      out.push({ text: spec, file: target });
    }
    return out;
  }

  return {
    language: "ts",
    root,
    symbols,
    definition,
    outgoingCalls,
    implementations: async () => undefined,
    importsOf,
    version: () => `typescript ${ts.version}`,
    close: () => { for (const { service } of services.values()) service.dispose(); },
  };
}

export async function createTooling(language: Language, root: string): Promise<Tooling> {
  if (language === "ts") return tsTooling(root);
  return lspTooling(language, root);
}

export function languageOfPath(file: string): Language | undefined {
  if (/\.rs$/.test(file)) return "rust";
  if (/\.py$/.test(file)) return "python";
  if (/\.(ts|tsx|mts|cts)$/.test(file) && !/\.d\.ts$/.test(file)) return "ts";
  return undefined;
}
