/**
 * The planted-mistake answer keys, and the one-arrow board each claim is asked
 * on.
 *
 * Shared by `bench-planted.mts`, which scores all 1,661 of them, and
 * `probe-check-cost.mts`, which asks one of them three times and counts what
 * the check reads. The probe has to build the *same* board the bench does, or
 * what it measures is the cost of a different question.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { emptyBoard, type BoardFile } from "../../src/engine/board-file";
import { createDiagram } from "../../src/engine/diagram";

export interface KeyClaim {
  id: string; word: string; from: string; to: string; member?: string;
  fromLabel: string; toLabel: string; fromState?: string; toState?: string; language: string;
  source: "drawn" | "labelled" | "swap" | "reverse" | "retarget" | "wrong-kind";
  parent?: string; truth: "true" | "false" | "undecidable"; why: string;
}

export interface Key {
  board: string; project: string; topic: string; language: string; scope: string; pin: string;
  tool: string; claims: KeyClaim[];
}

/** Every stored key, by project then file, in the order the bench scores them. */
export function plantedKeys(repo: string): Key[] {
  const root = path.join(repo, "bench/boards");
  if (!existsSync(root)) return [];
  const out: Key[] = [];
  for (const project of readdirSync(root).sort()) {
    const dir = path.join(root, project);
    for (const file of readdirSync(dir).sort()) {
      if (!file.endsWith(".answers.json")) continue;
      out.push(JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Key);
    }
  }
  return out;
}

/**
 * One claim, on a board carrying nothing else.
 *
 * The state comes along, or an arrow into a box the board called `external` is
 * scored as though the board had never said so -- which changed two verdicts on
 * the httpx board when this was left out.
 */
export async function plantedBoard(key: Key, claim: KeyClaim): Promise<BoardFile> {
  const label = (text: string, ref: string) => (text.trim() || ref).slice(0, 60);
  const nodes = [
    { id: "from", label: label(claim.fromLabel, claim.from), ref: claim.from,
      ...(claim.fromState ? { state: claim.fromState as never } : {}) },
    { id: "to", label: label(claim.toLabel, claim.to), ref: claim.to,
      ...(claim.toState ? { state: claim.toState as never } : {}) },
  ];
  const built = await createDiagram(emptyBoard(), {
    title: `${key.project} ${key.topic}`,
    nodes,
    edges: [{
      from: "from", to: "to", claim: claim.word as never,
      ...(claim.member ? { label: claim.member } : {}),
    }],
  });
  return JSON.parse(JSON.stringify(built.board)) as BoardFile;
}
