/**
 * Local board server: a live window onto a .excalidraw file.
 *
 * The file stays the source of truth. This server watches it, pushes changes
 * to any open browser over SSE, and writes back what the browser draws. Claude
 * and the human therefore edit the same artifact without either one owning it,
 * and every tool keeps working unchanged when no browser is open at all.
 *
 * Conflicts resolve in the human's favour. A save carrying a stale revision is
 * refused with the current board attached; the browser merges its own edits
 * over the top and retries, so an agent write can never silently discard a
 * stroke the human just made.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readBoard, serializeBoard, writeBoard, type BoardFile } from "../engine/board-file";
import { BoardHistory, HISTORY_ROUTE } from "./history";
import { diagramDir } from "../engine/config";
import { checkDrift, createGitBaseline, createWorkspace, findBoards } from "../engine/drift";
import { initEngine } from "../engine/parse";
import { processAlive, registerServer, updateServer } from "./server-registry";
import { boardsPage } from "./boards-page";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * How often a server with an owner checks that the owner is still there.
 *
 * Two seconds is chosen against the cost of being wrong in each direction: a
 * server that lingers two seconds past its owner harms nobody, and polling this
 * cheaply (one signal-0, no allocation) is invisible next to serving a file.
 */
const OWNER_POLL_MS = 2000;

/**
 * How long a service runs with nothing looking at it before it stops itself.
 *
 * The service outlives the terminal and the session that started it, which is
 * the point -- but "outlives" has to end somewhere, or a project opened once on
 * a long-lived machine keeps a process forever. Twelve hours is chosen to be
 * longer than any working day and shorter than a weekend: a board you are using
 * is never idle, because an open page holds a live stream, and a board nobody
 * has looked at since yesterday is not one anybody is coming back to.
 *
 * Nothing is lost when it fires. A board is a file; the next `diagramos board`
 * has a service back in under a second.
 */
const DEFAULT_IDLE_HOURS = 12;
const IDLE_CHECK_MS = 60_000;
const VIEWER_DIR = path.join(ROOT, "out/viewer");

/**
 * The idle fuse, in milliseconds, from a DIAGRAMOS_IDLE_HOURS-style value.
 *
 * `0` disables it, for a service somebody means to keep. A value that is not a
 * number falls back to the default rather than failing: a typo here should cost
 * the fuse, not the ability to look at a diagram.
 */
export function resolveIdleMs(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_IDLE_HOURS * 3_600_000;
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_IDLE_HOURS * 3_600_000;
  return hours * 3_600_000;
}

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Where the board listens unless DIAGRAMOS_PORT says otherwise. */
export const DEFAULT_BOARD_PORT = 4747;

/**
 * The port to serve on, from a DIAGRAMOS_PORT-style value.
 *
 * A bad value is refused rather than coerced. `Number("abc")` is NaN, which is
 * not nullish, so it survives every `?? default` on the way down and reaches
 * `listen` -- and a NaN port makes probeBoardServer report "no board running"
 * when the truth is "your configuration is broken". Falling back to the default
 * would hide the typo just as effectively; the only useful answer is to say so.
 */
export function resolveBoardPort(raw: string | undefined): number {
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_BOARD_PORT;
  const port = Number(trimmed);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`DIAGRAMOS_PORT is "${raw}", which is not a port number between 1 and 65535.`);
  }
  return port;
}

export function revisionOf(board: BoardFile): string {
  return createHash("sha1").update(serializeBoard(board)).digest("hex").slice(0, 16);
}

interface Subscriber {
  response: ServerResponse;
  id: number;
}

export interface BoardServerOptions {
  file: string;
  port?: number;
  host?: string;
  /**
   * Paths accepted by POST /api/file must live under this directory. Without
   * it the takeover endpoint would let any local caller point the board at an
   * arbitrary file on disk.
   */
  root?: string;
  /**
   * The process this server belongs to. When it is given, the server checks
   * whether that process is still alive and shuts down when it is not.
   *
   * This is what stops a spawned server from outliving whoever spawned it. A
   * child is not killed when its parent dies -- it is reparented and keeps
   * running -- which is how nine board servers came to be found here, the oldest
   * five days old, four of them serving test directories that no longer existed.
   *
   * Left unset for a server that is *meant* to outlive its starter: the shared
   * one a session opens for the user, whose whole point is that the board is
   * still there when the session is gone. That one is stopped by asking, with
   * `diagramos stop`, not by dying quietly.
   */
  ownerPid?: number;
  /** Recorded in the registry so a listing can say where a server came from. */
  startedBy?: string;
  /**
   * Stop after this long with no open page and no request. Zero never stops.
   * Defaults to DIAGRAMOS_IDLE_HOURS, and to twelve hours without that.
   */
  idleMs?: number;
}

export interface RunningBoardServer {
  /** The follow view: shows whichever board is current, and follows setFile. */
  url: string;
  port: number;
  /** The board the follow view is showing. Changes via setFile. */
  readonly file: string;
  /**
   * Points the follow view at a different board. Done in place rather than by
   * restarting, so open pages keep their connection and simply follow along.
   * Pages pinned to a specific board with `?file=` are deliberately unaffected.
   */
  setFile(next: string): Promise<void>;
  /**
   * A URL pinned to one board. Two of these opened side by side stay on their
   * own file no matter what any tool writes, which is the point of them.
   */
  urlFor(file: string): string;
  /** Boards this server has been asked for, current one first. */
  boards(): string[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage, limitBytes = 32 * 1024 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    total += (chunk as Buffer).byteLength;
    if (total > limitBytes) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

/**
 * Whether a request came from something other than a page of ours.
 *
 * A browser will send a simple cross-origin POST to 127.0.0.1 without asking
 * anyone's permission, so any web page open in the user's browser can reach an
 * endpoint here. Requiring a header a simple request cannot carry forces a
 * preflight, and we answer no preflight, so a cross-origin call never arrives at
 * all. Our own page and our own tools send it deliberately.
 *
 * Only guards what acts on the service itself. Reads and board saves are left
 * alone: the viewer is a page like any other, and breaking its save to defend
 * against a page that could only ever save a board it cannot see would trade a
 * real feature for an imaginary threat.
 */
export const CONTROL_HEADER = "x-diagramos";

function fromOurTools(request: IncomingMessage): boolean {
  return typeof request.headers[CONTROL_HEADER] === "string";
}

/** Constant-time compare, so a wrong token cannot be found one character at a time. */
function sameToken(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Per-board state. One of these exists for every board anyone has asked for. */
interface BoardState {
  revision: string;
  /** Pages pinned to this board with `?file=`. */
  subscribers: Subscriber[];
  debounce?: NodeJS.Timeout;
}

/**
 * A path with every symlink resolved, which is the only spelling a confinement
 * check can be made against.
 *
 * Two reasons, and the second is the important one. A caller's path often has
 * not been resolved -- on macOS `/var` is a link to `/private/var` -- so a
 * project can be named one way by whoever started the service and another way by
 * whoever asks it for a board, and an honest request is refused. And a link
 * *inside* a project pointing out of it is how a check against the unresolved
 * path gets walked straight past.
 *
 * Something that does not exist yet is resolved through its parent instead, so
 * naming a new board still works but cannot describe a place its directory does
 * not really lead.
 */
async function realPathOf(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    try {
      return path.join(await realpath(path.dirname(target)), path.basename(target));
    } catch {
      return target;
    }
  }
}

export async function startBoardServer(options: BoardServerOptions): Promise<RunningBoardServer> {
  const host = options.host ?? "127.0.0.1";
  // Roots and boards are held resolved, so every comparison between them is
  // between two paths spelled the same way.
  const root = options.root ? await realPathOf(path.resolve(options.root)) : undefined;
  let file = await realPathOf(path.resolve(options.file));
  const startedAt = new Date().toISOString();
  /*
   * Every project this service will serve. It starts as the one it was told
   * about and grows when another asks to be adopted, which is what lets one
   * service cover a machine rather than one per repository per port.
   *
   * A set of directories, never "anywhere": the confinement is the guard that
   * stops a page in the browser reading a file it was not shown, and widening it
   * to the projects you actually opened is a different thing from removing it.
   */
  const roots: string[] = root ? [root] : [];
  /*
   * Proof that a caller is one of the user's own processes rather than something
   * running in their browser. It is written into the registry entry, which only
   * the user can read; a page has no way to obtain it.
   */
  const token = randomBytes(24).toString("hex");
  const matchesToken = (given: unknown): boolean => typeof given === "string" && sameToken(token, given);

  let nextSubscriberId = 0;
  /**
   * Every board this server has been asked for, by absolute path. Several can be
   * live at once: a project split across diagrams wants them side by side, and
   * one server on one port beats a scatter of ports nobody can keep track of.
   */
  const boards = new Map<string, BoardState>();
  /**
   * Pages on the bare URL, with no board named. They show whichever board is
   * current and follow setFile, which is what every tool that writes a diagram
   * relies on to bring it on screen.
   */
  let followers: Subscriber[] = [];
  // One watcher per directory rather than per board: boards usually share a
  // directory, and watching it twice would deliver every event twice.
  const watchers = new Map<string, FSWatcher>();
  /** Tree-sitter grammars for /api/drift, loaded on the first request only. */
  let engineReady: Promise<void> | undefined;
  /** The recent timeline of every board this service has seen (#68). */
  const history = new BoardHistory();

  const write = (subscribers: Subscriber[], payload: Record<string, unknown>) => {
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const subscriber of subscribers) subscriber.response.write(frame);
  };

  /** Tells everyone watching `target` about it: pinned pages, and followers when it is current. */
  const announce = (target: string, revision: string, extra: Record<string, unknown> = {}) => {
    const state = boards.get(target);
    if (state) write(state.subscribers, { type: "board", revision, file: target, ...extra });
    if (target === file) write(followers, { type: "board", revision, file: target, ...extra });
  };

  // Editors and our own writes both land as rename or change events, and
  // several can arrive for one logical save, so debounce and compare hashes
  // rather than trusting the event itself.
  const onFileEvent = (target: string) => {
    const state = boards.get(target);
    if (!state) return;
    if (state.debounce) clearTimeout(state.debounce);
    state.debounce = setTimeout(async () => {
      try {
        const board = await readBoard(target);
        const revision = revisionOf(board);
        if (revision === state.revision) return;
        state.revision = revision;
        history.record(target, board, revision, "file");
        announce(target, revision);
      } catch {
        // A partially written file will fire again when the write completes.
      }
    }, 60);
  };

  // Watch the directory, not just the file: atomic saves replace the inode and
  // a file-level watcher goes deaf after the first one.
  const watchDirectory = (directory: string) => {
    if (watchers.has(directory)) return;
    try {
      const watcher = watch(directory, (_event, name) => {
        if (!name) {
          // No filename: check every board in this directory.
          for (const target of boards.keys()) {
            if (path.dirname(target) === directory) onFileEvent(target);
          }
          return;
        }
        const target = path.join(directory, path.basename(String(name)));
        if (boards.has(target)) onFileEvent(target);
      });
      watchers.set(directory, watcher);
    } catch {
      // Without a watcher the browser still polls on reconnect; liveness
      // degrades but nothing breaks.
    }
  };

  /** Starts tracking a board, so it can be served and watched. */
  const track = async (target: string): Promise<BoardState> => {
    const existing = boards.get(target);
    if (existing) return existing;
    const board = await readBoard(target);
    const state: BoardState = { revision: revisionOf(board), subscribers: [] };
    boards.set(target, state);
    // The baseline entry: not a change, but the state every later delta is
    // measured against, and the honest answer to "when did this service first
    // see this board".
    history.record(target, board, state.revision, "opened");
    watchDirectory(path.dirname(target));
    return state;
  };

  await track(file);

  const setFile = async (next: string): Promise<void> => {
    const resolved = await realPathOf(path.resolve(next));
    if (resolved === file) return;
    const state = await track(resolved);
    file = resolved;
    // switchedFile tells the page this is a different document, so it reframes
    // rather than assuming the old viewport still means anything. Only followers
    // hear it; a pinned page has not switched to anything.
    write(followers, { type: "board", revision: state.revision, file, switchedFile: true });
  };

  /**
   * Which board a request is about: `?file=` when given, the current one
   * otherwise. Relative paths resolve against the root, and anything outside it
   * is refused — the query string is as much an untrusted input as the
   * takeover endpoint's body.
   */
  const requestedFile = async (url: URL): Promise<{ file?: string; error?: string }> => {
    const raw = url.searchParams.get("file");
    if (!raw) return { file };
    /*
     * A relative name resolves against the project this service started in, and
     * only that one. Resolving it against every root would make
     * `docs/diagrams/architecture.excalidraw` mean two different files once a
     * second project is adopted, and pick between them by accident of ordering.
     * Boards in adopted projects are named by absolute path for that reason.
     */
    const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root ?? ROOT, raw);
    return await checkInRoots(resolved);
  };

  /**
   * The project a board belongs to.
   *
   * Drift is measured against the repository the board describes, so a board in
   * an adopted project must not be checked against the project this service
   * happened to start in -- every ref would resolve in the wrong tree and the
   * whole board would read as drifted.
   */
  const rootFor = (target: string): string => {
    const resolved = path.resolve(target);
    const owner = roots.find((candidate) => {
      const relative = path.relative(candidate, resolved);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    return owner ?? root ?? process.cwd();
  };

  /** A board is a `.excalidraw` file inside one of the projects this service serves. */
  const checkInRoots = async (resolved: string): Promise<{ file?: string; error?: string }> => {
    /*
     * Boards only. Every path that reaches here is read as a board and handed
     * back, so without this the confinement would still allow any file in the
     * project -- an .env, a private key -- to be fetched by a page that guessed
     * its name. Narrowing it to the extension the service exists to serve costs
     * nothing and makes serving several projects safer than serving one did.
     */
    if (path.extname(resolved).toLowerCase() !== ".excalidraw") {
      return { error: "a board is a .excalidraw file" };
    }
    if (!roots.length) return { file: resolved };
    const real = await realPathOf(resolved);
    const inside = roots.some((candidate) => {
      const relative = path.relative(candidate, real);
      return !relative.startsWith("..") && !path.isAbsolute(relative);
    });
    if (!inside) return { error: `file is outside the projects this board service serves` };
    // The resolved path onward, so everything downstream -- watchers, the board
    // map, what a page is told it is showing -- agrees on one name per file.
    return { file: real };
  };

  /**
   * How a pinned URL names a board.
   *
   * Relative for the project this service started in, absolute for every
   * project it later adopted -- because a relative name only resolves back to
   * the same file for the first one. Two projects can hold
   * `docs/diagrams/architecture.excalidraw`, and a URL that could mean either is
   * worse than a long one.
   */
  const nameFor = (target: string) => {
    const resolved = path.resolve(target);
    if (!root) return resolved;
    const relative = path.relative(root, resolved);
    return relative.startsWith("..") || path.isAbsolute(relative) ? resolved : relative;
  };

  const serveViewer = async (response: ServerResponse, pathname: string) => {
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(VIEWER_DIR, relative);
    if (target !== VIEWER_DIR && !target.startsWith(`${VIEWER_DIR}${path.sep}`)) {
      response.writeHead(403).end("forbidden");
      return;
    }
    try {
      const body = await readFile(target);
      response.writeHead(200, {
        "Content-Type": MIME_BY_EXT[path.extname(target).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": body.byteLength,
      });
      response.end(body);
    } catch {
      if (relative === "index.html") {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Viewer is not built yet. Run `npm run build:viewer`.");
        return;
      }
      response.writeHead(404).end("not found");
    }
  };

  /*
   * When something last showed an interest. An open page counts continuously
   * rather than once, because a page that sits there watching a diagram all
   * afternoon makes no requests at all -- judging idleness by requests alone
   * would close the board out from under exactly the person using it.
   */
  let lastSeen = Date.now();
  const busy = () => followers.length > 0 || [...boards.values()].some((state) => state.subscribers.length > 0);

  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host}`);
      /*
       * Health does not count as interest. It is what other tools ask before
       * deciding whether a board exists -- a session checking status, a command
       * looking for a service to reuse -- and counting it would let a monitor
       * keep an abandoned service alive indefinitely, which is the failure this
       * fuse exists to end.
       */
      if (url.pathname !== "/api/health") lastSeen = Date.now();

      if (url.pathname === "/api/health") {
        return json(response, 200, {
          ok: true,
          file,
          revision: boards.get(file)?.revision,
          pid: process.pid,
          ...(root ? { root } : {}),
          roots: [...roots],
          startedAt,
          ...(options.ownerPid ? { owner: options.ownerPid } : {}),
          ...(options.startedBy ? { startedBy: options.startedBy } : {}),
          // Tells another process that `?file=` is understood here. Without it a
          // newer session would hand out pinned URLs to an older server, which
          // ignores the query and silently serves the wrong board.
          multiBoard: true,
          boards: [...boards.keys()],
        });
      }

      /*
       * Adopts another project, so one service can serve a machine.
       *
       * Guarded by the token in the registry entry rather than by the header the
       * other control endpoints use. This is the one call that widens what
       * `?file=` can reach, and a header only proves the caller is not a browser
       * on another site; the token proves it is one of the user's own processes,
       * because the file holding it is readable by nobody else.
       */
      if (request.method === "POST" && url.pathname === "/api/roots") {
        const payload = JSON.parse(await readBody(request, 8192)) as { root?: string; token?: string };
        if (!matchesToken(payload.token)) {
          return json(response, 403, { error: "a valid token is required to add a project" });
        }
        if (typeof payload.root !== "string" || !payload.root) {
          return json(response, 400, { error: "root is required" });
        }
        const added = await realPathOf(path.resolve(payload.root));
        if (!(await fileExists(added))) {
          return json(response, 404, { error: `no such directory: ${added}` });
        }
        if (!roots.some((candidate) => candidate === added)) {
          roots.push(added);
          // Recorded so a listing says what this service actually covers, and so
          // the next caller can see it already serves their project.
          await updateServer(process.pid, { roots: [...roots] });
        }
        return json(response, 200, { ok: true, roots: [...roots] });
      }

      /*
       * Every board this service can show, for the index page. Read live rather
       * than cached: a board added while the service runs is exactly the case
       * where a stale list looks like a bug in the tool.
       */
      if (request.method === "GET" && url.pathname === "/api/boards") {
        const found = new Map<string, string>();
        for (const project of roots) {
          for (const board of await findBoards(project, diagramDir(project)).catch(() => [])) {
            found.set(board, project);
          }
        }
        // Boards asked for by name that live outside a diagram directory are
        // still being served, so leaving them off the index would make the one
        // page that claims to show everything the one place they are missing.
        for (const board of boards.keys()) {
          if (found.has(board)) continue;
          found.set(board, roots.find((project) => board.startsWith(`${project}${path.sep}`)) ?? "");
        }
        return json(response, 200, {
          root,
          roots: [...roots],
          pid: process.pid,
          port,
          startedAt,
          current: file,
          boards: [...found.entries()]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([target, project]) => ({
              file: target,
              project,
              // Named within its own project, so a list covering several of them
              // does not read as a wall of identical absolute paths.
              name: project ? path.relative(project, target) : target,
              url: `/?file=${encodeURIComponent(nameFor(target))}`,
              current: target === file,
            })),
        });
      }

      /*
       * Stops the service from the page, so stopping a board does not require
       * knowing there is a command for it.
       *
       * Closing is all it does. In the background service that empties the event
       * loop and the process ends on its own, which is why there is no exit call
       * here to go wrong in a test that hosts a server in its own process.
       */
      if (request.method === "POST" && url.pathname === "/api/shutdown") {
        if (!fromOurTools(request)) {
          return json(response, 403, { error: `shutdown needs the ${CONTROL_HEADER} header` });
        }
        json(response, 200, { ok: true, stopping: process.pid });
        // After the reply is on the wire: close() ends the connection this
        // answer is travelling on.
        setTimeout(() => void close().catch(() => undefined), 50);
        return undefined;
      }

      /*
       * Lets a different process steer this board. The port is shared across
       * sessions, so whichever process happens to own it must not be the only
       * one able to decide which file is on screen -- otherwise a stale
       * session pins the board to a file nobody is working on.
       */
      if (request.method === "POST" && url.pathname === "/api/file") {
        const payload = JSON.parse(await readBody(request, 8192)) as { file?: string };
        if (typeof payload.file !== "string" || !payload.file) {
          return json(response, 400, { error: "file is required" });
        }
        const requested = await checkInRoots(path.resolve(payload.file));
        if (!requested.file) return json(response, 403, { error: requested.error });
        if (!(await fileExists(requested.file))) {
          return json(response, 404, { error: `no such file: ${requested.file}` });
        }
        await setFile(requested.file);
        return json(response, 200, { ok: true, file });
      }

      /*
       * The drift report for one board, so the page can show *status* and not
       * only the picture. Computed on request rather than watched live: the
       * viewer asks again whenever the board changes, when its tab regains
       * focus, and on a slow timer, which covers the working loop without this
       * server growing a file-system watcher over the whole repository.
       */
      if (request.method === "GET" && url.pathname === "/api/drift") {
        const target = await requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        if (!(await fileExists(target.file))) {
          return json(response, 404, { error: `no such file: ${target.file}` });
        }
        // Grammars load once per process, lazily: a server nobody asks for
        // status keeps starting as fast as it always did.
        engineReady ??= initEngine();
        await engineReady;
        const workspaceRoot = rootFor(target.file);
        const report = checkDrift(await readBoard(target.file), createWorkspace(workspaceRoot), {
          baseline: createGitBaseline(workspaceRoot, target.file),
        });
        return json(response, 200, { file: target.file, report });
      }

      /**
       * The board's recent timeline (#68): what changed it and by how much,
       * newest first. Only what this service saw -- git holds the durable
       * history, and the page says so rather than pretending otherwise.
       */
      if (request.method === "GET" && url.pathname === HISTORY_ROUTE) {
        const target = await requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        if (!(await fileExists(target.file))) {
          return json(response, 404, { error: `no such file: ${target.file}` });
        }
        // A board asked about is a board tracked, so its later changes land here.
        await track(target.file);
        return json(response, 200, { file: target.file, entries: history.entriesFor(target.file) });
      }

      if (request.method === "GET" && url.pathname === "/api/board") {
        const target = await requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        if (!(await fileExists(target.file))) {
          return json(response, 404, { error: `no such file: ${target.file}` });
        }
        const state = await track(target.file);
        const board = await readBoard(target.file);
        state.revision = revisionOf(board);
        return json(response, 200, { revision: state.revision, board, file: target.file });
      }

      if (request.method === "POST" && url.pathname === "/api/board") {
        const payload = JSON.parse(await readBody(request)) as {
          revision?: string;
          board?: BoardFile;
          file?: string;
        };
        if (!payload.board || !Array.isArray(payload.board.elements)) {
          return json(response, 400, { error: "board with an elements array is required" });
        }
        // A write must say what it thinks it is replacing. Without the claim
        // there is nothing standing between a stale client and the file, and a
        // stale scene written blind is exactly the shape of a wipe (#70).
        if (!payload.revision) {
          return json(response, 400, { error: "revision is required — pull the board first" });
        }
        // The save lands on the file the scene came from, when the client says
        // which. The bare URL means "whatever board is current" -- right for
        // reading, wrong for writing: the server can be switched to another
        // file between a scene being composed and its save arriving, and
        // resolving the write against the *new* file is how a follow tab once
        // wiped a freshly generated board (#70).
        let saveTo: string;
        if (typeof payload.file === "string" && payload.file) {
          // Through the same check every other path uses. Written against one
          // root it would refuse every save in an adopted project, and it would
          // be the one way in that never got narrowed to boards -- a write is a
          // worse thing to leave wide than a read.
          const named = await checkInRoots(path.resolve(payload.file));
          if (!named.file) return json(response, 403, { error: named.error });
          if (!(await fileExists(named.file))) {
            return json(response, 404, { error: `no such file: ${named.file}` });
          }
          saveTo = named.file;
        } else {
          const target = await requestedFile(url);
          if (!target.file) return json(response, 403, { error: target.error });
          saveTo = target.file;
        }
        const state = await track(saveTo);
        const onDisk = await readBoard(saveTo);
        const diskRevision = revisionOf(onDisk);
        if (payload.revision !== diskRevision) {
          // Stale write. Hand back the current board so the browser can merge
          // its own edits over it instead of clobbering or losing them.
          return json(response, 409, { error: "stale revision", revision: diskRevision, board: onDisk, file: saveTo });
        }
        await writeBoard(saveTo, payload.board);
        state.revision = revisionOf(payload.board);
        // Recorded now rather than left to the file watcher's echo, so the
        // entry can say "page": the watcher only knows something wrote the
        // file, not that it was a person drawing.
        history.record(saveTo, payload.board, state.revision, "page");
        announce(saveTo, state.revision);
        return json(response, 200, { revision: state.revision, file: saveTo });
      }

      if (request.method === "GET" && url.pathname === "/api/events") {
        const target = await requestedFile(url);
        if (!target.file) return json(response, 403, { error: target.error });
        // A stream named a board explicitly: pin it, so nothing re-points it.
        const pinned = url.searchParams.has("file");
        const state = await track(target.file);

        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({ type: "board", revision: state.revision, file: target.file })}\n\n`,
        );
        const subscriber = { response, id: ++nextSubscriberId };
        if (pinned) state.subscribers.push(subscriber);
        else followers.push(subscriber);
        // Proxies drop idle streams; a periodic comment keeps it warm.
        const keepAlive = setInterval(() => response.write(": ping\n\n"), 25_000);
        request.on("close", () => {
          clearInterval(keepAlive);
          if (pinned) {
            state.subscribers = state.subscribers.filter((candidate) => candidate.id !== subscriber.id);
          } else {
            followers = followers.filter((candidate) => candidate.id !== subscriber.id);
          }
        });
        return undefined;
      }

      if (request.method === "GET" && (url.pathname === "/boards" || url.pathname === "/boards/")) {
        const body = boardsPage();
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": Buffer.byteLength(body),
          "Cache-Control": "no-store",
        });
        response.end(body);
        return undefined;
      }

      if (request.method === "GET") return serveViewer(response, url.pathname);
      response.writeHead(405).end("method not allowed");
      return undefined;
    } catch (error) {
      return json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (address && typeof address === "object") resolve(address.port);
      else reject(new Error("Board server did not bind a port"));
    });
  });

  /*
   * Registered only once it is actually listening. An entry written before the
   * bind could describe a server that never came up, and `stop` would report a
   * board that was never there.
   */
  const unregister = await registerServer({
    pid: process.pid,
    port,
    ...(root ? { root } : {}),
    roots: [...roots],
    token,
    startedAt,
    ...(options.ownerPid ? { owner: options.ownerPid } : {}),
    ...(options.startedBy ? { startedBy: options.startedBy } : {}),
  });

  /*
   * The owner watchdog. Polling rather than waiting on an event because there is
   * no portable notification for "my parent died" -- on macOS and Linux the
   * child simply gets reparented and carries on serving.
   *
   * Unref'd so it never keeps the process alive on its own: the point is to end
   * a process, never to extend one.
   */
  let watchdog: NodeJS.Timeout | undefined;
  if (options.ownerPid !== undefined) {
    const owner = options.ownerPid;
    watchdog = setInterval(() => {
      if (processAlive(owner)) return;
      clearInterval(watchdog);
      void close().then(
        () => process.exit(0),
        () => process.exit(0),
      );
    }, OWNER_POLL_MS);
    watchdog.unref();
  }

  /*
   * The idle fuse. Checked on a slow interval rather than scheduled precisely,
   * because being a minute late to stop an unused service costs nothing and a
   * rescheduled timer per request would be work on every page load.
   *
   * Unref'd for the same reason the watchdog is: its job is to end a process,
   * never to be the reason one stays alive.
   */
  const idleMs = options.idleMs ?? resolveIdleMs(process.env.DIAGRAMOS_IDLE_HOURS);
  let idleTimer: NodeJS.Timeout | undefined;
  if (idleMs > 0) {
    idleTimer = setInterval(() => {
      if (busy()) {
        lastSeen = Date.now();
        return;
      }
      if (Date.now() - lastSeen < idleMs) return;
      clearInterval(idleTimer);
      void close().catch(() => undefined);
    }, Math.max(50, Math.min(IDLE_CHECK_MS, idleMs)));
    idleTimer.unref();
  }

  async function close(): Promise<void> {
    if (idleTimer) clearInterval(idleTimer);
    if (watchdog) clearInterval(watchdog);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
    for (const state of boards.values()) {
      if (state.debounce) clearTimeout(state.debounce);
      for (const subscriber of state.subscribers) subscriber.response.end();
      state.subscribers = [];
    }
    for (const subscriber of followers) subscriber.response.end();
    followers = [];
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unregister();
  }

  return {
    url: `http://${host}:${port}/`,
    port,
    get file() {
      return file;
    },
    setFile,
    urlFor(target: string) {
      return `http://${host}:${port}/?file=${encodeURIComponent(nameFor(target))}`;
    },
    boards() {
      return [file, ...[...boards.keys()].filter((candidate) => candidate !== file)];
    },
    close,
  };
}

export interface BoardProbe {
  /** The board its follow view is showing. */
  file?: string;
  /**
   * Whether it understands `?file=` pinned URLs. Absent on a server from before
   * boards could be opened side by side — handing such a server a pinned URL
   * would look fine and quietly serve whatever board it happens to be on.
   */
  multiBoard?: boolean;
  boards?: string[];
  /**
   * The server's process id. `/api/health` has always returned this; it was
   * missing here, so `board_status` could not pass it on and the model had to
   * shell out to `lsof` to answer "what is showing my diagrams".
   */
  pid?: number;
  /** The project it started in. Absent on an unrooted server. */
  root?: string;
  /**
   * Every project it serves. Absent on a service from before one could serve
   * more than one, which is how a caller knows to start its own rather than ask
   * to be adopted by a service that would not understand the request.
   */
  roots?: string[];
  /** ISO 8601, so a listing can say how long it has been running. */
  startedAt?: string;
  /** The process it belongs to and will not outlive, when it has one. */
  owner?: number;
  /**
   * How it was started, in words. The registry records this for `diagramos
   * stop`; reporting it here lets a session say where a board came from without
   * reading another process's state directory.
   */
  startedBy?: string;
}

/** What the board server on this port says about itself, if one is there. */
export async function probeBoard(port: number, host = "127.0.0.1"): Promise<BoardProbe | undefined> {
  try {
    const response = await fetch(`http://${host}:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (!response.ok) return undefined;
    return (await response.json()) as BoardProbe;
  } catch {
    return undefined;
  }
}

/** The file a board server is serving on this port, or undefined if none is. */
export async function probeBoardServer(port: number, host = "127.0.0.1"): Promise<string | undefined> {
  return (await probeBoard(port, host))?.file;
}

export async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
