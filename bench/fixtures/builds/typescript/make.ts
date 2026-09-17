// Routines that make a Request, one per shape.
//
// `new X()` shape from .corpus/nestjs-nest/packages/core, which constructs its
// exception classes directly throughout.

import { make } from "./factory";
import { Request } from "./model";

/** PLAINLY TRUE: the construction is written here. */
export function build(): Request {
  return new Request("");
}

/** TRUE BUT HIDDEN: a factory in another file does the making. */
export function buildViaFactory(): Request {
  return make();
}

/** FALSE AND UNPROVABLE: this makes no Request. */
export function unrelated(): number {
  return 0;
}
