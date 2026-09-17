// Return types, one per shape.
//
// Signature shape from .corpus/vitejs-vite/packages/vite/src/node/cli.ts.

import type { Req, Request, Response } from "./model";
// The renamed import, which SKILL.md names as a reason to withhold on a signature.
import type { Thing as Other } from "./model";

// An alias declared in *this* file, which is the shape SKILL.md's alias rule
// reads as written. Shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:106.
type LocalReq = Request;

/** PLAINLY TRUE: the return type is Request. */
export function produce(): Request {
  return { path: "" };
}

/** TRUE BUT HIDDEN: `Req` *is* Request, written under an alias. */
export function produceAlias(): Req {
  return { path: "" };
}

/** FALSE AND PROVABLE: the return type is written in full and is not Request. */
export function count(): number {
  return 0;
}

/** FALSE AND UNPROVABLE: a renamed import in this file could be hiding it. */
export function produceOpaque(): Other {
  return { tag: 0 };
}

/** WRONG HALF: Request is in the parameter list, not the return type. */
export function handle(request: Request): number {
  return request.path.length;
}

/** Keeps Response used. */
export function respond(code: number): Response {
  return { code };
}

/** TRUE BUT HIDDEN, the other way: the alias is declared in this same file. */
export function produceLocalAlias(): LocalReq {
  return { path: "" };
}
