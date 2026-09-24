/**
 * The Python referee for #235: where pyright says a receiver's *type* is
 * declared, and where the *method actually called* is declared -- the two
 * questions `resolution-ts.ts`'s `typeAt().declaringFile` and
 * `symbolDeclarationAt` ask of `tsc`, asked of pyright instead.
 *
 * `resolution-python.ts` already answers a different question -- what a
 * receiver's type is *called* -- through `reveal_type`, a diagnostics-output
 * trick that never asks pyright anything resembling "go to definition."
 * Getting a *file* means running pyright as a language server
 * (`pyright-langserver --stdio`) and issuing real LSP requests. #235 checked
 * this against the running server before writing a line of client code
 * (rather than assuming it from pyright's own docs), and it surfaced a
 * distinction the issue that opened this file did not draw:
 *
 *   `textDocument/definition`, asked at a **receiver's own position**
 *   (`c` in `c.load()`), follows *that name* to wherever it was last bound --
 *   `c`'s own assignment, `c = Config()`. It never reaches `Config` at all.
 *   Asked at the **method's own position** (`load` in `c.load()`), it *does*
 *   reach the right place -- `Config.load`'s own `def` line -- because there
 *   the symbol at that exact position already is the method, not a variable
 *   one hop away from it.
 *
 *   `textDocument/typeDefinition`, asked at the receiver's own position, is
 *   the question `textDocument/definition` cannot answer there: it follows
 *   `c` to *its type's* declaration, `class Config` -- exactly
 *   `typeAt().declaringFile`'s question in `resolution-ts.ts`, and exactly
 *   what item 11-14 of `docs/claim-vocabulary.md` needed a real checker for
 *   in TypeScript.
 *
 * So this file wires both LSP methods, one per question, matching them to
 * the TypeScript pair by what they ask rather than by name:
 *
 *   `typeDeclarationAt`   -- `textDocument/typeDefinition` on the receiver --
 *                            `typeAt().declaringFile`'s counterpart.
 *   `methodDeclarationAt` -- `textDocument/definition` on the method name --
 *                            `symbolDeclarationAt`'s counterpart.
 *
 * Confirmed against a live server before any of this was written: pyright
 * advertises both `definitionProvider` and `typeDefinitionProvider` in its
 * `initialize` response, no didOpen is required for either -- pyright
 * indexes a workspace from `rootUri` on its own, and answers correctly
 * against on-disk file contents once its startup analysis finishes -- and a
 * position with no answer (whitespace, a keyword, an unanalysed file)
 * returns `null` rather than an error. An external symbol (`"x".upper()`,
 * resolving into pyright's own bundled `typeshed-fallback/stdlib`) resolves
 * to a real path outside both the tree and its `node_modules` equivalent
 * (Python has none), which `resolution-ts.ts`'s `isOutsideTree` already
 * classifies correctly by path alone -- reused here rather than duplicated.
 *
 * ## One server per tree, not per query
 *
 * The same reason `resolution-ts.ts` builds one `ts.Program` per package and
 * `resolution-python.ts` runs pyright once per tree for `reveal_type`:
 * pyright's own startup and workspace analysis dwarfs the cost of answering
 * many positions once it is warm. `createPyrightLspReferee` spawns the
 * server, waits once for its own `pyright/endProgress` notification (with a
 * timeout, in case a tree is large enough that "done" never quite arrives),
 * and answers every query after that over the same connection.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { LspDocumentSymbol } from "./lsp-symbols";
import { each, parseSource, type Node } from "./parse";
import type { ValueKind } from "./parts";
import { isOutsideTree } from "./referee-ts";

export { isOutsideTree };

/**
 * The pyright this project talks to, pinned.
 *
 * A referee that floats is a number that cannot be reproduced: pyright's
 * resolution improves, and a licence measured against "whatever npx fetched
 * today" is a claim about a day rather than about a reader.
 *
 * Declared here rather than in `scripts/lib/licence-python.ts`, where it used
 * to live, because the referee moved into the shipped tree at #337 and the
 * measurement harness may import from `src/` but not the other way round.
 */
export const PYRIGHT_VERSION = "1.1.406";

/**
 * The type a declaration line declares, or `undefined` when it declares none
 * (#258). Python's `declaredTypeOnLine` (`referee-rust-lsp.ts`), asked of
 * the line `textDocument/typeDefinition` pointed at.
 *
 * `isConcreteClassLine` (`referee-python.ts`) answers a narrower
 * question -- is this one-line header safe to accuse through -- and turns
 * everything it cannot read into `concrete: false`. That is the right answer
 * for an accusation and hides a second fact: an answer that declares no type is
 * a wrong *file*, not just an unsafe one. Found against mypy on graphify: where
 * pyright's type is `Unknown`, `typeDefinition` falls back to the receiver's
 * own assignment (`a = args[i]`), and where the anchor is a callee's name it
 * lands on the callee (`def out_path(...) -> Path:`). Both name a file in the
 * repository, and neither is where any type was declared.
 *
 * Reads a split header (`class Split(`) as the class it opens, unlike
 * `isConcreteClassLine`: the name is on the line, and whether this is a type
 * does not depend on its bases.
 */
export function pythonTypeDeclaredOnLine(
  lineText: string,
): { kind: "class" | "alias" | "newtype" | "typevar"; name: string } | undefined {
  const text = lineText.trim();
  const typing = String.raw`(?:typing\.|typing_extensions\.)?`;
  const klass = /^class\s+([A-Za-z_]\w*)/.exec(text);
  if (klass) return { kind: "class", name: klass[1]! };
  const statement = /^type\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*=/.exec(text);
  if (statement) return { kind: "alias", name: statement[1]! };
  const annotated = new RegExp(String.raw`^([A-Za-z_]\w*)\s*:\s*${typing}TypeAlias\s*=`).exec(text);
  if (annotated) return { kind: "alias", name: annotated[1]! };
  const newtype = new RegExp(String.raw`^([A-Za-z_]\w*)\s*=\s*${typing}NewType\s*\(`).exec(text);
  if (newtype) return { kind: "newtype", name: newtype[1]! };
  const typevar = new RegExp(String.raw`^([A-Za-z_]\w*)\s*=\s*${typing}(?:TypeVar|ParamSpec|TypeVarTuple)\s*\(`).exec(text);
  if (typevar) return { kind: "typevar", name: typevar[1]! };
  return undefined;
}

/**
 * What a `textDocument/typeDefinition` answer's line is, in three answers
 * rather than `pythonTypeDeclaredOnLine`'s two (#258).
 *
 * A module receiver (`extract_mod.extract(...)`) lands on the first line of
 * the module's own file -- a docstring, a comment, an import -- which declares
 * no type and is still the right answer, being the file a board points at.
 * Line 0 is read as that before the line's text is looked at, because a module
 * can open with anything. A class declared on the very first line is read as a
 * type first, which is the one case where the two overlap.
 */
export function pythonDeclarationKind(lineText: string, line: number): "type" | "module" | "not a type" {
  if (pythonTypeDeclaredOnLine(lineText) !== undefined) return "type";
  if (line === 0) return "module";
  return "not a type";
}

/** LSP `Location`, `LocationLink`, or the array either comes wrapped in -- whatever the server sends. */
type DefinitionResult =
  | null
  | undefined
  | { uri?: string; targetUri?: string; range?: LspRange; targetRange?: LspRange; targetSelectionRange?: LspRange }
  | Array<{ uri?: string; targetUri?: string; range?: LspRange; targetRange?: LspRange; targetSelectionRange?: LspRange }>;

interface LspRange { start: { line: number; character: number } }

/**
 * A declaration's file and the 0-based line its own range starts on --
 * #243's addition, over `firstFile`'s file-only answer. `firstFile` still
 * exists below, as this function's own file-only projection, so
 * `typeDeclarationAt`/`methodDeclarationAt` keep answering exactly what
 * they always have for the measurement (`measure-resolution.mts`) and its
 * tests, neither of which needs a line.
 */
function firstLocation(result: DefinitionResult): { file: string; line: number } | undefined {
  const first = Array.isArray(result) ? result[0] : result;
  const uri = first?.uri ?? first?.targetUri;
  if (!uri) return undefined;
  const range = first?.targetSelectionRange ?? first?.targetRange ?? first?.range;
  try { return { file: fileURLToPath(uri), line: range?.start.line ?? 0 }; } catch { return undefined; }
}

function firstFile(result: DefinitionResult): string | undefined {
  return firstLocation(result)?.file;
}

/** Byte offset -> LSP `{ line, character }`, both 0-based. */
function lineStartsOf(source: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function positionAt(source: string, offset: number): { line: number; character: number } {
  const starts = lineStartsOf(source);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= offset) low = mid; else high = mid - 1;
  }
  return { line: low, character: offset - starts[low]! };
}

/**
 * The method name's own byte range in `x.foo()` / `self.cache.foo()`, given
 * the receiver's already-known range and the method name `resolveReceiversIn`
 * already read. A mechanical scan of the text between the two, not a second
 * parse: skip whitespace, expect `.`, skip whitespace, expect the exact name.
 * `undefined` on any mismatch -- a shape this scan does not understand should
 * withhold a position rather than guess one, the same reason `call-scan.ts`
 * throws away anything it cannot place instead of half-placing it.
 */
export function memberRangeAfter(
  source: string,
  receiverEnd: number,
  method: string,
): { start: number; end: number } | undefined {
  let i = receiverEnd;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (source[i] !== ".") return undefined;
  i++;
  while (i < source.length && /\s/.test(source[i]!)) i++;
  if (source.slice(i, i + method.length) !== method) return undefined;
  return { start: i, end: i + method.length };
}

/**
 * Where within `[start, end)` to actually put the cursor for a
 * `typeDefinition` question about "the type of this whole expression" --
 * found the hard way, by a real disagreement `measure:resolution` printed
 * rather than by reasoning about the grammar first.
 *
 * LSP has no "ask about this exact node" request the way `resolution-ts.ts`'s
 * `checker.getTypeAtLocation(node)` does; every position-based request finds
 * the *smallest* node touching that position and answers about that. For a
 * plain name (`x` in `x.foo()`) `[start, end)` already bounds exactly one
 * token, so asking anywhere in it is asking about the right thing. It is not
 * for a "not-a-name" receiver `resolveReceiversIn` still hands over un-gated
 * (`self.cache`, or a whole chain like `self._market(...).expect(...)`) --
 * `start` there is the *first* token, `self`, and asking there answers a
 * different, smaller question: what `self` is, not what the receiver
 * expression evaluates to. On `infrarouter`'s own corpus this placed a
 * chained builder call's type at the *test file doing the chaining* rather
 * than the harness class actually returned, a wrong answer with a name
 * plausible enough to read as a real disagreement rather than a placement
 * bug -- until `expect`'s own position, asked instead of `self`'s, agreed
 * with the independent `methodDeclarationAt` answer exactly.
 *
 * The fix generalises: whatever this range evaluates to is decided by its
 * *last* operation, so the anchor is the last call's callee name (working
 * backward past one matching `(...)`) or, with no trailing call, the last
 * attribute name in the chain (`cache` in `self.cache`, not `self`).
 * Undefined -- withheld, not guessed at, `memberRangeAfter`'s own stance --
 * for a subscript (`x[i]`, where the element type is not this scan's to
 * name) or unbalanced brackets it cannot place confidently.
 */
export function typeAnchorFor(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  let i = end;
  if (i > start && (source[i - 1] === ")" || source[i - 1] === "]")) {
    const close = source[i - 1];
    const open = close === ")" ? "(" : "[";
    let depth = 0;
    let j = i - 1;
    for (; j >= start; j--) {
      if (source[j] === close) depth++;
      else if (source[j] === open) {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0 || j < start) return undefined; // unbalanced -- withhold.
    if (close === "]") return undefined; // a subscript's element type isn't this callee's name.
    i = j; // the matching opening `(`.
  }
  while (i > start && /\s/.test(source[i - 1]!)) i--;
  const idEnd = i;
  while (i > start && /[A-Za-z0-9_]/.test(source[i - 1]!)) i--;
  if (i === idEnd) return undefined; // nothing identifier-shaped immediately before it.
  return { start: i, end: idEnd };
}

export interface PyrightLspReferee {
  /** `textDocument/typeDefinition` at `[start, end)` -- where the *type* of that expression is declared. */
  typeDeclarationAt(file: string, source: string, start: number, end: number): Promise<string | undefined>;
  /** `textDocument/definition` at `[start, end)` -- where the symbol *at that exact position* is declared. */
  methodDeclarationAt(file: string, source: string, start: number, end: number): Promise<string | undefined>;
  /** `methodDeclarationAt`'s question with the declaration's line kept (#254). */
  methodDeclarationLocationAt(
    file: string, source: string, start: number, end: number,
  ): Promise<{ file: string; line: number } | undefined>;
  /**
   * `typeDeclarationAt`'s own question, with the declaration's line kept
   * rather than thrown away (#243).
   *
   * The measurement only ever needed a file -- item 17's WRONG/AGREED/REFUSED
   * columns compare file paths, never lines. The live concrete-guard question
   * (`isConcreteClassAt`, `src/engine/referee-python.ts`) needs to
   * read the actual `class Foo(Bases):` header the declaration points at,
   * and a file with more than one class in it has no other way to say which
   * one pyright meant.
   */
  typeDeclarationLocationAt(
    file: string, source: string, start: number, end: number,
  ): Promise<{ file: string; line: number } | undefined>;
  /**
   * Pays this referee's one warm-up cost -- pyright's own binder needs real
   * time before it answers a position it would otherwise get right, and
   * every other query is given a short retry budget on the assumption this
   * one already paid it. Call once per tree, before any real query.
   *
   * Takes *several* positions rather than one (#337). A caller rarely knows
   * which of its positions pyright can answer, and a position it can never
   * answer is indistinguishable from a binder that has not run -- so warming
   * up at a single unlucky position pays the whole 15.75-second ladder for
   * nothing. `warmUpAcross` sweeps them all before paying for a rung; pass as
   * many as are cheap, in the order the caller would ask them anyway.
   *
   * A caller that skips this still gets correct answers, just at
   * `WARMUP_RETRY_MS` cost on however many of its first queries land before
   * the binder catches up on its own.
   *
   * Once a sweep has had a real answer the binder has run, and every later
   * call returns at once (#351). A server held in a pool is warmed by each
   * batch of questions put to it, and a batch whose own positions all happen
   * to be unanswerable -- `sink.send()` on an untyped parameter -- used to pay
   * the whole ladder again on a server that was already bound.
   */
  warmUp(candidates: readonly WarmUpCandidate[]): Promise<void>;
  /**
   * How many `typeDefinition` answers this referee has withheld because the
   * line they pointed at declares no type (#259) -- the cost of that rule,
   * counted where it is paid so a measurement can print it rather than infer it
   * from a coverage figure moving.
   */
  withheldNoType(): number;
  /**
   * `textDocument/documentSymbol` -- what pyright says each name in a file
   * *is* (#297). `undefined` when it would not answer.
   */
  documentSymbols(file: string): Promise<LspDocumentSymbol[] | undefined>;
  /**
   * What the name declared at `start` is (#343): whether a value of its type
   * can be called, and whether the name is a type. `undefined`, or a half of
   * it `undefined`, wherever pyright cannot say. See `valueKindFrom`.
   */
  valueKindAt(file: string, source: string, start: number): Promise<ValueKind | undefined>;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** How long any one request may take before this referee gives up on it. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Wait for pyright's binder by asking several positions, not one (#337).
 *
 * Nothing tells a client when pyright has finished binding a workspace -- see
 * the note on `WARMUP_RETRY_MS` below -- so the only way to find out is to ask
 * something and see whether the answer is real. That makes "not bound yet" and
 * "no answer exists here" indistinguishable from a single position, and the
 * ladder resolves the ambiguity the expensive way: it assumes the former and
 * sleeps 15.75 seconds before concluding the latter.
 *
 * Asked at one position that happens to have no answer, that is the whole cost
 * with nothing to show for it. `encode-httpx/client-send` spent 16.0 seconds
 * in `warmUp` and then answered all 97 of its real questions in 247ms, because
 * `resolvePythonReceivers` warmed up at `queries[0]` -- whichever receiver the
 * board drew first -- and that one was unanswerable.
 *
 * Several positions tell the two apart. A bound server answers *something*
 * across a sweep, and a sweep is cheap: a position with no answer comes back
 * in single-figure milliseconds, so the whole sweep costs less than the first
 * rung. A rung is paid only when every candidate came back empty, which is the
 * case the ladder was written for.
 *
 * Worst case is unchanged -- a tree where nothing answers still pays the whole
 * ladder, once -- so this can only make a warm-up shorter, never longer.
 */
/** One position the warm-up sweep may ask about. */
export interface WarmUpCandidate { file: string; source: string; start: number }

/** How many positions a warm-up sweep asks about before paying for a rung. */
export const WARM_UP_CANDIDATES = 8;

export async function warmUpAcross<T>(
  candidates: readonly T[],
  /** Whether this position came back with a real answer. */
  ask: (candidate: T) => Promise<boolean>,
  retryMs: readonly number[],
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
): Promise<boolean> {
  if (candidates.length === 0) return false;
  for (let attempt = 0; ; attempt += 1) {
    for (const candidate of candidates) {
      if (await ask(candidate)) return true;
    }
    if (attempt >= retryMs.length) return false;
    await sleep(retryMs[attempt]!);
  }
}

export async function createPyrightLspReferee(root: string): Promise<PyrightLspReferee> {
  const child: ChildProcessWithoutNullStreams = spawn(
    "npx",
    ["--yes", "-p", `pyright@${PYRIGHT_VERSION}`, "pyright-langserver", "--stdio"],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );

  let buffer = Buffer.alloc(0);
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  /** Whether a warm-up sweep has had a real answer, so the binder has run. */
  let bound = false;

  child.on("error", (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  });
  child.on("exit", () => {
    closed = true;
    for (const { reject } of pending.values()) reject(new Error("pyright-langserver exited"));
    pending.clear();
  });

  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      buffer = buffer.subarray(bodyStart + length);
      let message: { id?: number; method?: string; result?: unknown; error?: unknown };
      try { message = JSON.parse(body); } catch { continue; }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)!;
        pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      }
    }
  });

  function send(method: string, params: unknown): Promise<unknown>;
  function send(method: string, params: unknown, notification: true): void;
  function send(method: string, params: unknown, notification = false): Promise<unknown> | void {
    if (closed) return notification ? undefined : Promise.reject(new Error("pyright-langserver already closed"));
    const id = notification ? undefined : nextId++;
    const payload = { jsonrpc: "2.0", method, params, ...(id !== undefined ? { id } : {}) };
    const body = JSON.stringify(payload);
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    if (id === undefined) return undefined;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      // `unref`, or a request that answered leaves its timeout pending and
      // Node declines to exit until it fires. The same bug the rust client's
      // `whenPrimed` had, and worth an entire minute there.
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`textDocument request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS).unref();
    });
  }

  await send("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: { textDocument: {
      definition: {}, typeDefinition: {}, hover: { contentFormat: ["plaintext"] },
      documentSymbol: { hierarchicalDocumentSymbolSupport: true },
    } },
    workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
  });
  send("initialized", {}, true);

  /*
   * No `didOpen` is sent -- confirmed live that pyright answers both LSP
   * methods against on-disk content with no document ever opened. The cost
   * of that: pyright never emits `pyright/beginProgress`/`endProgress` for a
   * workspace it was never told to watch a document in, so there is no
   * notification to wait on for "the tree is indexed." Confirmed live too:
   * the very first request right after `initialized` answers `null` even for
   * a position with a real answer (the binder has not run yet), and the same
   * request answers correctly once given time to run.
   *
   * Retrying with a long backoff is right for exactly one query per tree --
   * `warmUp`, below, called once before the real batch starts -- and wrong
   * for every query after that: a position with no real answer (a receiver
   * pyright genuinely cannot place) looks identical to "not warmed up yet,"
   * and a corpus-sized run found this the expensive way. The first cut of
   * this file gave every query the same long ladder; on `graphify` (22,449
   * receiver sites) throughput fell from ~14/s to ~3/s as the run went on,
   * because an increasing share of what remained was genuinely-unanswerable
   * positions each paying the full ~15.75s ladder rather than a fast `null`.
   * `warmUp` pays that cost once; `STEADY_RETRY_MS` gives every other query a
   * short one, on the same reasoning `resolution-python.ts`'s own doc uses
   * for running pyright once per tree rather than once per query -- the
   * expensive part is amortised, not repeated.
   */
  const WARMUP_RETRY_MS = [250, 500, 1000, 2000, 4000, 8000];
  const STEADY_RETRY_MS = [300, 800];

  async function askLocation(
    method: "typeDefinition" | "definition", file: string, source: string, start: number, retryMs: number[],
  ): Promise<{ file: string; line: number } | undefined> {
    if (closed) return undefined;
    const uri = pathToFileURL(file).toString();
    const position = positionAt(source, start);
    const params = { textDocument: { uri }, position };
    for (let attempt = 0; ; attempt++) {
      let result: DefinitionResult;
      try {
        result = (await send(`textDocument/${method}`, params)) as DefinitionResult;
      } catch {
        return undefined;
      }
      const declaring = firstLocation(result);
      if (declaring !== undefined) return declaring;
      if (attempt >= retryMs.length || closed) return undefined;
      await new Promise((resolve) => setTimeout(resolve, retryMs[attempt]));
    }
  }

  async function ask(
    method: "typeDefinition" | "definition", file: string, source: string, start: number, retryMs: number[],
  ): Promise<string | undefined> {
    return (await askLocation(method, file, source, start, retryMs))?.file;
  }

  const declarationLines = new Map<string, string[]>();
  const lineOf = (file: string, line: number): string => {
    let lines = declarationLines.get(file);
    if (lines === undefined) {
      try { lines = readFileSync(file, "utf8").split("\n"); } catch { lines = []; }
      declarationLines.set(file, lines);
    }
    return lines[line] ?? "";
  };
  let withheldNoType = 0;

  /*
   * #259. Where pyright's own type is `Unknown`, `typeDefinition` answers with
   * the receiver's bindings rather than `null` -- `a = args[i]`, a `for`
   * target, a parameter, a `with ... as`, a lambda parameter -- and where
   * `typeAnchorFor` anchors on a callee's name it answers with the callee's
   * `def`. Every one is a real location and none is a type's declaration: 6,249
   * of 7,104 in-repository answers on graphify and infrarouter (#258). A line
   * that declares no type is withheld, wherever it is. The top of a module is
   * kept: that is a module receiver's right answer.
   *
   * Only the first location is read, as `firstLocation` only ever returned the
   * first: a fallback's locations are all bindings, so a later one is no
   * better.
   */
  async function askTypeLocation(
    file: string, source: string, start: number, end: number,
  ): Promise<{ file: string; line: number } | undefined> {
    const anchor = typeAnchorFor(source, start, end);
    if (!anchor) return undefined;
    const location = await askLocation("typeDefinition", file, source, anchor.start, STEADY_RETRY_MS);
    if (!location) return undefined;
    if (pythonDeclarationKind(lineOf(location.file, location.line), location.line) !== "not a type") return location;
    withheldNoType += 1;
    return undefined;
  }

  /** Every location an answer names, as `firstLocation` reads the first. */
  async function askLocations(
    method: "typeDefinition" | "definition", file: string, source: string, start: number,
  ): Promise<{ file: string; line: number }[] | undefined> {
    if (closed) return undefined;
    const params = { textDocument: { uri: pathToFileURL(file).toString() }, position: positionAt(source, start) };
    for (const wait of [0, ...STEADY_RETRY_MS]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (closed) return undefined;
      let result: DefinitionResult;
      try {
        result = (await send(`textDocument/${method}`, params)) as DefinitionResult;
      } catch {
        return undefined;
      }
      const all = (Array.isArray(result) ? result : result ? [result] : []).flatMap((one) => {
        const found = firstLocation(one);
        return found ? [found] : [];
      });
      if (all.length > 0) return all;
    }
    return undefined;
  }

  const sourceOf = (file: string): string | undefined => {
    try { return readFileSync(file, "utf8"); } catch { return undefined; }
  };

  /** Every class `locations` names, or `undefined` if one of them is not a class. */
  function classesAt(locations: { file: string; line: number }[] | undefined) {
    if (!locations || locations.length === 0) return undefined;
    /*
     * pyright names a bundled stub and the module it describes side by side
     * -- `types.pyi`'s `class NoneType:` and `types.py`'s `NoneType =
     * type(None)`. The stub is the declaration a checker reads; the module
     * line is how the runtime spells it, and it declares no class.
     */
    const stubbed = locations.some((one) => one.file.endsWith(".pyi"));
    const read = stubbed
      ? locations.filter((one) => one.file.endsWith(".pyi") || !isOutsideTree(one.file, root))
      : locations;
    const classes = read.filter((one) => pythonTypeDeclaredOnLine(lineOf(one.file, one.line))?.kind === "class");
    return classes.length === read.length ? classes : undefined;
  }

  const calling = new Map<string, Promise<boolean | undefined>>();

  /**
   * Whether instances of the class declared at this line can be called: its
   * body or a base's defines `__call__`. `undefined` for a base pyright cannot
   * place, which leaves the whole answer open.
   */
  function definesCall(file: string, line: number, depth: number): Promise<boolean | undefined> {
    const key = `${file}:${line}`;
    let answer = calling.get(key);
    if (!answer) {
      answer = readCall(file, line, depth);
      calling.set(key, answer);
    }
    return answer;
  }

  async function readCall(file: string, line: number, depth: number): Promise<boolean | undefined> {
    if (depth > 12) return undefined;
    const source = sourceOf(file);
    const klass = source === undefined ? undefined : classOnLine(source, line);
    if (!source || !klass) return undefined;
    if (ownsCall(klass)) return true;
    const bases = basesOf(klass);
    if (!bases) return undefined;
    let answer: boolean | undefined = false;
    for (const base of bases) {
      const classes = classesAt(await askLocations("definition", file, source, base.startIndex));
      if (!classes) return undefined;
      for (const one of classes) {
        const inherited = await definesCall(one.file, one.line, depth + 1);
        if (inherited === true) return true;
        if (inherited === undefined) answer = undefined;
      }
    }
    return answer;
  }

  async function valueKindAt(file: string, source: string, start: number): Promise<ValueKind | undefined> {
    if (closed) return undefined;
    const position = positionAt(source, start);
    let hover: { contents?: string | { value?: string } } | null | undefined;
    for (const wait of [0, ...STEADY_RETRY_MS]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (closed) return undefined;
      try {
        hover = (await send("textDocument/hover", {
          textDocument: { uri: pathToFileURL(file).toString() }, position,
        })) as typeof hover;
      } catch {
        return undefined;
      }
      if (hover) break;
    }
    const text = typeof hover?.contents === "string" ? hover.contents : hover?.contents?.value;
    if (!text) return undefined;
    const seesEverything = hoverSeesEverything(source, start);
    return valueKindFrom(text, async (written) => {
      if (!seesEverything) return undefined;
      const classes = classesAt(await askLocations("typeDefinition", file, source, start));
      if (!classes) return undefined;
      /*
       * Every class the type points at has to be written in the type as
       * shown. An alias hides the rest: pydantic's `cls_: ModelOrDc` is a
       * `Type[Union[BaseModel, Dataclass]]` -- the classes themselves, which
       * are called to make one -- and `typeDefinition` names the two classes
       * with nothing to say it is them rather than one of them. Found by
       * `measure:parts`, as a red it would have put on a right arrow.
       */
      const words = new Set(written.match(/[A-Za-z_]\w*/g) ?? []);
      const named = classes.every((one) => {
        const name = pythonTypeDeclaredOnLine(lineOf(one.file, one.line))?.name ?? "";
        return words.has(name) || (name === "NoneType" && words.has("None"));
      });
      if (!named) return undefined;
      let answer: boolean | undefined = false;
      for (const one of classes) {
        const callable = await definesCall(one.file, one.line, 0);
        if (callable === true) return true;
        if (callable === undefined) answer = undefined;
      }
      return answer;
    });
  }

  return {
    valueKindAt,
    // `typeAnchorFor` is the reason `end` matters here: `[start, end)` can
    // span an entire expression (a chain, `self.cache`), and only its last
    // token says what the whole thing evaluates to. `methodDeclarationAt`
    // takes no such range -- its caller already hands over the method
    // name's own exact position via `memberRangeAfter`.
    typeDeclarationAt: async (file, source, start, end) => (await askTypeLocation(file, source, start, end))?.file,
    typeDeclarationLocationAt: askTypeLocation,
    methodDeclarationAt: (file, source, start) => ask("definition", file, source, start, STEADY_RETRY_MS),
    methodDeclarationLocationAt: (file, source, start) =>
      askLocation("definition", file, source, start, STEADY_RETRY_MS),
    /*
     * Each candidate asked with no ladder of its own (`[]`), so a sweep costs
     * what an unanswerable position costs -- single-figure milliseconds each.
     * The ladder lives in `warmUpAcross`, between sweeps, where a sleep buys
     * the binder time rather than re-asking a position that has no answer.
     */
    warmUp: async (candidates) => {
      if (bound) return;
      bound = await warmUpAcross(
        candidates.slice(0, WARM_UP_CANDIDATES),
        async (one) => (await askLocation("typeDefinition", one.file, one.source, one.start, [])) !== undefined,
        WARMUP_RETRY_MS,
      );
    },
    withheldNoType: () => withheldNoType,
    documentSymbols: async (file) => {
      for (const wait of [0, ...STEADY_RETRY_MS]) {
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
        if (closed) return undefined;
        try {
          const result = (await send("textDocument/documentSymbol", {
            textDocument: { uri: pathToFileURL(file).toString() },
          })) as LspDocumentSymbol[] | null;
          if (result) return result;
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
    close: () => {
      if (closed) return;
      closed = true;
      // No LSP shutdown handshake: `child.kill()` reaps the process
      // immediately after, so waiting on one more round trip buys nothing.
      child.stdin.end();
      child.kill();
    },
  };
}

/**
 * What pyright's hover says a name is, and so what may be asked next (#343).
 *
 * The hover opens with the kind of thing in brackets -- `(variable) ctx:
 * AppContext`, `(class) Plain`, `(function) def work(n)` -- which is pyright
 * saying whether the name is a value. A value is not a type; whether it can
 * be called is `instancesCall`'s question, about the class or classes its
 * type names.
 *
 * Two spellings of a type are not asked about, because the class
 * `typeDefinition` names for them is not the class of the value: `type[Foo]`
 * is the class object itself, which is called to make one, and a callable's
 * `(x) -> y` is a function. Both keep their doubt -- and so does a type that
 * hides either behind an alias, which `valueKindAt` catches by asking that
 * every class named be written in the type.
 */
export async function valueKindFrom(
  hover: string,
  instancesCall: (written: string) => Promise<boolean | undefined>,
): Promise<ValueKind | undefined> {
  const kind = /^\(([a-z ]+)\)/.exec(hover.trim())?.[1];
  if (kind === "class" || kind === "type alias" || kind === "type") return { type: true };
  if (kind === "function" || kind === "method") return { callable: true, type: false };
  if (kind !== "variable" && kind !== "constant" && kind !== "parameter") return undefined;
  // `Type[Foo]` is `typing`'s spelling of the same thing.
  if (/\b[Tt]ype\[|->/.test(hover)) return { type: false };
  /*
   * `typeDefinition` names a class for each member of a union it knows, and
   * nothing for one it does not -- so `Term | Unknown` would read as a `Term`
   * and nothing else. A member nobody knows keeps the whole value open.
   */
  const written = /^\([a-z ]+\)\s+[A-Za-z_]\w*\s*:\s*([^\n]*)/.exec(hover.trim())?.[1] ?? "";
  if (topLevelMembers(written).some((member) => member === "Unknown" || member === "Any")) return { type: false };
  return { callable: await instancesCall(written), type: false };
}

/** A written type's top-level union members: `A | B[C | D]` is `A` and `B[C | D]`. */
function topLevelMembers(text: string): string[] {
  const members: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of text) {
    if ("([{".includes(character)) depth += 1;
    if (")]}".includes(character)) depth -= 1;
    if (character === "|" && depth === 0) { members.push(current.trim()); current = ""; continue; }
    current += character;
  }
  members.push(current.trim());
  return members;
}

/**
 * Whether the type pyright shows at a declaration is every value the name
 * may hold, which is what "cannot be called" has to be true of (#343).
 *
 * pyright's hover is the value written *there*. Most of the time that is the
 * whole story -- every other assignment to a local is another declaration in
 * the same file, and `parts.ts` asks each. Two shapes it is not:
 *
 * - **An unannotated parameter.** pyright reads `hook=None` as a `None`; a
 *   caller passes the function. The default is not the type.
 * - **An unannotated class attribute.** `callback = None` in a class body is
 *   replaced by `self.callback = fn` in a method, which is no declaration of
 *   the name anybody here reads.
 *
 * A written annotation settles both, since it binds every assignment to it.
 */
function hoverSeesEverything(source: string, start: number): boolean {
  const name = /^[A-Za-z_]\w*/.exec(source.slice(start))?.[0];
  if (!name) return false;
  const after = source.slice(start + name.length).trimStart();
  if (after.startsWith(":") && !after.startsWith(":=")) return true;
  const tree = parseSource(source, "python");
  if (!tree) return false;
  /*
   * The innermost scope the name sits in: a routine is a declaration with
   * parameters, a class one with a body and none (`parts.ts`). A name *among*
   * a routine's parameters is a parameter; one in its body is a local.
   */
  let inner: { at: number; scope: "routine" | "class" | "parameter" } | undefined;
  each(tree.rootNode, (node) => {
    const body = node.childForFieldName("body");
    if (!body || !node.childForFieldName("name")) return;
    const parameters = node.childForFieldName("parameters");
    const inside = (part: Node) => start >= part.startIndex && start < part.startIndex + part.text.length;
    if (parameters && inside(parameters) && (!inner || parameters.startIndex > inner.at)) {
      inner = { at: parameters.startIndex, scope: "parameter" };
    } else if (inside(body) && (!inner || body.startIndex > inner.at)) {
      inner = { at: body.startIndex, scope: parameters ? "routine" : "class" };
    }
  });
  return inner?.scope !== "parameter" && inner?.scope !== "class";
}

/** The class whose name is on this 0-based line, as `typeDefinition` and `definition` name one. */
function classOnLine(source: string, line: number): Node | undefined {
  const tree = parseSource(source, "python");
  if (!tree) return undefined;
  const starts = lineStartsOf(source);
  const from = starts[line];
  const to = starts[line + 1] ?? source.length;
  if (from === undefined) return undefined;
  let found: Node | undefined;
  each(tree.rootNode, (node) => {
    if (found) return;
    const name = node.childForFieldName("name");
    // A class is a declaration with a body and no parameters (`parts.ts`).
    if (!name || !node.childForFieldName("body") || node.childForFieldName("parameters")) return;
    if (name.startIndex >= from && name.startIndex < to) found = node;
  });
  return found;
}

/** Whether a class body defines `__call__` itself: a method, or a name assigned one. */
function ownsCall(klass: Node): boolean {
  let owns = false;
  each(klass.childForFieldName("body")!, (node) => {
    if (owns) return;
    const named = node.childForFieldName("name") ?? node.childForFieldName("left");
    if (named?.text === "__call__") owns = true;
  });
  return owns;
}

/**
 * The name each base of a class is spelled by: `Base`, `abc.Base`'s `Base`,
 * `Mapping[str, int]`'s `Mapping`. A keyword argument (`metaclass=...`) is not
 * a base, and a metaclass's `__call__` is what calling the *class* runs, not an
 * instance. `undefined` when a base is spelled any other way -- a call, a
 * splat -- because a base nobody can place may define `__call__`.
 *
 * `Generic` and `Protocol` are left out by name, the one list here: typing
 * declares both as special forms rather than classes, so pyright names no
 * class for either, and neither gives an instance anything to call.
 */
function basesOf(klass: Node): Node[] | undefined {
  const list = klass.childForFieldName("superclasses");
  if (!list) return [];
  const bases: Node[] = [];
  for (let index = 0; index < list.childCount; index += 1) {
    const base = list.child(index);
    if (!base?.isNamed || base.text.startsWith("#")) continue;
    if (base.childForFieldName("name") && base.childForFieldName("value")) continue;
    let head: Node | null = base;
    while (head && head.childCount > 0) {
      head = head.childForFieldName("attribute") ?? head.childForFieldName("value");
    }
    if (!head) return undefined;
    if (head.text === "Generic" || head.text === "Protocol") continue;
    bases.push(head);
  }
  return bases;
}
