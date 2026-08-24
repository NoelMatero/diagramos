/**
 * Read and write `.excalidraw` files.
 *
 * The file is the source of truth: it opens in excalidraw.com, the VS Code
 * extension, or Obsidian, and it lives in the repo next to the code it
 * describes. Everything written here is deterministic so an unchanged diagram
 * produces an unchanged file.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ExcalidrawElement } from "./normalize";

export const EXCALIDRAW_FILE_TYPE = "excalidraw";
export const EXCALIDRAW_FILE_VERSION = 2;
// Provenance recorded in every file Excalidraw opens. Set this to the
// project's public URL once the plugin has one.
const SOURCE = "diagramos";

export interface BoardFile {
  type: string;
  version: number;
  source: string;
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

export async function writeBoard(file: string, board: BoardFile): Promise<void> {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, serializeBoard(board), "utf8");
}
