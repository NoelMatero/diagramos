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
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { PYRIGHT_VERSION } from "./licence-python";
import { isOutsideTree } from "./resolution-ts";

export { isOutsideTree };

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
  /**
   * `typeDeclarationAt`'s own question, with the declaration's line kept
   * rather than thrown away (#243).
   *
   * The measurement only ever needed a file -- item 17's WRONG/AGREED/REFUSED
   * columns compare file paths, never lines. The live concrete-guard question
   * (`isConcreteClassAt`, `scripts/lib/resolution-python-live.ts`) needs to
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
   * one already paid it. Call once per tree, before any real query, at a
   * position known to have a real answer; a caller that skips this still
   * gets correct answers, just at `WARMUP_RETRY_MS` cost on however many of
   * its first queries land before the binder catches up on its own.
   */
  warmUp(file: string, source: string, start: number): Promise<void>;
  close(): void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** How long any one request may take before this referee gives up on it. */
const REQUEST_TIMEOUT_MS = 20_000;

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
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`textDocument request ${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
    });
  }

  await send("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: { textDocument: { definition: {}, typeDefinition: {} } },
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

  return {
    // `typeAnchorFor` is the reason `end` matters here: `[start, end)` can
    // span an entire expression (a chain, `self.cache`), and only its last
    // token says what the whole thing evaluates to. `methodDeclarationAt`
    // takes no such range -- its caller already hands over the method
    // name's own exact position via `memberRangeAfter`.
    typeDeclarationAt: (file, source, start, end) => {
      const anchor = typeAnchorFor(source, start, end);
      return anchor ? ask("typeDefinition", file, source, anchor.start, STEADY_RETRY_MS) : Promise.resolve(undefined);
    },
    typeDeclarationLocationAt: (file, source, start, end) => {
      const anchor = typeAnchorFor(source, start, end);
      return anchor
        ? askLocation("typeDefinition", file, source, anchor.start, STEADY_RETRY_MS)
        : Promise.resolve(undefined);
    },
    methodDeclarationAt: (file, source, start) => ask("definition", file, source, start, STEADY_RETRY_MS),
    warmUp: (file, source, start) => ask("typeDefinition", file, source, start, WARMUP_RETRY_MS).then(() => {}),
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
