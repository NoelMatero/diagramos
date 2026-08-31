#!/usr/bin/env node
/**
 * Board MCP server: gives Claude read/write access to a durable Excalidraw
 * diagram that lives in the repo next to the code it describes.
 *
 * Files are the source of truth. Every tool is a read-modify-write on a
 * .excalidraw file, so a diagram survives the session, opens in any Excalidraw
 * editor, and diffs in git.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { emptyBoard, readBoard, writeBoard } from "../engine/board-file";
import { TOOL_VERSION, schemaOf } from "../engine/version";
import {
  applyEdits,
  connectNodes,
  createDiagram,
  deleteDiagram,
  listDiagrams,
} from "../engine/diagram";
import { damageSentence, type BindingFault } from "../engine/damage";
import { readGraph } from "../engine/graph";
import { relayoutDiagram } from "../engine/relayout";
import { projectGraph } from "./projection";
import { createCodeGraphOption } from "../engine/codegraph";
import { createLedger } from "../engine/ledger";
import { CONFIG_FILE, DEFAULT_DIAGRAM_DIR, diagramDir } from "../engine/config";
import {
  checkDrift,
  createGitBaseline,
  createWorkspace,
  findBoards,
  findStrayBoards,
  UNCONFIRMED_WORDS,
  type UnconfirmedEdge,
} from "../engine/drift";
import { createGitTrail, type FollowedRef } from "../engine/follow";
import { computeHonestGaps } from "../engine/gaps";
import { loadConverter } from "../engine/convert";
import { initEngine } from "../engine/parse";
import { renderBoardToPng } from "../engine/render";
import {
  probeBoard,
  resolveBoardPort,
  type BoardProbe,
} from "../server/board-server";
import { ensureBoardServer, findServing } from "../server/daemon";
import {
  relativeToWorkspace,
  resolveBoardPath,
  resolveInWorkspace,
  resolveNewBoardPath,
  WORKSPACE_ROOT,
} from "./paths";

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

const MAX_IMAGE_BYTES = 4_000_000;

/**
 * Board id for an image, derived from its workspace-relative path.
 *
 * The basename alone is not enough: `ui/shot.png` and `api/shot.png` reduce to
 * the same string, and so do `shot a.png` and `shot-a.png` once punctuation is
 * replaced. Two distinct images sharing an id overwrite each other's data in
 * board.files, so the full path goes in, and a digest of it settles the cases
 * where sanitising still collides.
 */
function imageElementId(relativePath: string): string {
  const slug = relativePath
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-48);
  const digest = createHash("sha1").update(relativePath).digest("hex").slice(0, 8);
  return `img-${slug || "image"}-${digest}`;
}

/**
 * Tool results go to a model, not a person, so they are not pretty-printed.
 * Indentation cost 37% of a read_diagram response on a 24-node board -- pure
 * whitespace, charged on every call, buying nothing a model needs.
 */
function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) },
    ],
  };
}

/**
 * The fields an element's geometry is actually addressed by.
 *
 * A raw Excalidraw element carries 27 keys -- seeds, nonces, fill styles,
 * roughness, indices -- and dumping them cost ~25k tokens on one 24-node board.
 * An edit needs position, size, and the colours it might be changing; the rest
 * is engine bookkeeping the model can neither use nor safely set.
 */
function projectElement(element: Record<string, unknown>): Record<string, unknown> {
  const keep = ["id", "type", "x", "y", "width", "height", "strokeColor", "backgroundColor"];
  const projected: Record<string, unknown> = {};
  for (const key of keep) if (element[key] !== undefined) projected[key] = element[key];
  if (typeof element.text === "string" && element.text) projected.text = element.text;
  if (typeof element.containerId === "string") projected.containerId = element.containerId;
  return projected;
}

function failure(error: unknown) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
  };
}

/** Every tool body funnels through here so a throw becomes a tool error. */
async function guard<T>(run: () => Promise<T>): Promise<T | ReturnType<typeof failure>> {
  try {
    return await run();
  } catch (error) {
    return failure(error);
  }
}

const nodeSchema = z.object({
  id: z.string().describe("Stable id, used by edges and later edits"),
  label: z.string().describe("Text shown inside the shape"),
  shape: z.enum(["rectangle", "ellipse", "diamond"]).optional(),
  backgroundColor: z.string().optional(),
  strokeColor: z.string().optional(),
  rounded: z.boolean().optional(),
  ref: z
    .string()
    .optional()
    .describe(
      "What this node stands for in the repo. A file (src/engine/layout.ts), a symbol in one "
      + "(src/engine/layout.ts#planLayout), a directory (src/engine/ — must not be empty), a symbol "
      + "somewhere directly inside one (src/engine/#Workspace), or a glob over one directory "
      + "(src/engine/*.ts — * is allowed in the last segment only, never **), or an HTTP endpoint "
      + "(src/server/board-server.ts#/api/board, optionally with a method token as in #GET /api/board, "
      + "which is read but never verified). Set it when a node is "
      + "real code so check_drift can tell when it goes stale. Leave it off for anything not in this "
      + "repository, and say why with state or the board's describes. "
      + "A symbol ref may end in @declared, @used, or @declared+used, which narrows the check from "
      + "'this file mentions the name' to 'this file declares it' and 'something here calls it'. "
      + "Write it ONLY from the code you just read to locate the symbol: it is a transcription of "
      + "what was on screen, never a guess about what the box probably does. A symbol declared here "
      + "but called only from other files takes @declared alone. Unread means no suffix, which is a "
      + "smaller claim rather than a worse one.",
    ),
  refs: z
    .array(z.string())
    .optional()
    .describe(
      "Further anchors, when one box stands for more than one thing — a feature spread over "
      + "several files, or a constant and the function that uses it. Each is checked and reported "
      + "separately; the box is clean when all of them are. ref stays the primary one, and is what "
      + "arrows between boxes are checked against.",
    ),
  closed: z
    .object({
      through: z
        .array(z.string())
        .optional()
        .describe(
          "Files inside the directory that outside code IS allowed to reach — the front doors. "
          + "Repo-relative paths. Omit or leave empty to claim total isolation, which is unusual "
          + "but real.",
        ),
    })
    .optional()
    .describe(
      "Only for a box whose ref is a DIRECTORY. Claims that nothing outside that directory "
      + "imports anything inside it, except through the doors listed in `through`. THIS IS "
      + "CHECKED against every file in the repository: one import from outside that no door "
      + "allows makes the claim false, by file and line, and the build fails. Test files are "
      + "exempt and counted separately. Write it ONLY when you have reason to believe the "
      + "boundary holds — check first, because claiming it on a subsystem everything reaches "
      + "into produces an immediate failure that is your mistake, not the user's. On a "
      + "state:'planned' box the directory does not exist yet, so the claim is the boundary the "
      + "subsystem is meant to hold once built; nothing is walked or checked until the box "
      + "promotes.",
    ),
  state: z
    .enum(["planned", "built", "external"])
    .optional()
    .describe(
      "Whether this exists yet. Omit for 'built' (the default: it exists now). "
      + "Use 'planned' for something meant to exist — it is drawn dashed, its ref not resolving "
      + "is reported as work to do rather than as drift, and check_drift says so once the code "
      + "catches up. Use 'external' for something deliberately outside this repo (a browser, a "
      + "third-party service), which is drawn dotted, is never checked, and is not the same as "
      + "forgetting a ref.",
    ),
});

const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  via: z
    .array(z.string())
    .optional()
    .describe(
      "The route this connection takes, named hop by hop, when it is not a direct call: "
      + "['handle_logging', 'emit'] for from -> handle_logging -> emit -> to. Each consecutive "
      + "pair is checked inside one function body, so a chain of any depth is verified and a "
      + "break names the hop that stopped holding. Only for arrows whose ends both name symbols.",
    ),
  claim: z
    .enum(["needs", "feeds", "takes", "returns"])
    .optional()
    .describe(
      "What this arrow asserts, when it asserts anything. Four words, and an arrow may carry one. "
      + "'needs': the from end declares a dependency on the to end — an import, a require, an "
      + "include. Write it ONLY when you have read that line in the code: it is a transcription of "
      + "something you saw, never a guess about what the relationship probably is. Shown on the "
      + "board as @needs and recorded, and CHECKED: if the dependency runs the other way and only "
      + "the other way, the arrow is reported as backwards, by file and line, and the build fails. "
      + "So a needs you guessed at is not a harmless decoration -- it is a false statement read "
      + "back to the user, on their diagram, in red. "
      + "'feeds': the from end's RESULT goes into the to end -- the pipeline arrow, which is a "
      + "different fact and often points the opposite way from the import. Confirmed by finding "
      + "the flow written down somewhere a person can read it: one function binding the first "
      + "call's result and passing it to the second, or handing it straight over. It CANNOT fail "
      + "-- a value can reach the other end through a callback or a field no reader follows, so "
      + "not finding the flow is never held against the arrow, and there is no red for it. Both "
      + "ends must anchor a symbol (path#symbol), because a file has no result. "
      + "'takes' and 'returns': the TO end is a function and the FROM end is a type, and the "
      + "arrow says that function's signature names that type -- 'takes' for a parameter, "
      + "'returns' for the return type. This is the ordinary shape of a typed diagram (struct "
      + "Request -> handler(&Request)) and neither needs nor feeds is true of it. Both are "
      + "CHECKED and both can fail: a function's parameters and return type can be listed in "
      + "full, so a type absent from both is genuinely absent, and the arrow is reported in red "
      + "with the signature quoted. Two words rather than one so the arrow's direction still "
      + "means something -- claim the wrong half and you get told the type is on the other side "
      + "rather than a red. Nothing is reported either way when the type would have to be "
      + "recognised under another name (a type alias, an import renamed on the way in): a "
      + "signature that could be hiding it proves nothing, so the check withholds instead of "
      + "accusing. The TO end must anchor a symbol and the FROM end must name the type. "
      + "A relationship you cannot point at is an arrow with no claim, which is fine and is what "
      + "most arrows are: an unclaimed arrow is looked for and counted, never judged, so it cannot "
      + "come back as a finding against you. "
      + "Both rules are about arrows that exist. On a state:'planned' arrow there is nothing to "
      + "read yet, so a claim there is a specification of what will be true once built; nothing "
      + "checks it until the code lands and the arrow promotes, so writing it there costs nothing "
      + "and accuses nobody.",
    ),
  label: z.string().optional().describe("One or two words; longer crowds the diagram"),
  strokeColor: z
    .string()
    .optional()
    // Set here, not patched afterwards: a regenerate would revert a patch.
    .describe("Arrow and edge-label colour, e.g. #1971c2. Set it here, not by patching after."),
  state: z
    .enum(["planned", "built", "external"])
    .optional()
    .describe(
      "Whether this connection exists yet. Omit for 'built'. Use 'planned' for a connection "
      + "that should exist — the wiring to be done — which is drawn as a dashed arrow, and "
      + "check_drift reports it as work rather than as an unsupported arrow.",
    ),
});

/**
 * The board service this session has been talking to, if any.
 *
 * A port, not a server. This process used to host the board itself, which meant
 * the board died when the session did -- the opposite of the promise that a
 * diagram outlives the conversation that produced it. The service now runs on
 * its own; all this remembers is where to find it, so a write can point it at
 * the file it just changed without going through the registry every time.
 *
 * Every tool that writes points the page at the file it just wrote, because a
 * board silently watching a different file is indistinguishable from one that
 * has stopped updating.
 */
let servicePort: number | undefined;

/**
 * Read on use rather than once at load, so a malformed DIAGRAMOS_PORT fails only
 * the two tools that need a port. Resolving it at module scope would throw
 * before the transport connects and take the whole server down, including every
 * file tool that never touches the network.
 */
function boardPort(): number {
  return resolveBoardPort(process.env.DIAGRAMOS_PORT);
}

/**
 * A URL pinned to one board on a server this process does not own.
 *
 * The absolute path goes in rather than the workspace-relative one: another
 * session may be rooted somewhere else, and an absolute path either resolves to
 * the same file or is refused outright. A relative one could quietly resolve to a
 * different file of the same name in that session's project.
 */
function pinnedBoardUrl(port: number, file: string): string {
  return `http://127.0.0.1:${port}/?file=${encodeURIComponent(file)}`;
}

/**
 * The board service serving this workspace, if one is running.
 *
 * Found through the registry rather than by probing the default port, because
 * the port is not an address: a service pushed off 4747 by another project is on
 * an ephemeral one, and probing 4747 would report "no board running" while it
 * serves this workspace perfectly well.
 *
 * The remembered port is checked before the registry is read, so the common case
 * -- a session that already opened a board, writing to it again -- costs one
 * request instead of a directory listing.
 */
async function currentService(): Promise<{ port: number; probe: BoardProbe } | undefined> {
  if (servicePort !== undefined) {
    const probe = await probeBoard(servicePort);
    if (probe) return { port: servicePort, probe };
    servicePort = undefined;
  }
  // The same rule `open_board` uses to decide whether to start one, so status
  // and opening can never disagree about whether a board exists.
  const found = await findServing(WORKSPACE_ROOT);
  if (!found?.probe) return undefined;
  servicePort = found.port;
  return { port: found.port, probe: found.probe };
}

/** Asks the board service to show this file. */
async function steerExistingBoard(file: string): Promise<string | undefined> {
  const service = await currentService();
  if (!service) return undefined;
  const { port } = service;
  const serving = service.probe.file;
  if (serving === undefined) return undefined;
  if (serving === file) return `http://127.0.0.1:${port}/`;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return undefined;
    return `http://127.0.0.1:${port}/`;
  } catch {
    return undefined;
  }
}

/**
 * Keeps the live page on the file being worked on.
 *
 * Always over HTTP now, whether or not this session is the one that started the
 * service: nothing here hosts a board, so there is no in-process shortcut left
 * and no second code path to keep in step with this one.
 *
 * Never starts a service. Writing a diagram is not a request to open a window,
 * and a tool that quietly spawned one would be starting a background process on
 * somebody who only asked for a file.
 */
async function followBoard(file: string): Promise<void> {
  try {
    await steerExistingBoard(file);
  } catch {
    // Losing the live view must never fail the write that succeeded.
  }
}

const server = new McpServer(
  // Read from package.json rather than restated. Written out by hand this said
  // "0.1.0" to every client for the whole of the 0.2 line, which is the exact
  // failure the board stamp exists to avoid -- so it must not be reintroduced
  // here of all places.
  { name: "diagramos", version: TOOL_VERSION },
  {
    instructions:
      "Diagrams are .excalidraw files in the repo. A board holds one diagram: create_diagram "
      + "replaces what it generated before and keeps anything drawn by hand; delete_diagram removes "
      + "one. Read an existing board before editing it. Nodes keep their semantic ids, so refer to "
      + "them by id later. Hand-drawn elements are reported as inferred: treat them as the spec and "
      + "never redraw them.\n"
      + "Changing a board that exists is three tools, and picking by habit is expensive rather than "
      + "wrong: re-sending a 34-node board costs ~1,900 tokens. A ref, a state, a colour or a claim "
      + "is edit_diagram. The layout flow is relayout_diagram. create_diagram is for structure -- "
      + "boxes added or removed, a subsystem reworked.\n"
      + "Drawing is not reproducible and checking is. Two runs of the same request give different "
      + "boards, because the graph comes from a model; everything downstream of the graph is "
      + "deterministic, so an unchanged diagram regenerates byte-identically and every check gives "
      + "the same answer twice. Say so before redrawing a board somebody liked.\n"
      + "The live web view exists only while a board server runs. Use open_board to start it or to "
      + "get the URL for another diagram, board_status to ask what is up. Each board has its own "
      + "URL, so several can be open side by side and opening one never disturbs another; a project "
      + "split across diagrams is meant to be watched that way. Never give the user a localhost URL "
      + "you did not get back from one of those two in this session; an address that answers "
      + "nothing is worse than none.",
  },
);

/**
 * What the arrows just written claim, said the turn they are written.
 *
 * A claim nobody saw go on is a claim nobody can refuse -- the board shows it,
 * and this is for whoever is reading the transcript rather than the canvas.
 *
 * Grouped by word rather than counted together, because the words carry
 * different consequences: `needs`, `takes` and `returns` can come back wrong and
 * fail a build, `feeds` can only ever come back confirmed. One sentence covering
 * all of them would tell an author the wrong thing about most of what they wrote.
 *
 * A table rather than a conditional, because a conditional had a default: the
 * `else` branch said the `feeds` sentence, so adding a word (#169) would have
 * quietly promised an author that their refutable claim could never fail. There
 * is no default here, and a word with no entry says nothing beyond the count --
 * which is wrong but not a lie.
 */
const CLAIM_CONSEQUENCE: Record<string, string> = {
  needs:
    " Each one is now checked for direction: an arrow drawn against the dependency is reported"
    + " as backwards.",
  feeds:
    " Each one is now checked by looking for the flow — a function binding the first result and"
    + " passing it into the second. Finding it confirms the arrow; not finding it is counted and"
    + " never held against it.",
  takes:
    " Each one is now read off the signature: if the parameters of the to end do not name the"
    + " from end's type, the arrow is reported in red with the signature quoted. Nothing is"
    + " reported either way when the type could be written there under another name.",
  returns:
    " Each one is now read off the signature: if the return type of the to end does not name the"
    + " from end's type, the arrow is reported in red with the signature quoted. Nothing is"
    + " reported either way when the type could be written there under another name.",
};

function claimNote(arrows: ReadonlyArray<{ claim?: string }>): { claims?: string } {
  const byWord = new Map<string, number>();
  for (const arrow of arrows) {
    if (arrow.claim) byWord.set(arrow.claim, (byWord.get(arrow.claim) ?? 0) + 1);
  }
  if (byWord.size === 0) return {};
  const said = [...byWord].map(([word, count]) =>
    `${count} ${count === 1 ? "arrow claims" : "arrows claim"} ${word}, `
    + `shown on the board as @${word}.${CLAIM_CONSEQUENCE[word] ?? ""}`);
  return { claims: said.join(" ") };
}

/** A box label on one line, cut to the part that says which box it is. */
function shortLabel(label: string): string {
  const flat = label.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * How many arrows to name before the list stops being read.
 *
 * The same eight the CLI's audit stops at, for the same reason: long enough for
 * every board in this repo, short enough that a fifty-arrow board comes back
 * with a note rather than a wall. The overflow is counted out loud, because a
 * list that quietly stopped at eight would read as "that is all of them".
 */
const ARROW_CAP = 8;

/**
 * The arrow half of the draw-time check: what nothing corroborated, and why.
 *
 * This used to be thrown away. The check runs the whole arrow pass here anyway,
 * and the result was dropped on the floor with a comment saying questionable
 * arrows were a review matter -- true while an uncorroborated arrow came back
 * amber, because review time is when you look at ambers. #133 removed the
 * amber, and what is left is not a defect at all: it is a fact about *how the
 * arrow was anchored*, and the only person who can change an anchor is the
 * author, who is here now and gone by the time any check runs (#145).
 *
 * Three rules keep it from becoming the amber again under a new name:
 *
 * - It never refuses anything. The board is written either way, and an
 *   uncorroborated arrow may be a perfectly good arrow with a deliberate
 *   anchor.
 * - It is not a finding, and says so. Nothing downstream reports these: no
 *   colour on the board, no row in the notice, no exit code.
 * - It borrows the check's own words, from the check's own table, so a reader
 *   who sees both surfaces is not learning a second vocabulary for one fact.
 *
 * Everything is counted; only the arrows a reader can act on are named. The two
 * generic reasons -- nothing calls the other, nothing connects them -- are
 * honest and unactionable, so naming them buys a longer message and no
 * decision. `an-end-is-data` is the opposite: it is the anchor, it is still the
 * commonest (6 of 12 on the board this came from, once the five whose evidence
 * was in a declaration were confirmed rather than counted -- #144), and moving
 * that end to file level turns an unconfirmable arrow into a checkable one.
 */
function unconfirmedArrowNote(unconfirmed: ReadonlyArray<UnconfirmedEdge>): Record<string, unknown> {
  if (unconfirmed.length === 0) return {};
  const byReason = new Map<UnconfirmedEdge["reason"], number>();
  for (const arrow of unconfirmed) {
    byReason.set(arrow.reason, (byReason.get(arrow.reason) ?? 0) + 1);
  }
  // Commonest first: on a board where one anchoring habit produced most of
  // this, that habit is the sentence worth reading.
  const why = [...byReason]
    .sort((a, b) => b[1] - a[1])
    .map(([reason, count]) => `${count} ${UNCONFIRMED_WORDS[reason]}`)
    .join(" · ");
  const named = (reason: UnconfirmedEdge["reason"], say: (arrow: UnconfirmedEdge) => string) => {
    const matching = unconfirmed.filter((arrow) => arrow.reason === reason);
    if (matching.length === 0) return undefined;
    const shown = matching.slice(0, ARROW_CAP).map(say);
    const held = matching.length - shown.length;
    return held > 0 ? [...shown, `+${held} more`] : shown;
  };
  // Named by box label, not by ref: that is what a person recognises when they
  // go back to the board to move an anchor. Box labels run to several lines on
  // a dense board -- one of these is 96 characters over three -- so they are
  // flattened and cut to the part that identifies the box, which is the first
  // thing written in it.
  const dataEnds = named(
    "an-end-is-data",
    (arrow) => `${shortLabel(arrow.fromLabel)} → ${shortLabel(arrow.toLabel)}`,
  );
  // Rare, and the one sentence here that names a line somebody can go and read,
  // so it is carried whole rather than reduced to two labels.
  const backwardsFlow = named("feeds-runs-the-other-way", (arrow) => arrow.detail);
  return {
    arrowsNotConfirmed:
      `${unconfirmed.length} ${unconfirmed.length === 1 ? "arrow was" : "arrows were"} read and `
      + `nothing corroborated ${unconfirmed.length === 1 ? "it" : "them"}: ${why}.`,
    ...(dataEnds ? { anchoredAtData: dataEnds } : {}),
    ...(backwardsFlow ? { flowRunsTheOtherWay: backwardsFlow } : {}),
    aboutThoseArrows:
      "Information, not a finding: nothing here contradicts the board, and nothing downstream "
      + "reports it -- no colour, no notice, no exit code. It is said now because most of it was "
      + "decided by which anchor went on which box, and you are the last person who can change "
      + "that."
      + (dataEnds
        ? " An end naming a struct, a field or a static has no body for a call search to read. If "
          + "the arrow means a call, anchor that end at the function that makes it; if it means "
          + "orchestration or ownership, anchor it at file level and the import channels can "
          + "answer instead."
        : "")
      + " If the anchors are already the ones you meant, leave them.",
  };
}

/**
 * Everything the check has to say about a board the moment it is written.
 *
 * One function because there is now more than one way to write a board. The
 * facts are the same whichever tool got here, and two copies of these sentences
 * would drift the way the "what was checked" line drifted before `summary.ts`
 * took it over.
 *
 * The order is the order they matter in: a ref pointing at nothing is probably a
 * typo, a garbled claim is a word no check can read, planned work is on purpose,
 * and the arrows are information about anchoring rather than anything wrong.
 */
function drawTimeNotes(drawn: {
  findings: ReadonlyArray<{ node: string; label?: string; ref: string; kind: string; detail: string }>;
  garbledClaims: ReadonlyArray<{ detail: string }>;
  workItems: ReadonlyArray<unknown>;
  unconfirmedEdges: ReadonlyArray<UnconfirmedEdge>;
  followed: ReadonlyArray<FollowedRef>;
}): Record<string, unknown> {
  /*
   * Build output is reported apart from the rest, because the advice differs.
   *
   * Everything under `pointsAtNothing` is a typo or a plan, and the fix line
   * says so. A ref into `target/` or `dist/` is neither: the file is there, so
   * `state: "planned"` would be a lie, and re-reading the same address would
   * turn the box green again with nothing behind it. The one thing to do is
   * move the anchor to the source, and the finding's own detail says which
   * directory generated what (#166).
   */
  const generated = drawn.findings.filter((finding) => finding.kind === "generated-ref");
  const missing = drawn.findings.filter((finding) => finding.kind !== "generated-ref");
  return {
    ...(missing.length
      ? {
          pointsAtNothing: missing.map(
            (finding) => `${finding.label || finding.node} → ${finding.ref}`,
          ),
          fix:
            "Each of those is a typo to correct or work not written yet. Work to come carries "
            + 'state: "planned" -- drawn dashed, reported as a work item, and flipped to built '
            + "on its own when the code lands. Left as is, the end-of-turn check reports it to "
            + "the user in red.",
        }
      : {}),
    ...(generated.length
      ? {
          pointsAtBuildOutput: generated.map(
            (finding) => `${finding.label || finding.node} → ${finding.ref}: ${finding.detail}`,
          ),
          fixBuildOutput:
            "Do not mark these planned and do not re-read the artifact. Find the source file the "
            + "build was made from and anchor the box there. A ref into build output passes every "
            + "check forever and reports nothing when the code behind it changes.",
        }
      : {}),
    /*
     * Where the code behind one of those went, when the repository can say so.
     *
     * The cheapest possible correction and the one most likely to be needed: a
     * box drawn against an address that moved is not a mistake about the
     * architecture, it is a mistake about a path, and the answer was already
     * written down in git. Saying it here means the ref gets fixed in the same
     * turn it was written rather than by somebody searching the tree later.
     *
     * Nothing has been changed. `becomes` is a ref to write; an entry without
     * one is the follower saying why it will not choose. See `follow.ts`.
     */
    ...(drawn.followed.length
      ? {
          movedTo: drawn.followed.map(
            (entry) => `${entry.ref} \u2014 ${entry.detail}`,
          ),
        }
      : {}),
    // Loud the turn it is written, which is the whole point of a closed
    // vocabulary: the author is still here, and a word no check can read
    // would otherwise sit on the board until somebody noticed the colour.
    ...(drawn.garbledClaims.length
      ? { garbledClaims: drawn.garbledClaims.map((finding) => finding.detail) }
      : {}),
    ...(drawn.workItems.length
      ? {
          plannedWork:
            `${drawn.workItems.length} planned ${drawn.workItems.length === 1 ? "item" : "items"} `
            + "tracked as work to do; each flips to built on its own when its code lands.",
        }
      : {}),
    ...unconfirmedArrowNote(drawn.unconfirmedEdges),
  };
}

server.registerTool(
  "create_diagram",
  {
    title: "Create diagram",
    description:
      "Lay out a graph into a .excalidraw file. Give nodes and edges, never coordinates: layout, "
      + "sizing, routing, and bindings are automatic. Replaces every diagram previously generated in "
      + "this file and keeps hand-drawn elements. "
      + "This is for drawing a board and for reworking its STRUCTURE -- boxes added or removed, a "
      + "subsystem redrawn. It is not how you make a small change, and reaching for it by habit is "
      + "expensive: re-sending a 34-node graph to correct four refs costs ~1,900 tokens to "
      + "communicate four short strings. Change a ref, a state, a claim or a colour with "
      + "edit_diagram, and change the layout flow with relayout_diagram; both leave the rest of the "
      + "board alone. Use delete_diagram to remove one, not a throwaway graph.",
    inputSchema: {
      path: z
        .string()
        .describe(
          `Inside this project's diagram directory — ${DEFAULT_DIAGRAM_DIR}/architecture.excalidraw, `
          + `unless ${CONFIG_FILE} names another. A path outside it is refused, because diagrams found `
          + "anywhere else are never checked for drift.",
        ),
      title: z.string().optional(),
      describes: z
        .enum(["repo", "concept"])
        .optional()
        .describe(
          "What the board is about. Omit for 'repo' (the default: it describes this codebase). "
          + "Use 'concept' when it describes a protocol, a standard, or another project — every box "
          + "is then excused from drift checking instead of reported as missing a ref. Needs a title, "
          + "since that is where it is recorded.",
        ),
      complete: z
        .string()
        .optional()
        .describe(
          "A directory this board asserts it shows completely: every module under it that the board "
          + "reaches — imported by a box, or importing one — has a box of its own. A module that "
          + "does not is then a finding rather than a suggestion, which is the only way this tool "
          + "can catch a diagram that is wrong by omission. Leave it off unless the user wants the "
          + "picture held to that; most boards should claim nothing. It is refused if a single box "
          + "already covers the whole directory, since nothing inside could ever come back missing.",
        ),
      nodes: z.array(nodeSchema).min(1),
      edges: z.array(edgeSchema).default([]),
      direction: z
        .enum(["RIGHT", "DOWN"])
        .optional()
        .describe(
          "Layout flow. RIGHT by default, and inherited from the board when it already records one, "
          + "so regenerating a board somebody turned DOWN does not quietly turn it back. To change "
          + "the flow of a board that already exists, call relayout_diagram instead of re-sending "
          + "this graph.",
        ),
      name: z.string().optional().describe("Element id prefix; from the title otherwise"),
      append: z
        .boolean()
        .default(false)
        .describe(
          "Add below what is there instead of replacing. Only when the user wants two diagrams in "
          + "one file; it makes node ids ambiguous across them. False removes EVERY generated "
          + "diagram here, not just a same-named one.",
        ),
    },
  },
  async ({ path: boardPath, title, describes, complete, nodes, edges, direction, name, append }) =>
    guard(async () => {
      // The one tool that decides where a diagram comes into existence, so the
      // one that has to be confined to the project's diagram directory.
      const file = resolveNewBoardPath(boardPath);
      if (describes === "concept" && !title?.trim()) {
        throw new Error(
          "A concept board needs a title: describes is recorded on the title element, which is the "
          + "only place that survives an edit in the live viewer.",
        );
      }
      // Same reason, same slot: a board-level claim lives on the title element,
      // so a board with no title has nowhere to keep it and would silently
      // claim nothing at all.
      if (complete?.trim() && !title?.trim()) {
        throw new Error(
          "A board claiming complete needs a title: the claim is recorded on the title element, "
          + "which is the only place that survives an edit in the live viewer.",
        );
      }
      // A concept board is not about this repository, so there is nothing under
      // a path in it to be complete about. Refused here rather than ignored at
      // check time, so the contradiction is answered while the author is present.
      if (complete?.trim() && describes === "concept") {
        throw new Error(
          "A concept board cannot claim complete: it describes something other than this codebase, "
          + "so there is no directory here for the claim to be about.",
        );
      }
      const board = await readBoard(file);
      const result = await createDiagram(board, {
        title,
        ...(describes ? { describes } : {}),
        ...(complete?.trim() ? { complete: complete.trim() } : {}),
        nodes,
        edges,
        name,
        append,
        ...(direction ? { layout: { direction } } : {}),
      });
      await writeBoard(file, result.board);
      await followBoard(file);
      // Say it now, not one turn later: a box pointing at code that does not
      // exist is either a typo or a plan that forgot to say so. Left alone,
      // the end-of-turn check reports it to the user in red; caught here, the
      // model can still fix the ref or mark the box planned before anyone
      // sees an alarm. The arrow pass runs in the same call and is reported
      // too -- see unconfirmedArrowNote for why that stopped being a review
      // matter the day the amber went away.
      await initEngine();
      const drawn = checkDrift(result.board, createWorkspace(WORKSPACE_ROOT), {
        trail: createGitTrail(WORKSPACE_ROOT),
      });
      // Named the turn it is written, because a claim nobody saw go on is a
      // claim nobody can refuse. The board shows it too; this is for whoever is
      // reading the transcript rather than the canvas.

      return text({
        wrote: relativeToWorkspace(file),
        nodes: result.nodeCount,
        edges: result.edgeCount,
        ...claimNote(edges),
        elements: result.elementCount,
        idPrefix: result.prefix,
        // Said out loud because it can be inherited rather than asked for, and
        // a setting that applied itself without saying so is one the caller
        // cannot tell from one that was ignored.
        direction: result.direction,
        ...drawTimeNotes(drawn),
        ...(result.replacedCount
          ? {
              replaced: { diagrams: result.replacedDiagrams, elements: result.replacedCount },
              ...(result.replacedDiagrams.length > 1
                ? {
                    warning:
                      `This board held ${result.replacedDiagrams.length} generated diagrams and all `
                      + "of them were replaced. If that was not intended, pass append: true.",
                  }
                : {}),
            }
          : {}),
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
        note: "Call render_diagram to see it.",
      });
    }),
);

server.registerTool(
  "read_diagram",
  {
    title: "Read diagram",
    description:
      "Read a board back as a semantic graph: nodes, edges, labels, and anything unattributed. "
      + "Each fact is marked recorded (drawn by this tool, exact) or inferred (hand-drawn, derived "
      + "from geometry). Every edge also says how its ends were resolved: declared or bound are "
      + "exact pointers to two shapes, nearest means an end was matched to whichever shape it landed "
      + "close to and may not be the one intended. A hand-drawn arrow bound at both ends is a precise "
      + "claim despite being inferred. Use this to treat a diagram as a specification. "
      + "A field sitting at its default is left out rather than repeated on every item; the response "
      + "opens with omittedWhenDefault, which says what each absence means. A state is built, planned "
      + "(drawn as intent, not written yet) or external (real, and not yours to change); nodes and "
      + "edges both carry one. No unattributed means the board has no strays. "
      + "Edit or delete by the node id listed here -- edit_diagram resolves it -- "
      + "and ask for geometry or includeElements if you need the raw Excalidraw elementId. "
      + "When the board has anchored refs, notShown describes what it leaves out: files drawn on sibling boards and files on no board. "
      + "A damaged block means the file contradicts itself and will not draw the way it reads -- the graph "
      + "below it is what the file says, not what anyone sees. Stop and repair the board rather than acting "
      + "on the rest of the response.",
    inputSchema: {
      path: z.string(),
      geometry: z
        .boolean()
        .default(false)
        .describe(
          "Add positions and sizes to each node and edge. Off by default because it doubles the "
          + "response and a question about the graph does not need it; turn it on to fix layout.",
        ),
      includeElements: z
        .boolean()
        .default(false)
        .describe(
          "Also list every element with its position, size, and colours -- what edit_diagram needs "
          + "to address one. Large on a big board; prefer the node and edge ids above where they "
          + "will do.",
        ),
    },
  },
  async ({ path: boardPath, geometry, includeElements }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const board = await readBoard(file);
      const graph = readGraph(board);
      const inferred = [...graph.nodes, ...graph.edges].filter((item) => item.provenance === "inferred");
      const diagrams = listDiagrams(board);
      // readGraph stays rich because the engine and its tests want the whole
      // picture. projectGraph is the narrower thing a model is charged for.

      // Compute honest gaps: what this board does not show. Defaults to silent.
      const notShown = await computeHonestGaps(
        board,
        file,
        WORKSPACE_ROOT,
        diagramDir(WORKSPACE_ROOT),
      );

      const projected = projectGraph(graph, {
        geometry,
        detailed: geometry || includeElements,
        notShown,
      });
      const { damaged, ...projection } = projected as { damaged?: unknown };

      return text({
        /*
         * Before the filename, before anything (#165).
         *
         * Everything else in this response was recovered by following one
         * direction of a binding, and this is the report that the other
         * direction disagrees -- so a reader that meets `nodes` first has
         * already been handed a complete, plausible, unusable answer. That is
         * what happened: 34 nodes, 44 edges, every label right, blank picture.
         */
        ...(damaged ? { damaged } : {}),
        file: relativeToWorkspace(file),
        /*
         * Which build drew this, and what it means.
         *
         * Always answered, including for a board that carries no stamp: the
         * absence is a reading rather than a gap, so saying `schema: 1,
         * drawnBy: "before boards were stamped"` tells a caller more than
         * leaving the field out, which reads as the tool having forgotten.
         */
        board: {
          schema: schemaOf(board.diagramos),
          drawnBy: board.diagramos?.version ?? "before boards were stamped",
        },
        ...projection,
        // Named here so a caller can address a single diagram (delete_diagram,
        // or create_diagram with append) without having to guess its name from
        // element id prefixes.
        ...(diagrams.length ? { diagrams } : {}),
        /*
         * Damage leads, because the summary is the one line a caller is certain
         * to read and "34 nodes, 44 edges" is a true sentence about a board that
         * draws nothing (#165).
         */
        summary: (graph.damage.length
          ? `DAMAGED FILE — ${graph.damage.length} broken `
            + `${graph.damage.length === 1 ? "connection" : "connections"}; `
            + "the graph below is what the file says, not what it draws. "
          : "")
          + `${graph.nodes.length} nodes, ${graph.edges.length} edges`
          + (inferred.length ? `, ${inferred.length} inferred from hand-drawn elements` : ""),
        ...(includeElements
          ? {
              elements: board.elements
                .filter((element) => element.isDeleted !== true)
                .map(projectElement),
            }
          : {}),
      });
    }),
);

server.registerTool(
  "check_drift",
  {
    title: "Check drift",
    description:
      "Do these diagrams still match the code? Compares each node's ref against the working tree "
      + "and reports the ones pointing at a file or symbol that is gone, and checks arrows for static "
      + "connections through imports, shared orchestrators, or route literals — unsupported ones are "
      + "worth a look, not wrong. Read-only, and cheap "
      + "enough to run whenever module structure changes. Nodes without a ref are skipped, "
      + "hand-drawn ones ignored, and edges touching refless nodes are skipped, so a clean report means "
      + "nothing checkable disagreed -- not that the diagram is correct. skippedWhy and edgesSkippedWhy "
      + "say what went unread, which is how you tell a verified diagram from an unreadable one. "
      + "A ref may also claim more than existence: path#symbol@declared asks that the file declare that "
      + "name, path#symbol@used that something there use it beyond its own declaration, and "
      + "@declared+used both -- which is how a box standing for a feature notices the feature being "
      + "gutted rather than deleted. TypeScript, TSX, JavaScript, Rust and Python; elsewhere the claim "
      + "falls "
      + "back to a plain mention and is counted in assertions. A route anchor (path#/api/board) instead "
      + "asks that the literal still be served by that file or one it imports; a file writing no route "
      + "literals at all is counted as unread rather than reported broken. When both ends of an arrow name symbols, the arrow is checked inside one function body rather than by imports — so an arrow drawn from the wrong function is caught. Give the arrow via: [...] when the call goes through named intermediaries, and a break reports which hop stopped holding. "
      + "A damaged entry is not drift: the board file contradicts itself and will not draw the way it "
      + "reads, so clean says nothing about it. Repair or restore that board before acting on anything "
      + "else in the response.",
    inputSchema: {
      path: z
        .string()
        .optional()
        .describe(
          `One board to check. Omit to check every board in this project's diagram directory `
          + `(${DEFAULT_DIAGRAM_DIR} unless ${CONFIG_FILE} says otherwise).`,
        ),
      coverage: z
        .boolean()
        .default(false)
        .describe(
          "Three questions the per-turn check does not ask. `unreadEdges` names the arrows nothing "
          + "checked, with the reason for each: an arrow with an end marked external, or refless, or "
          + "pointing at a directory carries no claim any check here can test, and until it is named "
          + "it is indistinguishable from an arrow that passed. It is not drift and not a suggestion "
          + "-- it is the list of things this tool did not look at. "
          + "`unannotated` names the boxes that claim to "
          + "be about this repo and carry no ref at all, with their labels -- these are invisible to "
          + "every other check, and naming them is what lets a ref be proposed for each. "
          + "`unrepresented` is the opposite direction: code no box covers, most-imported first. It "
          + "runs both ways round the import graph. A module the board's own ref'd files import "
          + "arrives with `importedBy`; an entry point that imports the board and that nothing "
          + "imports back -- a CLI, a hook, a browser main -- arrives with `imports` instead, and is "
          + "the case the first direction structurally cannot reach, so a board can be every-box-"
          + "anchored and clean while missing an entire surface. Test files are left out. Both are "
          + "suggestions, never drift -- they do not affect clean. Off by default because it walks "
          + "the repository's source files; ask for it when deciding what a diagram is missing or "
          + "when annotating one.",
        ),
    },
  },
  async ({ path: boardPath, coverage }) =>
    guard(async () => {
      const directory = diagramDir(WORKSPACE_ROOT);
      const files = boardPath
        ? [resolveBoardPath(boardPath)]
        : await findBoards(WORKSPACE_ROOT, directory);
      if (files.length === 0) {
        // Nothing checked is not a clean report. Name the boards elsewhere too:
        // "you have diagrams, just not where I looked" is the likeliest reason
        // to be here, and the caller cannot guess it from an empty answer.
        const strays = await findStrayBoards(WORKSPACE_ROOT, directory);
        return text({
          checked: 0,
          note: `No .excalidraw files in ${directory}. Nothing was checked -- this is not a clean report.`,
          ...(strays.boards.length
            ? {
                boardsElsewhere: strays.boards,
                ...(strays.more ? { andMore: strays.more } : {}),
                hint:
                  `Those are outside ${directory}, so they are never checked. Move them there, or set `
                  + `{"diagrams": "..."} in ${CONFIG_FILE}, or pass path to check one where it is.`,
              }
            : {}),
        });
      }

      const workspace = createWorkspace(WORKSPACE_ROOT);
      const totals = {
        checked: 0,
        skipped: 0,
        excused: 0,
        handDrawn: 0,
        edgesChecked: 0,
        edgesSkipped: 0,
      };
      // Why, not just how many: a caller cannot act on "5 skipped", and cannot
      // tell it apart from "nothing here was readable".
      const skippedWhy: Record<string, number> = {};
      const edgesSkippedWhy: Record<string, number> = {};
      // A `@declared` / `@used` claim that could not be judged still passes the
      // plain mention check, so silence about it would read as a pass.
      const assertions = { checked: 0, downgraded: 0, unsupportedLanguage: 0 };
      const tally = (into: Record<string, number>, from: Record<string, number | undefined>) => {
        for (const [reason, count] of Object.entries(from)) {
          if (count) into[reason] = (into[reason] ?? 0) + count;
        }
      };
      const findings: Array<Record<string, unknown>> = [];
      const deleted: Array<Record<string, unknown>> = [];
      const followed: Array<Record<string, unknown>> = [];
      const unrepresented: Array<Record<string, unknown>> = [];
      const undrawn: Array<Record<string, unknown>> = [];
      const completeUnproven: Array<Record<string, unknown>> = [];
      const unannotated: Array<Record<string, unknown>> = [];
      const unreadEdges: Array<Record<string, unknown>> = [];
      const edges: Array<Record<string, unknown>> = [];
      const garbledClaims: Array<Record<string, unknown>> = [];
      const closedBreaches: Array<Record<string, unknown>> = [];
      const closedUnproven: Array<Record<string, unknown>> = [];
      const workItems: Array<Record<string, unknown>> = [];
      const promotions: Array<Record<string, unknown>> = [];
      const conceptBoards: string[] = [];
      // Boards that contradict themselves. Kept per board rather than pooled:
      // the one thing a caller must do with this is open that file.
      const damaged: Array<{ board: string; summary: string; faults: BindingFault[] }> = [];
      // Grammars load once per process; everything below this line is synchronous.
      await initEngine();
      const codeGraph = createCodeGraphOption(WORKSPACE_ROOT);
      const ledger = createLedger(WORKSPACE_ROOT);
      // One trail for every board in the call: two diagrams pointing at the same
      // moved file then ask git about it once. Costs nothing until a box is
      // already a finding, so a clean run never touches it.
      const trail = createGitTrail(WORKSPACE_ROOT);
      for (const file of files) {
        const report = checkDrift(await readBoard(file), workspace, {
          coverage,
          trail,
          baseline: createGitBaseline(WORKSPACE_ROOT, file),
          ...(codeGraph ? { codeGraph } : {}),
          ...(ledger ? { ledger } : {}),
        });
        totals.checked += report.checked;
        totals.skipped += report.skipped;
        totals.excused += report.excused;
        totals.handDrawn += report.handDrawn;
        totals.edgesChecked += report.edgesChecked;
        totals.edgesSkipped += report.edgesSkipped;
        tally(skippedWhy, report.skippedWhy);
        tally(edgesSkippedWhy, report.edgesSkippedWhy);
        assertions.checked += report.assertions.checked;
        assertions.downgraded += report.assertions.downgraded;
        assertions.unsupportedLanguage += report.assertions.unsupportedLanguage;
        if (report.concept) conceptBoards.push(relativeToWorkspace(file));
        /*
         * Not a finding, and deliberately not folded into `clean` (#165).
         *
         * `clean` answers "has anything on this board stopped matching the
         * code", and nothing here is about the code. This is the file
         * disagreeing with itself, which makes every other answer in this
         * response -- including a clean one -- an answer about a board nobody
         * can see. It is carried first in the response for that reason.
         */
        const sentence = damageSentence(report.damage);
        if (sentence) {
          damaged.push({ board: relativeToWorkspace(file), summary: sentence, faults: report.damage });
        }
        // Named per finding rather than grouped: a caller acting on one needs to
        // know which file to redraw, and flat is cheaper than nesting.
        for (const finding of report.findings) {
          findings.push({ board: relativeToWorkspace(file), ...finding });
        }
        for (const finding of report.deleted) {
          deleted.push({ board: relativeToWorkspace(file), ...finding });
        }
        /*
         * Where the code behind a stale box went.
         *
         * Carried separately from `findings` rather than folded into them,
         * because the two say different things and a caller has to be able to
         * tell them apart: a finding is the board being wrong, and this is an
         * address the repository can state without anybody searching for it. A
         * suggestion merged into a finding would read as a repair.
         */
        for (const entry of report.followed) {
          followed.push({ board: relativeToWorkspace(file), ...entry });
        }
        for (const item of report.unannotated) {
          unannotated.push({ board: relativeToWorkspace(file), ...item });
        }
        for (const finding of report.unrepresented) {
          unrepresented.push({ board: relativeToWorkspace(file), ...finding });
        }
        /*
         * The same modules `unrepresented` would suggest, carried separately
         * because a claim changed who is speaking about them.
         *
         * Unconditional, unlike `unrepresented`: this is not the engine
         * volunteering an opinion about what to draw, it is the answer to an
         * assertion somebody wrote on the board, and the summary of it is
         * already a finding. Withholding the list behind `coverage` would name
         * a defect and hide what it consists of.
         */
        for (const finding of report.undrawn) {
          undrawn.push({ board: relativeToWorkspace(file), ...finding });
        }
        for (const gap of report.completeUnproven) {
          completeUnproven.push({ board: relativeToWorkspace(file), ...gap });
        }
        // Named only when asked. `edgesSkippedWhy` is the per-turn answer and
        // stays a count; the list behind it is for deciding what to fix, which
        // is the same moment `unannotated` is wanted, and it costs tokens on a
        // response that is otherwise read every turn.
        if (coverage) {
          for (const arrow of report.unreadEdges) {
            unreadEdges.push({ board: relativeToWorkspace(file), ...arrow });
          }
        }
        for (const finding of report.edges) {
          edges.push({ board: relativeToWorkspace(file), ...finding });
        }
        /*
         * The whole breach list, not just the summary in `findings`.
         *
         * The caller reading this is usually the one about to fix the boundary,
         * and "and 36 more imports do the same" is not something anybody can act
         * on. Unproven boxes come too: a claim nothing could check is exactly
         * what an agent must not read as a claim that passed.
         */
        for (const breach of report.closedBreaches) {
          closedBreaches.push({ board: relativeToWorkspace(file), ...breach });
        }
        for (const gap of report.closedUnproven) {
          closedUnproven.push({ board: relativeToWorkspace(file), ...gap });
        }
        // Carried whole, `detail` included: it names the vocabulary, and the
        // caller reading this is usually the one that wrote the bad word.
        for (const finding of report.garbledClaims) {
          garbledClaims.push({ board: relativeToWorkspace(file), ...finding });
        }
        for (const item of report.workItems) {
          workItems.push({ board: relativeToWorkspace(file), ...item });
        }
        for (const promotion of report.promotions) {
          promotions.push({ board: relativeToWorkspace(file), ...promotion });
        }
      }

      return text({
        boards: files.map((file) => relativeToWorkspace(file)),
        // First in the object, so a reader meets it before `clean`. A board
        // that renders blank can pass every check below this line.
        ...(damaged.length
          ? {
              damaged,
              damagedNote:
                "These board files contradict themselves, so they do not draw the way they read. "
                + "Nothing below is a claim about your code and `clean` does not cover it: the boards "
                + "named here could be checked, and the answer means nothing. Repair or restore them "
                + "before trusting any other result in this response.",
            }
          : {}),
        clean: findings.length === 0 && edges.length === 0 && deleted.length === 0
          && garbledClaims.length === 0,
        findings,
        edges,
        // A claim word nothing recognises. Not a disagreement with the code -- a
        // line on the board no check can read -- so it is named on its own.
        ...(garbledClaims.length ? { garbledClaims } : {}),
        // Every import into a `closed` box, where `findings` carries only the
        // worst one and a count. Fixing a boundary needs the list.
        ...(closedBreaches.length ? { closedBreaches } : {}),
        // Boxes nothing disproved and nothing could prove. Outside `clean`,
        // because the board is not wrong -- it is unchecked, which is a
        // different thing and has to read as one.
        ...(closedUnproven.length ? { closedUnproven } : {}),
        // Boxes the diagram stopped claiming, while their code is still here.
        // Uncommitted only: committing the board is what says it was deliberate.
        ...(deleted.length ? { deleted } : {}),
        /*
         * Stale boxes whose code the repository can place. Never part of
         * `clean`: every one of these is still a finding above.
         *
         * Two shapes, and the difference is the whole point. An entry with
         * `becomes` is an address to write, arrived at by git recording the move
         * or by the name being declared in exactly one file -- the two channels
         * that produced no wrong answer in 281 replayed cases. An entry with
         * `candidates` instead is the follower declining, and its `detail` says
         * why. Neither is an instruction: nothing here has edited anything, and
         * `docs/rebind-measurement.md` is why that restraint is deliberate.
         */
        ...(followed.length ? { followed } : {}),
        // Both are separate from `clean` on purpose: a planned box the code has
        // not reached is work, not drift, and a promotion is good news.
        ...(workItems.length ? { workItems } : {}),
        ...(promotions.length ? { promotions } : {}),
        ...(conceptBoards.length ? { conceptBoards } : {}),
        // What the code has that the diagram does not show. Suggestions about
        // what might be worth drawing, so deliberately outside clean.
        ...(unannotated.length ? { unannotated } : {}),
        ...(unrepresented.length ? { unrepresented } : {}),
        // A claimed-complete board that is not. Inside clean, unlike the two
        // above: the author asserted this, so it is a broken claim rather than
        // a suggestion about what might be worth drawing.
        ...(undrawn.length ? { undrawn } : {}),
        ...(completeUnproven.length ? { completeUnproven } : {}),
        ...(unreadEdges.length ? { unreadEdges } : {}),
        ...(Object.keys(skippedWhy).length ? { skippedWhy } : {}),
        ...(Object.keys(edgesSkippedWhy).length ? { edgesSkippedWhy } : {}),
        ...(assertions.checked || assertions.downgraded || assertions.unsupportedLanguage
          ? { assertions }
          : {}),
        ...totals,
        // "clean: true, checked: 0" reads as a pass when nothing was examined,
        // so say which it was -- and distinguish "nobody annotated these" from
        // "these boards are not about this repo", which is not a gap to fill.
        ...(totals.checked === 0
          ? {
              note: totals.excused > 0 && totals.skipped === 0
                ? `Nothing to check: ${totals.excused} nodes are outside this repo by declaration. `
                  + "This is not drift and needs no action."
                : "No node carried a ref, so nothing was compared against the code. Set ref on nodes "
                  + "that stand for a file or module when regenerating these diagrams, or mark the "
                  + "board describes: \"concept\" if it is not about this codebase.",
            }
          : {}),
      });
    }),
);

server.registerTool(
  "render_diagram",
  {
    title: "Render diagram",
    description:
      "Rasterise a board to PNG and return the image, so you can look at the result and judge "
      + "layout, overlap, and readability directly rather than inferring them from the data. "
      + "One look after the diagram is finished is usually enough; rendering after every tweak "
      + "costs an image each time.",
    inputSchema: {
      path: z.string(),
      // Scale 1 is legible enough to judge layout and overlap, and costs less
      // than half of scale 2. Raise it only to inspect something specific.
      scale: z.number().min(1).max(3).default(1),
    },
  },
  async ({ path: boardPath, scale }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const png = await renderBoardToPng(await readBoard(file), { scale });
      return {
        content: [
          { type: "text" as const, text: `${relativeToWorkspace(file)} (${(png.byteLength / 1024).toFixed(0)} KB)` },
          { type: "image" as const, data: png.toString("base64"), mimeType: "image/png" },
        ],
      };
    }),
);

server.registerTool(
  "connect_nodes",
  {
    title: "Connect nodes",
    description:
      "Draw bound arrows between shapes that already exist, hand-drawn ones included. Each end is a "
      + "node id or an element id; arrows attach to the perimeter and stay attached when shapes "
      + "move. For a diagram you are generating, pass edges to create_diagram instead so the layout "
      + "routes them.",
    inputSchema: {
      path: z.string(),
      connections: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            label: z.string().optional(),
            bidirectional: z.boolean().optional(),
            claim: z
              .enum(["needs", "feeds", "takes", "returns"])
              .optional()
              .describe(
      "What this arrow asserts, when it asserts anything. Four words, and an arrow may carry one. "
      + "'needs': the from end declares a dependency on the to end — an import, a require, an "
      + "include. Write it ONLY when you have read that line in the code: it is a transcription of "
      + "something you saw, never a guess about what the relationship probably is. Shown on the "
      + "board as @needs and recorded, and CHECKED: if the dependency runs the other way and only "
      + "the other way, the arrow is reported as backwards, by file and line, and the build fails. "
      + "So a needs you guessed at is not a harmless decoration -- it is a false statement read "
      + "back to the user, on their diagram, in red. "
      + "'feeds': the from end's RESULT goes into the to end -- the pipeline arrow, which is a "
      + "different fact and often points the opposite way from the import. Confirmed by finding "
      + "the flow written down somewhere a person can read it: one function binding the first "
      + "call's result and passing it to the second, or handing it straight over. It CANNOT fail "
      + "-- a value can reach the other end through a callback or a field no reader follows, so "
      + "not finding the flow is never held against the arrow, and there is no red for it. Both "
      + "ends must anchor a symbol (path#symbol), because a file has no result. "
      + "'takes' and 'returns': the TO end is a function and the FROM end is a type, and the "
      + "arrow says that function's signature names that type -- 'takes' for a parameter, "
      + "'returns' for the return type. This is the ordinary shape of a typed diagram (struct "
      + "Request -> handler(&Request)) and neither needs nor feeds is true of it. Both are "
      + "CHECKED and both can fail: a function's parameters and return type can be listed in "
      + "full, so a type absent from both is genuinely absent, and the arrow is reported in red "
      + "with the signature quoted. Two words rather than one so the arrow's direction still "
      + "means something -- claim the wrong half and you get told the type is on the other side "
      + "rather than a red. Nothing is reported either way when the type would have to be "
      + "recognised under another name (a type alias, an import renamed on the way in): a "
      + "signature that could be hiding it proves nothing, so the check withholds instead of "
      + "accusing. The TO end must anchor a symbol and the FROM end must name the type. "
      + "A relationship you cannot point at is an arrow with no claim, which is fine and is what "
      + "most arrows are: an unclaimed arrow is looked for and counted, never judged, so it cannot "
      + "come back as a finding against you. "
      + "Both rules are about arrows that exist. On a state:'planned' arrow there is nothing to "
      + "read yet, so a claim there is a specification of what will be true once built; nothing "
      + "checks it until the code lands and the arrow promotes, so writing it there costs nothing "
      + "and accuses nobody.",
              ),
          }),
        )
        .min(1),
    },
  },
  async ({ path: boardPath, connections }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const { board, created } = await connectNodes(await readBoard(file), connections);
      await writeBoard(file, board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        arrows: created,
        ...claimNote(connections),
      });
    }),
);

server.registerTool(
  "edit_diagram",
  {
    title: "Edit diagram",
    description:
      "Change a few things on a board without redrawing it. This is the cheap path and the one to "
      + "reach for first: correcting four refs here costs four short strings, where re-sending the "
      + "graph to create_diagram costs ~1,900 tokens on a 34-node board. "
      + "Patches and deletes elements by id, hand-drawn ones included. Use it to re-anchor a box "
      + "(ref, refs), change what it claims to exist (state), assert or drop a closed boundary, and "
      + "to move, resize or recolour anything. Everything you do not mention stays as it was, so a "
      + "ref correction cannot silently unsay a box's state or its second anchor. "
      + "The id can be a node id from read_diagram or a raw Excalidraw element id; a real element id "
      + "wins if something is called both. Deleting a shape takes its bound label. Read the board "
      + "first; change only what must change. "
      + "Two things this cannot do: change the layout flow, which is relayout_diagram, and add or "
      + "remove boxes, which is create_diagram. A label change is possible but only re-letters the "
      + "text -- the box is not re-measured, so a much longer word wants a redraw.",
    inputSchema: {
      path: z.string(),
      updates: z
        .array(
          z
            .object({
              id: z.string().describe("A node id from read_diagram, or a raw element id"),
              ref: z
                .string()
                .optional()
                .describe(
                  "Re-anchor this box at different code, in the same form create_diagram takes. "
                  + 'Pass "" to remove the anchor. This is the one edit worth making by hand: it is '
                  + "how a box wrongly anchored at a bundle of siblings gets pointed at the thing it "
                  + "actually stands for, and the drift check reads the new anchor immediately.",
                ),
              refs: z
                .array(z.string())
                .optional()
                .describe("Replace the further anchors on this box. An empty array removes them."),
              state: z
                .enum(["planned", "built", "external"])
                .optional()
                .describe(
                  "Change what this box or arrow claims about existing. The stroke is redrawn to "
                  + "match, so the picture and the record cannot disagree.",
                ),
              closed: z
                .object({ through: z.array(z.string()).optional() })
                .nullable()
                .optional()
                .describe(
                  "Assert, or with null drop, the closed-boundary claim on a box anchored at a "
                  + "directory. Checked exactly as it is when written by create_diagram.",
                ),
            })
            .passthrough(),
        )
        .default([])
        .describe(
          'Anchors: {"id":"api","ref":"src/api/server.ts"}. '
          + 'Anything else is an Excalidraw property: {"id":"api","backgroundColor":"#ffec99","width":220}.',
        ),
      deletes: z.array(z.string()).default([]),
    },
  },
  async ({ path: boardPath, updates, deletes }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const result = applyEdits(await readBoard(file), updates, deletes);
      await writeBoard(file, result.board);
      await followBoard(file);
      /*
       * An arrow gains its anchors from the boxes at its ends, and a box gains
       * its ref here as often as at creation -- an edit is how a ref gets
       * corrected. So the same draw-time answer is owed here, and withholding
       * it would mean the tool that *changes* an anchor is the one tool silent
       * about anchoring.
       *
       * Guarded rather than unconditional, because this tool is mostly used to
       * move and recolour things and a whole drift check on every nudge would
       * be paid for nothing. `customData` is the only route to a ref, a state
       * or a claim, so its presence in a patch is an exact test for "this edit
       * could have changed what the check reads" -- not a heuristic.
       */
      const touchedAnchors = updates.some((update) => {
        const { props } = update as { props?: unknown };
        const payload = (props && typeof props === "object" ? props : update) as Record<string, unknown>;
        // The named words joined `customData` here the day they existed. The
        // guard is still an exact test rather than a heuristic -- these are the
        // only routes to a ref, a state or a claim -- and leaving them out
        // would have made the tool silent about anchoring exactly when the
        // anchoring got easy enough to be used.
        return payload.customData !== undefined
          || payload.ref !== undefined
          || payload.refs !== undefined
          || payload.state !== undefined
          || payload.closed !== undefined;
      });
      let notes: Record<string, unknown> = {};
      if (touchedAnchors && result.updated.length) {
        await initEngine();
        notes = drawTimeNotes(checkDrift(result.board, createWorkspace(WORKSPACE_ROOT), {
          trail: createGitTrail(WORKSPACE_ROOT),
        }));
      }
      return text({
        wrote: relativeToWorkspace(file),
        updated: result.updated,
        deleted: result.deleted,
        ...(result.skipped.length ? { skipped: result.skipped, note: "No element has these ids." } : {}),
        ...notes,
      });
    }),
);

server.registerTool(
  "relayout_diagram",
  {
    title: "Re-lay out diagram",
    description:
      "Lay a board out again in a different flow, without re-sending the graph. Layout is the one "
      + "thing this tool decides on its own, and the graph is already recorded in the file, so this "
      + "costs a word where create_diagram costs every node and every edge -- ~1,900 tokens on a "
      + "34-node board for a change whose whole content is RIGHT or DOWN. "
      + "Trying a layout after seeing a board for the first time is the most reasonable thing there "
      + "is, and it needs no judgement about the code at all: use this rather than settling for the "
      + "first layout because a redraw felt expensive. "
      + "Every box keeps its id, ref, state, claims, colour and label, and arrows drawn with "
      + "connect_nodes are carried across and re-routed; hand-drawn elements are not moved. The "
      + "flow is recorded on the board, so a later regenerate does not revert it.",
    inputSchema: {
      path: z.string(),
      direction: z
        .enum(["RIGHT", "DOWN"])
        .optional()
        .describe(
          "The flow to lay out in. RIGHT suits most architecture; DOWN suits a sequence or a "
          + "pipeline, and is worth trying when a board sprawls sideways or its connectors run long. "
          + "Omit only to re-run a board that already records a flow; one drawn before flows were "
          + "recorded says nothing about it, and is refused rather than laid out in the default.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Which diagram, as reported by read_diagram. Only needed when a board holds more than "
          + "one; with one it is unambiguous and is refused rather than guessed with several.",
        ),
    },
  },
  async ({ path: boardPath, direction, name }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const result = await relayoutDiagram(await readBoard(file), {
        ...(direction ? { direction } : {}),
        ...(name ? { name } : {}),
      });
      await writeBoard(file, result.board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        diagram: result.name,
        direction: result.direction,
        nodes: result.nodeCount,
        edges: result.edgeCount,
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
        ...(result.connectors ? { connectorsRerouted: result.connectors } : {}),
        /*
         * Three sentences, and each is a different fact the caller cannot see.
         *
         * A no-op reads exactly like a re-layout that did something, so it says
         * when nothing moved. And a flow that could not be written down is a
         * setting that will silently revert on the next redraw, which is worse
         * than one that says it did not stick.
         */
        ...(result.wasDirection === undefined
          ? {
              note:
                "This board had not recorded a flow, so it does not say what it was laid out in "
                + `before; it is ${result.direction} now and says so. Call render_diagram to see it.`,
            }
          : result.direction === result.wasDirection
            ? { note: `Already laid out ${result.direction}; nothing moved. Call render_diagram to see it.` }
            : { note: `Was ${result.wasDirection}. Call render_diagram to see it.` }),
        ...(result.remembered
          ? {}
          : {
              warning:
                "This board has no title element, which is where the flow is recorded, so nothing "
                + "remembers it: the next create_diagram on this board will lay it out RIGHT again. "
                + "Give the board a title to make it stick.",
            }),
      });
    }),
);

server.registerTool(
  "delete_diagram",
  {
    title: "Delete diagram",
    description:
      "Remove a generated diagram, or all of them when name is omitted. Always keeps hand-drawn "
      + "elements and any arrow that still has both ends. Use this to delete: not a throwaway "
      + "regenerate, not a list of element ids in edit_diagram.",
    inputSchema: {
      path: z.string(),
      name: z
        .string()
        .optional()
        .describe("As reported by read_diagram. Omit to remove every generated diagram in the file."),
    },
  },
  async ({ path: boardPath, name }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const result = deleteDiagram(await readBoard(file), name);
      await writeBoard(file, result.board);
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        deleted: result.deleted,
        elementsRemoved: result.deletedElements,
        ...(result.remaining.length ? { remainingDiagrams: result.remaining } : {}),
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
      });
    }),
);

server.registerTool(
  "place_image",
  {
    title: "Place image",
    description:
      "Put an image from the workspace onto the board -- a screenshot of what you built, beside the "
      + "diagram that specified it. Placing the same file again updates it in place.",
    inputSchema: {
      path: z.string().describe("Board file"),
      image: z.string().describe("Image file in the workspace"),
      width: z.number().optional(),
    },
  },
  async ({ path: boardPath, image, width }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const imageFile = resolveInWorkspace(image);
      const mime = IMAGE_MIME_BY_EXT[path.extname(imageFile).toLowerCase()];
      if (!mime) throw new Error(`Unsupported image type: ${path.extname(imageFile) || "(none)"}`);
      const data = await readFile(imageFile);
      if (data.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${relativeToWorkspace(imageFile)} exceeds 4 MB; use a smaller image`);
      }

      const board = await readBoard(file);
      const live = board.elements.filter((element) => element.isDeleted !== true);
      const bottom = live.reduce(
        (lowest, element) => Math.max(lowest, (Number(element.y) || 0) + (Number(element.height) || 0)),
        0,
      );
      const naturalWidth = data.byteLength >= 24 && mime === "image/png" ? data.readUInt32BE(16) : 800;
      const naturalHeight = data.byteLength >= 24 && mime === "image/png" ? data.readUInt32BE(20) : 600;
      const renderWidth = Math.min(960, Math.max(120, width ?? Math.min(640, naturalWidth)));
      const renderHeight = Math.max(80, Math.round(renderWidth * (naturalHeight / Math.max(1, naturalWidth))));

      const fileId = imageElementId(relativeToWorkspace(imageFile));
      // Placing the same image twice used to append a second element carrying
      // the id the first one already had, and convertSkeletons only checks for
      // duplicates inside its own batch. Two ids alike is a corrupt scene, so a
      // repeat placement updates what is there instead of stacking onto it.
      const existing = board.elements.find((element) => String(element.id) === fileId);
      const elements = existing
        ? board.elements.map((element) =>
            String(element.id) === fileId
              ? {
                  ...element,
                  // Position is deliberately left alone: the user may have moved
                  // the image, and re-placing it should not drag it back.
                  width: renderWidth,
                  height: renderHeight,
                  isDeleted: false,
                  version: (Number(element.version) || 1) + 1,
                }
              : element,
          )
        : [
            ...board.elements,
            ...(await (await import("../engine/convert")).convertSkeletons(
              [
                {
                  id: fileId,
                  type: "image",
                  fileId,
                  x: 0,
                  y: bottom + 120,
                  width: renderWidth,
                  height: renderHeight,
                },
              ],
              { origin: "image" },
            )),
          ];

      await writeBoard(file, {
        ...board,
        elements,
        files: {
          ...board.files,
          [fileId]: {
            id: fileId,
            mimeType: mime,
            dataURL: `data:${mime};base64,${data.toString("base64")}`,
            created: 0,
          },
        },
      });
      await followBoard(file);
      return text({
        wrote: relativeToWorkspace(file),
        placed: relativeToWorkspace(imageFile),
        ...(existing ? { replacedInPlace: fileId } : { elementId: fileId }),
        size: `${renderWidth}x${renderHeight}`,
      });
    }),
);

server.registerTool(
  "new_board",
  {
    title: "New board",
    description: "Create an empty board file, or empty an existing one. Use only when starting over.",
    inputSchema: { path: z.string() },
  },
  async ({ path: boardPath }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      await writeBoard(file, emptyBoard());
      await followBoard(file);
      return text({ wrote: relativeToWorkspace(file), elements: 0 });
    }),
);

server.registerTool(
  "board_status",
  {
    title: "Board status",
    description:
      "Whether a live board is running, which boards are open and the URL of each. Check before "
      + "telling the user where to look, and before assuming the live view exists.",
    inputSchema: {},
  },
  async () =>
    guard(async () => {
      // Ask the registry, then the service: the board never belongs to this
      // process, and the port it is on is not fixed.
      const service = await currentService();
      const serving = service?.probe.file;
      if (!service || serving === undefined) {
        return text({
          running: false,
          note: "No live board. Call open_board to start one; every other tool works without it.",
        });
      }
      const { port, probe } = service;
      // Every board with a page of its own, so the model can say which URL shows
      // what instead of handing over one address for several diagrams.
      const open = (probe.boards ?? [serving]).map((file) => ({
        file: relativeToWorkspace(file),
        url: pinnedBoardUrl(port, file),
      }));
      return text({
        running: true,
        boards: open,
        // The bare URL, which follows whichever board was opened or written last.
        followUrl: `http://127.0.0.1:${port}/`,
        // The page listing every board this service can show, with a stop button.
        // Worth handing over: it is the answer for someone who will never type a
        // command to find out what is running.
        allBoardsUrl: `http://127.0.0.1:${port}/boards`,
        showing: relativeToWorkspace(serving),
        // The service outlives this session on purpose, so "is it ours" is not a
        // useful thing to report any more; where it came from is.
        pid: probe.pid,
        startedBy: probe.startedBy,
        stopWith: "diagramos stop --list shows every board service; diagramos stop stops them",
      });
    }),
);

server.registerTool(
  "open_board",
  {
    title: "Open live board",
    description:
      "Open the board in a live local page. It updates the moment any tool writes the file, and "
      + "what the user draws is saved back, so you both edit the same board. Returns a URL pinned to "
      + "this board: several can be open at once and each stays on its own diagram, so opening a "
      + "second one does not disturb a page the user is watching. One background service serves them "
      + "all, and it outlives this session -- the board is still there afterwards, and `diagramos "
      + "stop` is what ends it. Prefer it to a shell command.",
    inputSchema: {
      path: z.string(),
      open: z.boolean().default(true).describe("Also launch the system browser"),
    },
  },
  async ({ path: boardPath, open }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      // Make sure the file exists before watching it, or a brand-new board
      // shows the viewer an error until something writes.
      await writeBoard(file, await readBoard(file));

      /*
       * Ask for a board service; do not become one.
       *
       * Hosting the server in this process is what made a board die with the
       * session that opened it: quitting Claude took the MCP server down and the
       * board with it, and letting go without quitting left it serving where
       * nobody could see it. The service is spawned detached instead, so the
       * board is still there afterwards -- and is in the registry, so
       * `diagramos stop` can find it. Surviving invisibly was the leak; surviving
       * where you can see it is the feature.
       */
      const service = await ensureBoardServer({
        root: WORKSPACE_ROOT,
        port: boardPort(),
        file,
        startedBy: "a Claude session (open_board)",
      });
      servicePort = service.port;
      const url = pinnedBoardUrl(service.port, file);
      // Keep the bare URL on this board too, so a page opened without one still
      // shows what was asked for last. Pinned pages are untouched by design.
      await followBoard(file);

      if (open) {
        const { spawn } = await import("node:child_process");
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        spawn(command, [url], { detached: true, stdio: "ignore" }).unref();
      }
      return text({
        url,
        file: relativeToWorkspace(file),
        note: "Live. Edits in the page and edits from these tools both land in the file.",
      });
    }),
);

async function main(): Promise<void> {
  // Warm the converter so the first create_diagram is not the one that pays
  // for parsing the bundle.
  void loadConverter().catch(() => undefined);
  await server.connect(new StdioServerTransport());
  // stdout is the protocol channel; diagnostics must go to stderr.
  console.error(`diagramos MCP server ready (workspace: ${WORKSPACE_ROOT})`);
}

main().catch((error) => {
  console.error("board MCP server failed to start:", error);
  process.exit(1);
});
