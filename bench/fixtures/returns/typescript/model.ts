// The types the signatures name, and the alias that hides one.
//
// Interface shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:326.
// Alias shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:99 —
// `export type Data = Record<string, unknown>`.

export interface Request {
  path: string;
}

export interface Response {
  code: number;
}

export interface Thing {
  tag: number;
}

// The alias. A signature naming `Req` names `Request` and does not say so.
export type Req = Request;
