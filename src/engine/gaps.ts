/**
 * Honest gaps: what a board does not show, split into two truths.
 *
 * When reading a board, answer the reader's question: what does this board
 * leave out? Split the answer into:
 * 1. Files related to this board that ARE drawn on a sibling board.
 * 2. Files related to this board that no board in the diagram directory covers.
 *
 * Silent only when there is genuinely nothing to say. A failure to compute the
 * answer is said out loud in one short clause, never rendered as silence --
 * "this board has nothing to declare" and "I could not tell" are the exact two
 * states this feature exists to keep apart, so it cannot be allowed to conflate
 * them about itself. The line should be self-explanatory: ~30–60 tokens.
 */
import path from "node:path";

import type { BoardFile } from "./board-file";
import { readBoard } from "./board-file";
import { boardCoverage, checkDrift, createWorkspace, findBoards } from "./drift";
import { readGraph } from "./graph";

/**
 * Compute honest gaps for a board: what it does not show.
 *
 * Returns a single sentence describing two truths:
 * 1. Related files drawn on sibling boards (list board names).
 * 2. Related files on no board in the directory (list file paths, capped at 8).
 *
 * Returns undefined only when silence is the truth: no gaps, a concept board,
 * no anchored refs, or the coverage walk gave up before answering. Any actual
 * failure returns a sentence saying the answer could not be determined --
 * degraded, still honest, never thrown.
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

    /*
     * If this board is not among the boards the search found, the search looked
     * in the wrong place -- a misconfigured diagram directory, or a board living
     * outside it, which this repo's own findStrayBoards path exists because of.
     * Every sibling-drawn file would then silently reclassify as "nobody draws
     * this" and the sentence would assert it at full confidence: the exact lie
     * this feature was built to kill, arriving through the back door.
     *
     * The board being present is the discriminator, not "zero siblings": a
     * single-board repo has no siblings and its "on no board" claim is true and
     * still deserves saying.
     */
    const self = path.resolve(boardPath);
    if (!boardFiles.some((file) => path.resolve(file) === self)) {
      const count = report.unrepresented.length;
      return `${count} related file${count === 1 ? " is" : "s are"} not drawn here; `
        + "whether other boards draw them could not be determined, because this board "
        + "is outside the diagram directory that was searched";
    }

    const siblingCoverages = new Map<string, (absolute: string) => boolean>();

    for (const siblingPath of boardFiles) {
      if (path.resolve(siblingPath) === self) continue;  // Exclude self
      try {
        const sibling = await readBoard(siblingPath);
        const siblingGraph = readGraph(sibling);
        const { covered: siblingCovered } = boardCoverage(siblingGraph, workspace);
        siblingCoverages.set(path.basename(siblingPath), siblingCovered);
      } catch {
        // Skip boards that fail to parse.
      }
    }

    /*
     * Categorize unrepresented files. Every sibling is consulted for every
     * file: a file drawn on three boards credits all three, so the pointer
     * list is "the boards that cover my gaps", not "one board per gap file".
     * The count and the pointers are kept as two separate sets because they
     * answer different questions -- distinct files for how much is elsewhere,
     * board names for where to look -- and summing files per board would count
     * a thrice-drawn file three times.
     */
    const elsewhereFiles = new Set<string>();
    const elsewhereBoards = new Set<string>();
    const drawnNowhere: string[] = [];

    for (const finding of report.unrepresented) {
      const resolved = workspace.resolve(finding.file);
      if (!resolved) continue;

      let foundOnSibling = false;
      for (const [siblingName, siblingCovered] of siblingCoverages) {
        if (siblingCovered(resolved)) {
          elsewhereFiles.add(finding.file);
          elsewhereBoards.add(siblingName);
          foundOnSibling = true;
        }
      }

      if (!foundOnSibling) {
        drawnNowhere.push(finding.file);
      }
    }

    // Build the message.
    const parts: string[] = [];

    if (elsewhereFiles.size > 0) {
      const fileCount = elsewhereFiles.size;
      const boards = [...elsewhereBoards].sort().join(", ");
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
    /*
     * A failure must not render as a clean board. "Nothing to declare" and
     * "could not tell" are the two states this whole feature exists to keep
     * apart, so the failure is said in one short clause -- the same choice the
     * drift CLI's footer makes ("silence means these agreed · not that
     * everything was read"). Quiet enough to survive being read on every turn;
     * never an exception, because a gap note must not break a board read.
     */
    return "what this board leaves out could not be determined";
  }
}
