/**
 * The Rust referee for #246: where rust-analyzer says a receiver's *type* is
 * declared, and where the *method actually called* is declared -- the pair
 * `resolution-python-lsp.ts` asks of pyright and `resolution-ts.ts` asks of
 * `tsc`, asked of rust-analyzer instead.
 *
 * Same two questions, same two LSP methods:
 *
 *   `typeDeclarationAt`   -- `textDocument/typeDefinition` on the receiver --
 *                            `typeAt().declaringFile`'s counterpart.
 *   `methodDeclarationAt` -- `textDocument/definition` on the method name --
 *                            `symbolDeclarationAt`'s counterpart.
 *
 * #237 confirmed the handshake works and recommended `vscode-jsonrpc` for the
 * transport rather than hand-rolling `Content-Length` framing a third time.
 * That is taken; the rest of this file is adapted from the Python one rather
 * than copied, because rust-analyzer differs from pyright in ways that were
 * found by asking a live server, and in one case by disbelieving the first
 * answer it gave.
 *
 * ## Readiness is a fact the server states, not one to infer from its answers
 *
 * #237 reported one not-ready signal: a genuine LSP error, `-32801 content
 * modified`, while the workspace indexes. There are more. Polling a real
 * handshake from `initialized` to the first true answer showed `-32801` is only
 * ever the last and shortest of several stages:
 *
 *     -32603 file not found   the VFS has not loaded the file yet
 *     null                    the file is loaded, analysis has not run
 *     -32801 content modified  #237's error, just before the real answer
 *
 * A client retrying only on `-32801` -- which is what this issue's brief
 * described -- gives up during the earlier stages and records a refusal for a
 * receiver rust-analyzer answers correctly a second later.
 *
 * **The first cut of this file inferred readiness from the shape of the answer,
 * and the corpus proved it wrong.** The reasoning was that an unanswerable
 * position returns an empty array, which is distinct from all three not-ready
 * signals above -- so `[]` could be treated as final and returned fast, and
 * `resolution-python-lsp.ts`'s two-ladder retry would be unnecessary. Three
 * workspaces polled at 100ms intervals never once showed `[]` before the first
 * real answer, which looked like confirmation.
 *
 * It was three lucky samples. Running the measurement twice on the same two
 * trees gave 68.7% coverage and then 13.6%, and the same 50-site sample
 * disagreed 30 times in one run and once in the other. rust-analyzer *does*
 * answer `[]` while still indexing -- rarely, and in a window narrow enough
 * that polling misses it, but often enough to move a corpus number by a factor
 * of five. Every one of those was a false refusal on a receiver it resolves
 * correctly a second later.
 *
 * So readiness is not inferred here at all. rust-analyzer publishes it: with
 * `window.workDoneProgress` declared, it sends `$/progress` under the token
 * `rustAnalyzer/cachePriming` (titled `Indexing`), and its `end` is the moment
 * queries start answering. Measured across repeated runs, waiting for it makes
 * the first query correct every time: anyhow 3.3s (3.3/3.3/3.3 over three
 * runs), ripgrep 1.3s, `rust-test/orangutan_macro` 2.7s. `whenPrimed` waits for
 * it once per server and every query awaits it, which is what makes the number
 * this file produces reproducible rather than a function of machine load.
 *
 * After priming, `[]` genuinely does mean "no answer here" and is returned
 * immediately -- so the fast-refusal property the first cut wanted is kept, it
 * is just no longer load-bearing for correctness. `RETRY_MS` stays as a safety
 * net, because priming can run more than once (observed twice on ripgrep, whose
 * second round began after the first had ended).
 *
 * ## A Rust call receiver cannot be anchored the way Python's is
 *
 * See `rustTypeAnchorFor`. Python's `typeAnchorFor` steps back past a trailing
 * `(...)` to the callee's name and asks there; that works for pyright and
 * returns nothing at all for rust-analyzer on a path call (`Type::make()`,
 * `free_fn()`), which is the shape Rust writes constructors in.
 *
 * ## Distribution: only when rust-analyzer is already installed
 *
 * #237's recommendation and the user's, settled before #246 opened: no binary
 * fetcher. `createRustAnalyzerReferee` rejects when the binary is absent and
 * every caller here treats that as silence, the same stance `src/engine/
 * parse.ts` already takes for a missing tree-sitter grammar.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  StreamMessageReader, StreamMessageWriter, createMessageConnection,
  type MessageConnection,
} from "vscode-jsonrpc/node";

/**
 * Whether a declaration rust-analyzer named is outside the tree being measured.
 *
 * `resolution-ts.ts`'s own `isOutsideTree` answers this for TypeScript by path
 * alone -- `node_modules`, or anything `path.relative` puts above the root --
 * and its second half is right for Rust unchanged: the standard library lives
 * under `~/.rustup`, a crates.io dependency under `~/.cargo/registry`, and both
 * are above any tree's root.
 *
 * Its first half is not. Rust's equivalent of `node_modules` is `target/`, and
 * unlike `node_modules` it sits *inside* the tree: a build script's generated
 * output (`target/debug/build/<crate>-<hash>/out/*.rs`) is a real file at a
 * real in-tree path, and counting it as tree-local would file a generated
 * artefact as a declaring file the same way a hand-written module is. `target`
 * is the one name added here.
 */
/**
 * The type a declaration line declares -- its kind and its name -- or
 * `undefined` when the line does not declare a type at all.
 *
 * This exists because comparing *files* is the wrong instrument for Rust, and
 * that took a corpus reading to see. The safety check items 14 and 17 used --
 * where is the receiver's type declared, versus where is the method actually
 * called declared, and do those agree -- works for TypeScript and Python
 * because a class and its methods share a file there. Rust separates them
 * routinely and legally: `anyhow`'s `pub struct Error` is `src/lib.rs:390`,
 * `mod error;` is a different file, and every method on `Error` is in it. So a
 * file disagreement in Rust carries no information about correctness, and 29
 * of them read one by one turned out to be 29 pairs of correct answers.
 *
 * What does not split is the type's *identity*. `impl Error` in `error.rs` is
 * not a competing answer about something else; it is the same `Error`. So the
 * property worth checking is the name of the type `textDocument/typeDefinition`
 * actually landed on, which its own target line states.
 *
 * Reading that line is sound rather than a guess, and the corpus says so:
 * sampling 120 answered sites on `anyhow`, every single target line was a real
 * type declaration -- `struct`, `enum`, `union` or `trait`, never a `fn`, a
 * `let` or a module. rust-analyzer points `typeDefinition` at the type's own
 * name token (`targetSelectionRange`), so the line it names is the declaration
 * header, and the shapes are narrow: an optional visibility, the keyword, the
 * name, then generics, a tuple body, a supertrait list or a brace.
 *
 * `undefined` is itself a finding when it happens -- an answer that is not a
 * type declaration would mean the anchor resolved to something that is not a
 * type, which is exactly the class of placement bug item 17 found in Python by
 * hand. It is counted rather than skipped.
 */
export function declaredTypeOnLine(
  line: string,
): { kind: "struct" | "enum" | "union" | "trait" | "type"; name: string } | undefined {
  // Strip a leading attribute (`#[repr(transparent)] pub struct X`) and any
  // visibility modifier, including the parenthesised forms.
  const bare = line
    .replace(/^\s*(?:#\[[^\]]*\]\s*)*/, "")
    .replace(/^\s*pub\s*(?:\([^)]*\)\s*)?/, "")
    .trimStart();
  const match = /^(struct|enum|union|trait|type)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(bare);
  if (!match) return undefined;
  return { kind: match[1] as "struct" | "enum" | "union" | "trait" | "type", name: match[2]! };
}

export function isOutsideRustTree(declaringFile: string, tree: string): boolean {
  if (declaringFile.includes(`${path.sep}target${path.sep}`)) return true;
  const rel = path.relative(tree, declaringFile);
  return rel.startsWith("..") || path.isAbsolute(rel);
}

/** LSP `Location`, `LocationLink`, or the array either comes wrapped in. */
type DefinitionResult =
  | null
  | undefined
  | LocationLike
  | LocationLike[];

interface LocationLike {
  uri?: string; targetUri?: string;
  range?: LspRange; targetRange?: LspRange; targetSelectionRange?: LspRange;
}
interface LspRange { start: { line: number; character: number } }

function firstLocation(result: DefinitionResult): { file: string; line: number } | undefined {
  const first = Array.isArray(result) ? result[0] : result;
  const uri = first?.uri ?? first?.targetUri;
  if (!uri) return undefined;
  const range = first?.targetSelectionRange ?? first?.targetRange ?? first?.range;
  try { return { file: fileURLToPath(uri), line: range?.start.line ?? 0 }; } catch { return undefined; }
}

/** Byte offset -> LSP `{ line, character }`, both 0-based. */
function lineStartsOf(source: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): { line: number; character: number } {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= offset) low = mid; else high = mid - 1;
  }
  return { line: low, character: offset - starts[low]! };
}

/**
 * The method name's own byte range in `x.foo()` / `self.field.foo()`, given the
 * receiver's already-known range and the method name `resolveReceiversIn` read.
 *
 * Identical in shape to `resolution-python-lsp.ts`'s `memberRangeAfter` and
 * kept separate rather than imported: Rust's method access is spelled `.` like
 * Python's, but its *other* access operator is `::`, and `receiverOf` in
 * `src/engine/resolution.ts` drops `Type::method()` before it ever reaches
 * here. Sharing the Python function would make that a coincidence this file
 * depends on silently instead of a fact it states.
 */
export function rustMemberRangeAfter(
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
  // `.0`/`.1` tuple access, and a name that merely starts the same way
  // (`.loader` when the method is `load`) -- both would pass the slice test.
  const after = source[i + method.length];
  if (after !== undefined && /[A-Za-z0-9_]/.test(after)) return undefined;
  return { start: i, end: i + method.length };
}

/**
 * Where to put the cursor inside `[start, end)` to ask "what does this whole
 * receiver expression evaluate to."
 *
 * Same problem `typeAnchorFor` solves for Python -- LSP has no "ask about this
 * exact node" request, so a position finds the smallest node touching it, and
 * for anything but a bare name the first token asks a smaller question than the
 * one intended (`self` rather than `self.cfg`). Same conclusion, too: whatever
 * the expression evaluates to is decided by its *last* operation, so the anchor
 * is at the end of the range, not the start.
 *
 * Where it parts company with the Python version is the trailing `(...)`, and
 * this was measured rather than reasoned about. Python steps back past the call
 * to the callee's name and asks there; pyright answers with the return type's
 * declaration. rust-analyzer's answer depends on how the callee was spelled:
 *
 *     w.get().load()           anchored at `get`      -> the real declaration
 *     w.maybe().unwrap().load()  anchored at `unwrap`  -> the real declaration
 *     free_fn().load()         anchored at `free_fn`  -> nothing at all
 *     Holder::make().cfg       anchored at `make`     -> nothing at all
 *     Vec::<u32>::new().len()  anchored at `new`      -> nothing at all
 *
 * A *method* call answers; a *path* call -- `Type::assoc()`, a free function,
 * anything reached through `::` -- does not. Which is unfortunate, because
 * `Type::new()` is how Rust spells the constructor Python spells `Type()`. So
 * the trailing call is unwrapped only when a `.` precedes the callee, and a
 * path call is withheld rather than asked at a position already known to answer
 * nothing.
 *
 * `?` is withheld for a stronger reason than "no answer": it gives a *wrong*
 * one. `w.tryit()?.load()` anchored at `tryit` resolves to `core`'s `Result`,
 * the type before the `?` unwraps it, not the `Config` the method is actually
 * called on. A refusal is recoverable and a confident wrong file is not
 * (`docs/claim-vocabulary.md`'s whole argument), so the `?` is not stepped over.
 *
 * Withheld, never guessed at, for: a subscript (`x[i]`, whose element type is
 * not this scan's to name -- Python's rule unchanged), unbalanced brackets, a
 * trailing `?`, and a trailing path call.
 */
export function rustTypeAnchorFor(
  source: string,
  start: number,
  end: number,
): { start: number; end: number } | undefined {
  let i = end;
  while (i > start && /\s/.test(source[i - 1]!)) i--;

  // `x?` -- the type before the `?` is not the type the method is called on.
  if (i > start && source[i - 1] === "?") return undefined;

  if (i > start && (source[i - 1] === ")" || source[i - 1] === "]")) {
    const close = source[i - 1]!;
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
    if (close === "]") return undefined; // a subscript's element type isn't this scan's to name.
    i = j; // the matching opening `(`.
    // A turbofish belongs to the callee, not to the argument list: step over
    // `::<...>` so the identifier scan below reaches the name itself. It is
    // withheld a few lines later anyway -- `::` always precedes it -- but
    // reaching the name first is what makes that decision rather than an
    // accident of the scan stopping on `>`.
    while (i > start && /\s/.test(source[i - 1]!)) i--;
    if (i > start && source[i - 1] === ">") {
      let angle = 0;
      let k = i - 1;
      for (; k >= start; k--) {
        if (source[k] === ">") angle++;
        else if (source[k] === "<") {
          angle--;
          if (angle === 0) break;
        }
      }
      if (angle !== 0 || k < start) return undefined;
      i = k;
      while (i > start && /\s/.test(source[i - 1]!)) i--;
      if (i - 2 >= start && source.slice(i - 2, i) === "::") i -= 2;
    }
    while (i > start && /\s/.test(source[i - 1]!)) i--;
    const calleeEnd = i;
    let c = i;
    while (c > start && /[A-Za-z0-9_]/.test(source[c - 1]!)) c--;
    if (c === calleeEnd) return undefined; // nothing identifier-shaped before the call.
    // The one Rust-specific test: a method call (`.name(...)`) answers, a path
    // call (`::name(...)`, or a bare free function) does not.
    let before = c;
    while (before > start && /\s/.test(source[before - 1]!)) before--;
    if (before <= start || source[before - 1] !== ".") return undefined;
    return { start: c, end: calleeEnd };
  }

  const idEnd = i;
  while (i > start && /[A-Za-z0-9_]/.test(source[i - 1]!)) i--;
  if (i === idEnd) return undefined; // nothing identifier-shaped at the end.
  return { start: i, end: idEnd };
}

export interface RustLspReferee {
  /** `textDocument/typeDefinition` -- where the *type* of that expression is declared. */
  typeDeclarationAt(file: string, source: string, start: number, end: number): Promise<string | undefined>;
  /** `textDocument/definition` at `[start, end)` -- where the symbol *at that exact position* is declared. */
  methodDeclarationAt(file: string, source: string, start: number, end: number): Promise<string | undefined>;
  /** `typeDeclarationAt`'s question with the declaration's line kept. */
  typeDeclarationLocationAt(
    file: string, source: string, start: number, end: number,
  ): Promise<{ file: string; line: number } | undefined>;
  /**
   * Waits for rust-analyzer to finish priming its cache, which is when it
   * starts answering. Every query awaits this already, so calling it is
   * optional; it exists so a caller can pay the wait somewhere it can report
   * progress rather than inside whichever query happens to be first.
   *
   * Unlike the Python referee's `warmUp` this takes no position, because
   * readiness is not something this file asks a question to discover -- the
   * server says so. Resolves either way: on the priming notification, or on
   * `PRIME_TIMEOUT_MS` if the server never sends one, in which case
   * `primedCleanly()` answers false and a measurement can say so.
   */
  warmUp(): Promise<void>;
  /**
   * Whether the priming notification actually arrived, as against the wait
   * having timed out. A measurement whose numbers came from a server that never
   * said it was ready should report that rather than print the number plainly.
   */
  primedCleanly(): boolean;
  /** The server's own version string, for the record in a measurement. */
  version(): string;
  close(): void;
}

/** How long any one request may take before this referee gives up on it. */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * How long to wait for the priming notification before giving up on it and
 * asking anyway. Measured priming takes 1.3s-3.4s; this is not a budget for
 * that but a bound on a server that never reports at all (a manifest it cannot
 * parse, a workspace it declines to load), where stalling forever would be
 * worse than a marked-uncertain answer. Paid at most once per server.
 */
const PRIME_TIMEOUT_MS = 60_000;

/**
 * The not-ready ladder, a safety net rather than the mechanism. Priming is
 * awaited before any query, so this only catches the case where rust-analyzer
 * re-primes after having finished once -- observed on ripgrep, whose second
 * round began after the first had already ended.
 *
 * There is deliberately only one ladder, and this is where the Python referee's
 * shape is genuinely not needed rather than merely not copied. That file needs a
 * long warm-up ladder *and* a short steady-state one because pyright's
 * "not ready" and "no answer" are the same `null`, so it must guess which it
 * got; paying the long ladder on every genuinely-unanswerable position is what
 * cost it most of its throughput on a large tree. Here the server states its
 * own readiness, so after priming `[]` is taken at face value and this ladder
 * is never entered.
 */
const RETRY_MS = [100, 200, 400, 800, 1600, 3200, 4000, 5000];

/** rust-analyzer's own "ask me again" signals, all three of them. */
const NOT_READY_CODES = new Set([
  -32801, // ContentModified -- #237's, and the last of the three.
  -32603, // InternalError, "file not found": the VFS has not loaded it yet.
]);

function isNotReadyError(error: unknown): boolean {
  const code = (error as { code?: number } | undefined)?.code;
  return code !== undefined && NOT_READY_CODES.has(code);
}

export async function createRustAnalyzerReferee(root: string): Promise<RustLspReferee> {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("rust-analyzer", [], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    throw new Error(`rust-analyzer could not be started: ${(error as Error).message}`);
  }

  // `spawn` reports a missing binary asynchronously, so the `try` above catches
  // almost nothing on its own -- ENOENT arrives as an `error` event instead.
  const spawned = new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(
      new Error(`rust-analyzer is not on this machine: ${(error as Error).message}`)));
  });
  await spawned;

  let closed = false;
  const connection: MessageConnection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );
  // rust-analyzer's own stderr is its log, not a failure channel; a referee
  // that printed it would bury the measurement's output in indexing chatter.
  child.stderr.resume();
  connection.onError(() => { /* surfaced per-request instead */ });
  connection.onClose(() => { closed = true; });
  // rust-analyzer asks the client to register capabilities and create progress
  // tokens. Answering `null` is enough -- nothing here acts on either -- but
  // leaving them unanswered stalls its own startup.
  connection.onRequest(() => null);

  /*
   * The readiness gate. See this file's own doc for why this exists rather than
   * a rule about which answer shapes mean "ask again": inferring it from the
   * answers moved a corpus number by a factor of five between two identical
   * runs.
   */
  let primed = false;
  const primeWaiters: Array<() => void> = [];
  connection.onNotification("$/progress", (params: unknown) => {
    const progress = params as { token?: string; value?: { kind?: string } };
    if (progress?.token !== "rustAnalyzer/cachePriming") return;
    if (progress.value?.kind !== "end") return;
    primed = true;
    for (const resolve of primeWaiters.splice(0)) resolve();
  });
  connection.listen();

  const whenPrimed = (): Promise<void> => new Promise((resolve) => {
    if (primed || closed) return resolve();
    primeWaiters.push(resolve);
    setTimeout(resolve, PRIME_TIMEOUT_MS);
  });

  let serverVersion = "unknown";
  try {
    const init = await connection.sendRequest("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(root).toString(),
      capabilities: {
        textDocument: {
          definition: { linkSupport: true },
          typeDefinition: { linkSupport: true },
        },
        // Without this rust-analyzer sends no `$/progress` at all, and the
        // readiness gate above would wait out its whole timeout on every crate.
        window: { workDoneProgress: true },
      },
      workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }],
    }) as { serverInfo?: { name?: string; version?: string } };
    serverVersion = init?.serverInfo?.version ?? "unknown";
  } catch (error) {
    connection.dispose();
    child.kill();
    throw new Error(`rust-analyzer refused the initialize handshake: ${(error as Error).message}`);
  }
  connection.sendNotification("initialized", {});

  /*
   * No `didOpen` is sent, for the same reason the Python referee sends none:
   * confirmed live that rust-analyzer answers both LSP methods against on-disk
   * content with no document ever opened. Its cost there is having no progress
   * notification to wait on; here it costs nothing, because the not-ready
   * signals are explicit and every query already retries past them.
   */

  const lineStarts = new Map<string, number[]>();
  const startsFor = (file: string, source: string): number[] => {
    const cached = lineStarts.get(file);
    if (cached) return cached;
    const starts = lineStartsOf(source);
    lineStarts.set(file, starts);
    return starts;
  };

  async function askLocation(
    method: "typeDefinition" | "definition", file: string, source: string, at: number,
  ): Promise<{ file: string; line: number } | undefined> {
    if (closed) return undefined;
    // Never ask a server that has not said it is ready: an answer from before
    // priming can be an empty array for a receiver it resolves correctly a
    // second later, which is a false refusal and indistinguishable after the
    // fact from a real one.
    await whenPrimed();
    if (closed) return undefined;
    const params = {
      textDocument: { uri: pathToFileURL(file).toString() },
      position: positionAt(startsFor(file, source), at),
    };
    for (let attempt = 0; ; attempt++) {
      let result: DefinitionResult;
      try {
        const request = connection.sendRequest(`textDocument/${method}`, params);
        const timeout = new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`textDocument/${method} timed out`)), REQUEST_TIMEOUT_MS));
        result = (await Promise.race([request, timeout])) as DefinitionResult;
      } catch (error) {
        // Only a not-ready signal is worth asking again; anything else is a
        // real refusal and retrying it would spend the whole ladder to learn
        // what the first answer already said.
        if (!isNotReadyError(error) || attempt >= RETRY_MS.length || closed) return undefined;
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS[attempt]));
        continue;
      }
      const declaring = firstLocation(result);
      if (declaring !== undefined) return declaring;
      // Past the readiness gate, an empty array is a real "no answer here" and
      // is taken at face value. `null` still means analysis has not run for
      // this file -- possible after priming, since it can run a second round --
      // so that one is asked again.
      if (result !== null && result !== undefined) return undefined;
      if (attempt >= RETRY_MS.length || closed) return undefined;
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS[attempt]));
    }
  }

  const ask = async (
    method: "typeDefinition" | "definition", file: string, source: string, at: number,
  ): Promise<string | undefined> => (await askLocation(method, file, source, at))?.file;

  return {
    typeDeclarationAt: (file, source, start, end) => {
      const anchor = rustTypeAnchorFor(source, start, end);
      return anchor ? ask("typeDefinition", file, source, anchor.start) : Promise.resolve(undefined);
    },
    typeDeclarationLocationAt: (file, source, start, end) => {
      const anchor = rustTypeAnchorFor(source, start, end);
      return anchor
        ? askLocation("typeDefinition", file, source, anchor.start)
        : Promise.resolve(undefined);
    },
    methodDeclarationAt: (file, source, start) => ask("definition", file, source, start),
    warmUp: whenPrimed,
    primedCleanly: () => primed,
    version: () => serverVersion,
    close: () => {
      if (closed) return;
      closed = true;
      // No LSP shutdown handshake, the Python referee's own reasoning: the
      // process is killed immediately after, so one more round trip buys nothing.
      try { connection.dispose(); } catch { /* already gone */ }
      child.kill();
    },
  };
}
