// The thing other modules depend on.
// Shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:326 —
// an exported interface plus the function that makes one.

export interface Request {
  path: string;
}

export function makeRequest(path: string): Request {
  return { path };
}
