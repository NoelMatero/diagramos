// PLAINLY TRUE: the dependency is a static import at the top of the file.
// Shape from .corpus/vuejs-core/packages/runtime-core/src/index.ts:62 —
// a named import from a sibling module.

import { makeRequest } from "./model";

export function handle(path: string): number {
  return makeRequest(path).path.length;
}
