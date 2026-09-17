// Parameter lists, one per shape.
//
// Signature shape from .corpus/vitejs-vite/packages/vite/src/node/cli.ts —
// exported functions with annotated parameters and return types.

import type { Req, Request, Response } from "./model";
// The renamed import, which SKILL.md names as a reason to withhold on a
// signature. Shape from .corpus/excalidraw-excalidraw, which renames on the way
// in throughout its packages.
import type { Thing as Other } from "./model";

// An alias declared in *this* file, which is the shape SKILL.md's alias rule
// reads as written. Shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:106.
type LocalReq = Request;

/** PLAINLY TRUE: the parameter list names Request. */
export function handle(request: Request): number {
  return request.path.length;
}

/** TRUE BUT HIDDEN: `Req` *is* Request, written under an alias. */
export function handleAlias(request: Req): number {
  return request.path.length;
}

/** FALSE AND PROVABLE: the whole parameter list is here and Request is not in it. */
export function count(n: number): number {
  return n;
}

/** FALSE AND UNPROVABLE: a renamed import in this file could be hiding it. */
export function handleOpaque(thing: Other): number {
  return thing.tag;
}

/** WRONG HALF: Request is in the return type, not the parameters. */
export function produce(): Request {
  return { path: "" };
}

/** Keeps Response used. */
export function respond(code: number): Response {
  return { code };
}

/** TRUE BUT HIDDEN, the other way: the alias is declared in this same file. */
export function handleLocalAlias(request: LocalReq): number {
  return request.path.length;
}
