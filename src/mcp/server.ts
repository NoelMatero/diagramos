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
  applyDescribes,
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
  pointsAtLines,
  UNCONFIRMED_WORDS,
  type UnconfirmedEdge,
} from "../engine/drift";
import { createGitTrail, type FollowedRef } from "../engine/follow";
import { computeHonestGaps } from "../engine/gaps";
import { loadConverter } from "../engine/convert";
import { initEngine } from "../engine/parse";
import { renderBoardToPng } from "../engine/render";
import { surveyScope } from "../engine/survey";
import { NODE_FONT_SIZE } from "../engine/layout";
import type { ViewabilityReport } from "../engine/viewable";
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

/**
 * What an arrow's claim asserts, for create_diagram and connect_nodes alike.
 *
 * Short on purpose (#288): a small model read the ~6,000-character version
 * and still got the basics wrong. The reasons behind each word live in
 * docs/claim-vocabulary.md and docs/drawing-guide-long.md.
 */
const CLAIM_DESCRIPTION =
  "Optional; most arrows carry none. Write one ONLY from code you read. Both ends name a symbol "
  + "(path#symbol) unless noted. "
  + "needs: from imports to (ends may be files); red if the import runs only the other way. "
  + "feeds: from's result goes into to; never red. "
  + "takes / returns: from is a TYPE, to is a FUNCTION whose parameter / return type it is; red if "
  + "absent from the signature. "
  + "holds: from is a type with a field of type to; red if no field has it. "
  + "builds: from makes a value of type to; red only if the arrow is backwards. "
  + "calls: from calls to; red only if the arrow is backwards. "
  + "accesses: from reads member of type to, and the member name goes in label; red if the type "
  + "lacks it. "
  + "conforms: from extends or implements to (subtype first); red in Python and TypeScript if the "
  + "base is not listed, never in Rust. "
  + "On a planned arrow a claim is checked only once the code lands.";

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
      "The code this box stands for: a file (src/a.ts), a symbol in it (src/a.ts#name), a "
      + "directory (src/engine/), a symbol inside one (src/engine/#Name), a glob in one directory "
      + "(src/engine/*.ts), or an endpoint (src/server.ts#/api/board). After # goes ONE plain name as "
      + "the code spells it (#dispatch): never line numbers (#578-636, :254) and never a qualified "
      + "path (#Server::dispatch). Never build output (target/, dist/, out/). "
      + "Leave it off only with state planned or external. A symbol may end @declared (declared "
      + "here), @used (used here) or @declared+used, written ONLY from the file you read.",
    ),
  refs: z
    .array(z.string())
    .optional()
    .describe(
      "More anchors when one box stands for several things. Each is checked; arrows use ref.",
    ),
  closed: z
    .object({
      through: z
        .array(z.string())
        .optional()
        .describe(
          "Files inside the directory that outside code may import. Empty: total isolation.",
        ),
    })
    .optional()
    .describe(
      "Only on a box whose ref is a directory: nothing outside imports into it except through "
      + "`through`. Checked against every file; one outside import is red (tests are counted "
      + "apart). Check check_drift's closedBreaches before claiming it.",
    ),
  handles: z
    .array(z.string())
    .optional()
    .describe(
      "Only on a box whose ref names one routine (path#symbol) that dispatches on fixed cases "
      + "(a match, a switch). List EVERY case, from the arms you read. Red when the code has a case "
      + "the list lacks, or the reverse.",
    ),
  state: z
    .enum(["planned", "built", "external"])
    .optional()
    .describe(
      "Omit for built. planned: meant to exist, drawn dashed; its ref is work to do, and it "
      + "turns built on its own when the code lands. external: real but not code in this repo (a "
      + "browser, a database), drawn dotted; its ref, if any, is the routine here that talks to it.",
    ),
});

const edgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  via: z
    .array(z.string())
    .optional()
    .describe(
      "Named hops between from and to, when the route matters: ['handle_logging', 'emit']. A "
      + "break names the hop. Both ends must name symbols.",
    ),
  claim: z
    .enum(["needs", "feeds", "takes", "returns", "holds", "builds", "calls",
      "accesses", "conforms"])
    .optional()
    .describe(
      CLAIM_DESCRIPTION,
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
      "Omit for built. planned: wiring still to do, drawn dashed.",
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
  builds:
    " Each one is now read out of the tail's own routines: `new X`, `X { .. }` and `<X />` all"
    + " count. Finding the construction confirms the arrow. NOT finding it is never held against"
    + " it -- a factory one call away is invisible to this, so there is no red for an absence."
    + " What does get reported is finding the construction at the FAR end and only there, which"
    + " means the arrow is drawn backwards. Python gets no verdict either way: it spells making"
    + " one of something as an ordinary call.",
  holds:
    " Each one is now read off the field list of the FROM end -- the opposite end from takes,"
    + " because containment points whole to part: if no field of the from end's type is of the to"
    + " end's type, the arrow is reported in red with the fields quoted. Generic wrappers are read"
    + " through, so Vec<T>, Promise<T> and Optional[T] all confirm. Nothing is reported either way"
    + " when a field's type could be written under another name, including a Python annotation"
    + " written as a string.",
  calls:
    " Each one is now read out of the tail's own body, and the called name is traced back to the"
    + " file it came from -- through a barrel or a re-export if there is one. Finding the call"
    + " confirms the arrow. NOT finding it is never held against it: a callback or a dispatch"
    + " table is invisible to this, so there is no red for an absence. What does get reported is"
    + " finding the call at the FAR end and only there, which means the arrow is drawn backwards."
    + " Nothing is reported either way when the name cannot be placed -- a method on a value whose"
    + " type is not written down, a wildcard import, a name from a package.",
  conforms:
    " Each one is now read off the base list of the FROM end -- the subtype first. In Python and"
    + " TypeScript that list is written in the declaration and can be read in full, so a type"
    + " absent from it is genuinely absent: the arrow is reported in red with the bases quoted,"
    + " and if the other end turns out to be the subtype it says the arrow is the right fact"
    + " drawn backwards. Type arguments are not bases, so extends Cache<Entry> says nothing about"
    + " Entry. Rust confirms and can never fail: impl Trait for Type may sit in any file in the"
    + " crate, so a struct with no impl beside it is reported unread rather than wrong. Nothing is"
    + " reported either way when a base could stand for another name or is an expression.",
  accesses:
    " Each one is now read at both ends, and only one of them can say wrong. If the TO end's type"
    + " does not declare the member named on the arrow's label, the arrow is reported in red with"
    + " the member list quoted -- a member list can be read in full, so a name absent from it is"
    + " genuinely absent. The FROM end can never be a red: not seeing the routine read the member"
    + " is not evidence it does not, so it is silence. A green needs both halves. Nothing is"
    + " reported either way when the member list is not closed -- a type with a parent, an index"
    + " signature, a Python __getattr__, an alias, or a Rust impl block in another file.",
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
          + "answer instead -- unless the other end is in that same file, where file level "
          + "leaves nothing to check."
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
  conceptAnchored?: number;
  conceptBoxes?: number;
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
  // Not a typo and not a plan: the code is there, the pointer can never reach
  // it. The finding's detail already says what to write instead (#286).
  const lines = drawn.findings.filter(pointsAtLines);
  const missing = drawn.findings.filter(
    (finding) => finding.kind !== "generated-ref" && !pointsAtLines(finding),
  );
  return {
    // First, because it decides whether anything below was checked at all (#287).
    ...(drawn.conceptAnchored
      ? {
          conceptPointsHere:
            `This board is marked concept, which checks nothing, but ${drawn.conceptAnchored} of its `
            + `${drawn.conceptBoxes ?? drawn.conceptAnchored} boxes point at code in this repo. Concept is `
            + "only for a board about something outside this repo. If this board is about this code, "
            + 'call edit_diagram with describes: "repo".',
        }
      : {}),
    ...(lines.length
      ? {
          pointsAtLineNumbers: lines.map(
            (finding) => `${finding.label || finding.node} → ${finding.ref}: ${finding.detail}`,
          ),
        }
      : {}),
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

/**
 * Whether the board just laid out can be looked at, said before anyone renders.
 *
 * Two fields, and both are cheap. `size` is one short string on every draw,
 * because a caller that knows the board is 9,637px wide already knows something
 * a render was previously the only way to learn. `viewable` carries the verdict,
 * and it is a sentence only when there is something wrong -- a healthy board
 * gets six words.
 *
 * This is the whole of #183. The session that provoked it drew a board, rendered
 * it, re-laid it out, rendered it again, split it, and rendered a third time --
 * $1.94 to discover, at the end, that a 46-node graph does not fit sideways.
 * Every one of those calls was asking the question this answers for free.
 */
function viewableNotes(view: ViewabilityReport): Record<string, unknown> {
  return {
    size: `${view.width}x${view.height}`,
    viewable: !view.note
      ? `legible \u2014 renders whole at scale ${view.scale}, labels ${view.labelPx}px`
      // A note on a legible board is the engine explaining a flow it chose, not
      // a complaint, so it is not shouted at.
      : view.verdict === "legible"
        ? view.note
        : `${view.verdict.toUpperCase()} \u2014 ${view.note}`,
  };
}

server.registerTool(
  "create_diagram",
  {
    title: "Create diagram",
    description:
      "Draw a board from nodes and edges; layout is automatic, never pass coordinates. Replaces "
      + "what this tool drew in the file before and keeps hand-drawn elements. Use it to draw a "
      + "board or change its structure; for a ref, state, claim or colour use edit_diagram, and "
      + "for the flow use relayout_diagram. "
      + "READ THE RESPONSE and fix what it names in this turn: pointsAtNothing (a typo, or mark "
      + "the box planned), pointsAtLineNumbers, pointsAtBuildOutput, conceptPointsHere, "
      + "garbledClaims. It also says whether the board is legible, so do not render to find out.",
    inputSchema: {
      path: z
        .string()
        .describe(
          `A file in ${DEFAULT_DIAGRAM_DIR}/ (or the directory ${CONFIG_FILE} names), e.g. `
          + `${DEFAULT_DIAGRAM_DIR}/architecture.excalidraw. Anywhere else is refused.`,
        ),
      title: z.string().optional(),
      describes: z
        .enum(["repo", "concept"])
        .optional()
        .describe(
          "What the board is about. Omit it for a board about this codebase, which is almost every "
          + "board. 'concept' is only for a protocol, a standard, or another project: nothing on a "
          + "concept board is checked. A flow through this codebase is not a concept board, and "
          + "concept is not a way to silence findings -- fix the refs instead. Needs a title. "
          + 'Change it later with edit_diagram\'s describes.',
        ),
      complete: z
        .string()
        .optional()
        .describe(
          "A directory this board claims to show completely: every module there that the board "
          + "reaches must have a box, or it is a finding. Leave it off unless the user asks. Needs "
          + "a title.",
        ),
      nodes: z.array(nodeSchema).min(1),
      edges: z.array(edgeSchema).default([]),
      direction: z
        .enum(["RIGHT", "DOWN"])
        .optional()
        .describe(
          "Leave it off on a first draw: the flow that reads is picked by measurement. An existing "
          + "board keeps its recorded flow; change that with relayout_diagram.",
        ),
      name: z.string().optional().describe("Element id prefix; from the title otherwise"),
      append: z
        .boolean()
        .default(false)
        .describe(
          "Add below instead of replacing, only for two diagrams in one file. False replaces every "
          + "diagram this tool drew here.",
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
        ...viewableNotes(result.viewable),
        /*
         * "Call render_diagram to see it" is wrong advice on a board that cannot
         * be seen, and it was the advice that cost $1.94: the picture comes back
         * illegible, the layout gets judged from it anyway, and the next call is
         * another draw. On an unviewable board the next move is the fix, not the
         * photograph.
         */
        note: result.viewable.verdict === "unviewable"
          ? "Do not render this yet -- fix the layout first, per viewable above."
          : "Call render_diagram to see it.",
      });
    }),
);

server.registerTool(
  "read_diagram",
  {
    title: "Read diagram",
    description:
      "Read a board as a graph: nodes, edges, labels and anything unattributed. Each fact is "
      + "recorded (drawn by a tool) or inferred (read off a hand drawing). Fields at their default "
      + "are left out; omittedWhenDefault says what each absence means. Edit by the node ids given "
      + "here. notShown lists code the board leaves out. If the response has a damaged block, stop "
      + "and repair the board before acting on the rest.",
    inputSchema: {
      path: z.string(),
      geometry: z
        .boolean()
        .default(false)
        .describe(
          "Add positions and sizes. Only to fix layout.",
        ),
      includeElements: z
        .boolean()
        .default(false)
        .describe(
          "Also list raw elements. Large; node ids usually do.",
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
      "Do the boards still match the code? Reports boxes whose ref no longer resolves, arrows the "
      + "code contradicts, and claims that are wrong. Read-only and cheap. Boxes without a ref and "
      + "hand-drawn ones are not checked, so clean means nothing checked disagreed, not that the "
      + "board is right; skippedWhy says what went unread. Fix what it reports with edit_diagram. "
      + "A damaged entry means the file contradicts itself: repair that board first.",
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
          "Also list what nothing checked: unreadEdges (arrows, with why), unannotated (boxes with "
          + "no ref) and unrepresented (code no box covers). Suggestions, never drift. Walks the "
          + "repository, so ask only when deciding what a board is missing.",
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
      "Render a board to PNG. Once, at the end, to show a person or judge something visual. Not "
      + "to check legibility: create_diagram and relayout_diagram already say that.",
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
      const render = await renderBoardToPng(await readBoard(file), { scale });
      /*
       * The dimensions, not just the byte count. A board too big to draw at the
       * scale asked for is drawn smaller, and a caller told only "4357 KB" has
       * no way to know its next render at the same scale will not be sharper --
       * so it asks again, pays again, and gets the same image.
       */
      const fitted = render.scale < render.requested
        ? ` — scale ${render.requested} would exceed ${render.width >= render.height ? "width" : "height"} `
          + `limits, so this is scale ${render.scale.toFixed(2)}, which puts ${NODE_FONT_SIZE}px labels at `
          + `${(NODE_FONT_SIZE * render.scale).toFixed(0)}px. The board is too large to draw sharper, so `
          + "judging its layout from this image means judging one you cannot read: change the flow or "
          + "split the graph rather than rendering it again"
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `${relativeToWorkspace(file)} ${render.width}x${render.height} `
              + `(${(render.png.byteLength / 1024).toFixed(0)} KB)${fitted}`,
          },
          { type: "image" as const, data: render.png.toString("base64"), mimeType: "image/png" },
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
              .enum(["needs", "feeds", "takes", "returns", "holds", "builds", "calls",
                "accesses", "conforms"])
              .optional()
              .describe(
      CLAIM_DESCRIPTION,
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
      "Change part of a board without redrawing it. Patch a box or arrow by node id: ref, refs, "
      + "state, closed, a colour, a size. Delete by id (a shape takes its label). Set the whole "
      + "board's describes with the top-level field. Everything you do not name stays. Read the "
      + "board first. The response re-checks anchors after a ref, state or describes change: fix "
      + "what it names. Cannot add or remove boxes (create_diagram) or change the flow "
      + "(relayout_diagram).",
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
                  "New anchor, as in create_diagram (a name after #, never line numbers). \"\" "
                  + "removes it.",
                ),
              refs: z
                .array(z.string())
                .optional()
                .describe("Replace the further anchors on this box. An empty array removes them."),
              state: z
                .enum(["planned", "built", "external"])
                .optional()
                .describe(
                  "built, planned or external; the stroke is redrawn to match.",
                ),
              closed: z
                .object({ through: z.array(z.string()).optional() })
                .nullable()
                .optional()
                .describe(
                  "Set, or with null drop, the closed claim on a directory box.",
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
      describes: z
        .enum(["repo", "concept"])
        .optional()
        .describe(
          'Switch what the whole board is about: "repo" (checked against this code) or "concept" '
          + "(about something else, never checked). No id needed; the check runs straight after.",
        ),
    },
  },
  async ({ path: boardPath, updates, deletes, describes }) =>
    guard(async () => {
      const file = resolveBoardPath(boardPath);
      const edited = applyEdits(await readBoard(file), updates, deletes);
      const result = describes
        ? { ...edited, board: applyDescribes(edited.board, describes) }
        : edited;
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
      // Switching describes changes what every box on the board is checked
      // against, so it is owed the same answer as a ref edit.
      if ((touchedAnchors && result.updated.length) || describes) {
        await initEngine();
        notes = drawTimeNotes(checkDrift(result.board, createWorkspace(WORKSPACE_ROOT), {
          trail: createGitTrail(WORKSPACE_ROOT),
        }));
      }
      return text({
        wrote: relativeToWorkspace(file),
        updated: result.updated,
        deleted: result.deleted,
        ...(describes ? { describes } : {}),
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
      "Lay a board out again in another flow (RIGHT or DOWN) without re-sending the graph. "
      + "Everything on it is kept; hand-drawn elements do not move. The flow is recorded. The "
      + "response says whether the result is legible.",
    inputSchema: {
      path: z.string(),
      direction: z
        .enum(["RIGHT", "DOWN"])
        .optional()
        .describe(
          "RIGHT suits most boards; DOWN suits a sequence or a board that sprawls sideways.",
        ),
      name: z
        .string()
        .optional()
        .describe(
          "Which diagram, from read_diagram. Only when a file holds several.",
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
      // Same reason as create_diagram: sending a caller to look at a board that
      // renders as grey smears is what the redraw loop is made of.
      const lookAdvice = result.viewable.verdict === "unviewable"
        ? "Do not render it yet -- see viewable above."
        : "Call render_diagram to see it.";
      return text({
        wrote: relativeToWorkspace(file),
        diagram: result.name,
        direction: result.direction,
        nodes: result.nodeCount,
        edges: result.edgeCount,
        ...(result.keptHandDrawn ? { keptHandDrawnElements: result.keptHandDrawn } : {}),
        ...(result.connectors ? { connectorsRerouted: result.connectors } : {}),
        // Whether the flow just tried actually helped, which is the only reason
        // anybody tries one. Answered without a render (#183).
        ...viewableNotes(result.viewable),
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
                + `before; it is ${result.direction} now and says so. ${lookAdvice}`,
            }
          : result.direction === result.wasDirection
            ? { note: `Already laid out ${result.direction}; nothing moved. ${lookAdvice}` }
            : { note: `Was ${result.wasDirection}. ${lookAdvice}` }),
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
        // Which build is answering. A service outlives the install that started
        // it, so "the version I am" and "the version showing my diagrams" are
        // two different facts, and only one of them is on the page (#181).
        version: probe.version ?? "older than 0.2.0-rc.6",
        stopWith: "diagramos stop --list shows every board service; diagramos stop stops them",
      });
    }),
);

server.registerTool(
  "open_board",
  {
    title: "Open live board",
    description:
      "Open the board in a live local page that follows the file; what the user draws there is "
      + "saved back. Returns a URL for this board; several can be open at once. The page outlives "
      + "this session until `diagramos stop`.",
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
        // Only when it happened, and worth a line when it does: the user may
        // have been looking at findings this build would never have reported.
        ...(service.retired?.length ? { replaced: service.retired } : {}),
      });
    }),
);

server.registerTool(
  "survey_scope",
  {
    title: "Survey a scope",
    description:
      "Call first when asked to diagram a directory's structure. Returns a draft for "
      + "create_diagram: how many boxes, each anchored at a real path, arrows with claim needs and "
      + "the line each was read from, separateBoards for parts that belong on their own board, and "
      + "what it left out. YOUR job: the labels are filenames, so rename each box for what it does, "
      + "merge and drop boxes, and keep refs and claims as they are. It does not draft flows (\"how "
      + "does X happen\"): read the code for those. TypeScript, JavaScript, Rust and Python; other "
      + "languages are refused.",
    inputSchema: {
      scope: z
        .string()
        .describe(
          "A repo-relative directory, e.g. 'src/engine'. Too wide a scope comes back as a few "
          + "boxes and a long list of what was left out.",
        ),
      direction: z
        .enum(["RIGHT", "DOWN"])
        .optional()
        .describe(
          "Leave it off.",
        ),
    },
  },
  async ({ scope, direction }) =>
    guard(async () => {
      // Confined the same way a ref is: a survey reads source, so it must not be
      // able to read source outside the workspace.
      const absolute = resolveInWorkspace(scope);
      const relative = relativeToWorkspace(absolute);
      // The grammars, before anything asks a file what it imports. Without this
      // every file comes back unread and the survey refuses a scope it could
      // have answered.
      await initEngine();
      const survey = await surveyScope(relative, createWorkspace(WORKSPACE_ROOT), direction);

      if (survey.refused) {
        return text({
          scope: relative,
          refused: survey.refused,
          filesRead: survey.read,
          ...(Object.keys(survey.unread).length ? { filesWithNoReader: survey.unread } : {}),
        });
      }

      /*
       * Shaped as the arguments to create_diagram, deliberately.
       *
       * The caller's next call is create_diagram, and anything it has to
       * restructure on the way is a chance to drop a ref or a claim -- which is
       * exactly how this repo's own boards ended up with 47% of boxes anchored.
       * So `nodes` and `edges` are already the right shape and the only thing
       * asked of the caller is better labels.
       */
      return text({
        scope: relative,
        nodes: survey.units.map((unit) => ({
          id: unit.id,
          label: unit.label,
          ref: unit.dir ? `${unit.dir}/` : unit.files[0],
          ...(unit.dir ? { covers: unit.files.length } : {}),
        })),
        edges: survey.edges.map((edge) => ({
          from: edge.from,
          to: edge.to,
          // Absent on an arrow whose dependency is real but is not written as an
          // import anywhere -- see SurveyEdge.claim. Draw it unclaimed; do not
          // add `needs` back because the arrow "obviously" imports.
          ...(edge.claim ? { claim: edge.claim } : {}),
          seen: edge.seen,
        })),
        // The same numbers create_diagram reports, said before the graph is sent
        // rather than after, so a board is never drawn at a size that cannot be
        // read.
        ...viewableNotes({ ...survey.view, verdict: survey.view.verdict } as ViewabilityReport),
        rename:
          "Labels are filenames. Rename each box to what it does, merge boxes that are one idea, and "
          + "drop what the user did not ask about — keeping ref, claim and seen as they are.",
        ...(survey.next.length
          ? {
            separateBoards:
              `Too big to open on this board, so each is its own: ${survey.next.slice(0, 8).join(", ")}`
              + `${survey.next.length > 8 ? ` (+${survey.next.length - 8} more)` : ""}. Survey one of `
              + "these before drawing it; do not add them here.",
          }
          : {}),
        ...(survey.arrowsOmitted
          ? {
            arrowsOmitted:
              `${survey.arrowsOmitted} more real dependencies run between these boxes and are not drawn. `
              + "Every board here is under 1.5 arrows a box and drawing them all makes a hairball, so "
              + "the heaviest are kept. Mention it only if the user asks whether the picture is complete.",
          }
          : {}),
        ...(survey.omitted.length
          ? {
            omitted:
              `${survey.omitted.length} of ${survey.omitted.length + survey.units.reduce((total, unit) => total + unit.files.length, 0)} `
              + "source files are on no box"
              + (survey.next.length
                ? ", most of them inside the boards listed above."
                : ` and there is no sub-directory to send them to — they are a second board's worth: ${
                  survey.omitted.slice(0, 6).join(", ")
                }${survey.omitted.length > 6 ? ", ..." : ""}.`)
              + " Say so if the user needs this board to be complete.",
          }
          : {}),
        ...(Object.keys(survey.unread).length ? { filesWithNoReader: survey.unread } : {}),
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
