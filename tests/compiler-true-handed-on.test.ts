/**
 * `measure:handed-on`'s referee (calls research 2026-11): a routine handed to
 * another one step, followed with the compiler's own symbols. Each pair is a
 * correct "calls" arrow that never writes the far end's name, which is the
 * population a type question about a function value puts at risk.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { typescriptTruePairs } from "../scripts/lib/compiler-true-ts";

let repo: string;
beforeEach(() => { repo = mkdtempSync(path.join(tmpdir(), "handed-on-")); });
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe("routines handed on one step", () => {
  it("finds an argument, an option and a field, and marks a cast", () => {
    writeFileSync(path.join(repo, "tsconfig.json"), "{ \"compilerOptions\": { \"strict\": true } }\n");
    writeFileSync(path.join(repo, "a.ts"), [
      "export type Handler = (req: string) => string;",
      "export function run(h: Handler): string { return h(\"x\"); }",
      "export function withOptions(o: { onError: (e: Error) => void }): void { o.onError(new Error(\"x\")); }",
      "export function fits(req: string): string { return req; }",
      "export function fail(e: Error): void { void e; }",
      "export function loose(x: unknown): string { return String(x); }",
      "export function never(n: number): number { return n; }",
      "export class Box {",
      "  handler: Handler = fits;",
      "  wire(): void { this.handler = loose; }",
      "  go(): string { return this.handler(\"y\"); }",
      "}",
      "export function wire(): void {",
      "  run(fits);",
      "  withOptions({ onError: fail });",
      "  run(loose as Handler);",
      "  void never;",
      "}",
      "",
    ].join("\n"));
    const pairs = typescriptTruePairs(ts, repo, ["."], { handedOn: true }).map((pair) => `${pair.from} -> ${pair.to} ${pair.how}`).sort();
    expect(pairs).toEqual([
      "a.ts#Box.go -> a.ts#loose handed-field",
      "a.ts#run -> a.ts#fits handed-argument",
      "a.ts#run -> a.ts#loose handed-argument-cast",
      "a.ts#withOptions -> a.ts#fail handed-option",
    ]);
  });
});
