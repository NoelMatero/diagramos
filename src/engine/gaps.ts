/**
 * Honest gaps: what a board does not show, split into two truths.
 *
 * When reading a board, answer the reader's question: what does this board
 * leave out? Split the answer into:
 * 1. Files related to this board that ARE drawn on a sibling board.
 * 2. Files related to this board that no board in the diagram directory covers.
 *
 * Always silent on failure (degrade gracefully) and silent when there is nothing
 * to report. The line should be self-explanatory: ~30–60 tokens, one sentence.
 */
import path from "node:path";

import type { BoardFile } from "./board-file";
import { readBoard } from "./board-file";
import { boardCoverage, checkDrift, createWorkspace, findBoards, type Workspace } from "./drift";
import { readGraph } from "./graph";

/**
 * Compute honest gaps for a board: what it does not show.
 *
 * Returns a single sentence describing two truths:
 * 1. Related files drawn on sibling boards (list board names).
 * 2. Related files on no board in the directory (list file paths, capped at 8).
 *
 * Returns undefined when there is nothing to report (no gaps, concept board,
 * no anchored refs, or coverage walk gave up).
 *
 * Degrades gracefully on any error: returns undefined rather than throwing.
 */
export async function computeHonestGaps(
  board: BoardFile,
  boardPath: string,
  root: string,
  diagramDir: string,
): Promise<string | undefined> {
  try {
    const workspace = createWorkspace(root);

    // Silence on concept boards -- they do not draw code.
    const graph = readGraph(board);
    if (graph.describes === "concept") return undefined;

    // Silence on boards with no anchored refs.
    if (!graph.nodes.some((n) => n.ref && n.state !== "external")) return undefined;

    // Get unrepresented files for this board, without checking edges.
    const report = checkDrift(board, workspace, { coverage: true, edges: false });
    if (!report.unrepresented || report.unrepresented.length === 0) return undefined;

    // Load sibling boards and extract their coverage.
    const boardFiles = await findBoards(root, diagramDir);
    const siblingCoverages = new Map<string, (absolute: string) => boolean>();

    for (const siblingPath of boardFiles) {
      if (siblingPath === boardPath) continue;  // Exclude self
      try {
        const sibling = await readBoard(siblingPath);
        const siblingGraph = readGraph(sibling);
        const { covered: siblingCovered } = boardCoverage(siblingGraph, workspace);
        siblingCoverages.set(path.basename(siblingPath), siblingCovered);
      } catch {
        // Skip boards that fail to parse.
      }
    }

    // Categorize unrepresented files.
    const drawnElsewhere = new Map<string, Set<string>>();  // board name -> set of file paths
    const drawnNowhere: string[] = [];

    for (const finding of report.unrepresented) {
      const resolved = workspace.resolve(finding.file);
      if (!resolved) continue;

      // Check if this file is covered by a sibling board.
      let foundOnSibling = false;
      for (const [siblingName, siblingCovered] of siblingCoverages) {
        if (siblingCovered(resolved)) {
          // Track which board covers this file
          if (!drawnElsewhere.has(siblingName)) {
            drawnElsewhere.set(siblingName, new Set());
          }
          drawnElsewhere.get(siblingName)!.add(finding.file);
          foundOnSibling = true;
          break;  // Once a file is found on a sibling, stop checking
        }
      }

      if (!foundOnSibling) {
        drawnNowhere.push(finding.file);
      }
    }

    // Build the message.
    const parts: string[] = [];

    if (drawnElsewhere.size > 0) {
      // Count total files drawn elsewhere
      let fileCount = 0;
      for (const files of drawnElsewhere.values()) {
        fileCount += files.size;
      }
      const boards = [...drawnElsewhere.keys()].sort().join(", ");
      parts.push(`${fileCount} related file${fileCount === 1 ? " is" : "s are"} drawn on other boards (${boards})`);
    }

    if (drawnNowhere.length > 0) {
      const shown = drawnNowhere.slice(0, 8);
      const omitted = drawnNowhere.length - shown.length;
      const fileList = shown.join(", ");
      const count = shown.length + omitted;
      let filePart = `${count} related file${count === 1 ? " is" : "s are"} on no board`;
      if (shown.length > 0) {
        filePart += `: ${fileList}`;
        if (omitted > 0) {
          filePart += ` and ${omitted} more`;
        }
      }
      parts.push(filePart);
    }

    if (parts.length === 0) return undefined;

    // Combine into one sentence.
    if (parts.length === 1) {
      return parts[0];
    }
    return `${parts[0]}; ${parts[1]}`;
  } catch {
    // Degrade gracefully: any failure returns undefined, never throws.
    return undefined;
  }
}
