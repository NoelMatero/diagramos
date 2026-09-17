// The field types, and the alias that hides one.
// Interface shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:326.

export interface Request {
  path: string;
}

export interface Thing {
  tag: number;
}

// The alias, declared beside the type it stands for.
export type Req = Request;
