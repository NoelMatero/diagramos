/**
 * Read and write `.excalidraw` files.
 *
 * The file is the source of truth: it opens in excalidraw.com, the VS Code
 * extension, or Obsidian, and it lives in the repo next to the code it
 * describes. Everything written here is deterministic so an unchanged diagram
 * produces an unchanged file.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExcalidrawElement } from "./normalize";
import type { BoardStamp } from "./version";

export const EXCALIDRAW_FILE_TYPE = "excalidraw";
export const EXCALIDRAW_FILE_VERSION = 2;
// Provenance recorded in every file Excalidraw opens. Set this to the
// project's public URL once the plugin has one.
const SOURCE = "diagramos";

export interface BoardFile {
  type: string;
  /** Excalidraw's file-format number. Nothing to do with this tool's version. */
  version: number;
  source: string;
  /**
   * Which build of this tool generated the board, and what it means (#134).
   *
   * Optional, and deliberately never defaulted on read: absent means the board
   * predates stamping, which `schemaOf` reads as schema 1. Written by
   * `createDiagram` alone -- see `version.ts` for why nothing else may write it.
   *
   * Top level rather than on an element, because it is a fact about the file
   * rather than about anything drawn in it, and because two of this repo's own
   * boards have no title element to hang it from. `readBoard` spreads whatever
   * it parsed, so it survives every round-trip through this codebase; the live
   * viewer's save path is the one that would have dropped it, and merges now.
   */
  diagramos?: BoardStamp;
  elements: ExcalidrawElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
}

export function emptyBoard(): BoardFile {
  return {
    type: EXCALIDRAW_FILE_TYPE,
    version: EXCALIDRAW_FILE_VERSION,
    source: SOURCE,
    elements: [],
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

/**
 * Edge labels older boards parked beside their arrow, bound to it.
 *
 * An edge label used to be a free text element tagged `edgeLabelFor`, sitting
 * at the arrow's midpoint. It looks exactly like a label and Excalidraw does
 * not know it is one, which has a cost the picture never shows: double-clicking
 * the arrow to type on it edits the arrow's *points* instead, and the arrow
 * comes out of that with its bindings gone. Every board written before labels
 * were bound still has that trapdoor under every labelled arrow.
 *
 * So the tie is made on the way in, once, and only where it is unambiguous: the
 * named element exists, it is an arrow, and it has no label of its own yet. The
 * text keeps its own words and its own colour; Excalidraw takes over its
 * position, which is the point.
 */
export function bindLooseEdgeLabels(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  const byId = new Map(elements.map((element) => [String(element.id), element]));
  const alreadyLabelled = new Set(
    elements
      .filter((element) => typeof element.containerId === "string")
      .map((element) => String(element.containerId)),
  );

  const bindTo = new Map<string, string>();
  for (const element of elements) {
    if (element.type !== "text" || typeof element.containerId === "string") continue;
    if (element.isDeleted) continue;
    const target = (element.customData as { edgeLabelFor?: unknown } | undefined)?.edgeLabelFor;
    if (typeof target !== "string") continue;
    const arrow = byId.get(target);
    // One label per container. A board that somehow has two keeps the one
    // Excalidraw already recognises rather than gaining a second.
    if (!arrow || arrow.type !== "arrow" || arrow.isDeleted || alreadyLabelled.has(target)) continue;
    alreadyLabelled.add(target);
    bindTo.set(String(element.id), target);
  }
  if (bindTo.size === 0) return elements;

  const labelByArrow = new Map([...bindTo].map(([label, arrow]) => [arrow, label]));
  return elements.map((element) => {
    const id = String(element.id);
    const arrow = bindTo.get(id);
    if (arrow) {
      return {
        ...element,
        containerId: arrow,
        // What Excalidraw requires of text inside a container. Left as they
        // were, the words render off the anchor it computes.
        textAlign: "center",
        verticalAlign: "middle",
        version: (Number(element.version) || 1) + 1,
      };
    }
    const label = labelByArrow.get(id);
    if (!label) return element;
    const bound = (element.boundElements as Array<{ id?: unknown }> | null | undefined) ?? [];
    return {
      ...element,
      boundElements: [...bound, { type: "text", id: label }],
      version: (Number(element.version) || 1) + 1,
    };
  });
}

export function serializeBoard(board: BoardFile): string {
  // Two-space JSON with a trailing newline: the shape Excalidraw itself
  // writes, so hand-edits in the app produce minimal diffs against ours.
  return `${JSON.stringify(board, null, 2)}\n`;
}

export async function readBoard(file: string): Promise<BoardFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyBoard();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${String(error)}`);
  }
  const board = parsed as Partial<BoardFile>;
  if (board.type !== EXCALIDRAW_FILE_TYPE) {
    throw new Error(`${file} is not an Excalidraw file (type=${String(board.type)})`);
  }
  return {
    ...emptyBoard(),
    ...board,
    elements: bindLooseEdgeLabels(
      Array.isArray(board.elements) ? (board.elements as ExcalidrawElement[]) : [],
    ),
  };
}

/**
 * Writes the board, and never leaves a half-written one behind.
 *
 * Written to a temporary name in the same directory and renamed over the target,
 * because `rename` within a filesystem is atomic: a reader either gets the whole
 * old file or the whole new one, never a truncated prefix of either.
 *
 * This was a plain `writeFile` for as long as one process wrote boards. Two now
 * do -- the Stop hook promotes at the end of a turn, and the board service
 * promotes while one is being watched (#130) -- and a `.excalidraw` caught
 * mid-write does not fail loudly. It parses as invalid JSON, `readBoard` throws,
 * and the board reads as "could not read" until something writes it again.
 *
 * Same directory on purpose: a rename across filesystems is not atomic, and
 * `os.tmpdir()` is frequently a different one.
 *
 * The temporary name carries the pid, so two processes writing the same board at
 * the same moment cannot collide on the scratch file. One of them still wins the
 * rename -- that is a race about *content*, settled by the revision check in the
 * service and by the hook running last, and not something this can decide.
 */
export async function writeBoard(file: string, board: BoardFile): Promise<void> {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true });
  const scratch = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.tmp`,
  );
  try {
    await writeFile(scratch, serializeBoard(board), "utf8");
    await rename(scratch, target);
  } catch (error) {
    // A failed write must not leave the scratch file in the diagram directory,
    // where `findBoards` would go on offering it as a board.
    await rm(scratch, { force: true }).catch(() => undefined);
    throw error;
  }
}
