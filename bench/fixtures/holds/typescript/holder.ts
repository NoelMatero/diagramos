// Field lists, one per shape.
//
// Property-list shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:326
// — `export interface ComponentInternalInstance { uid: number; type: ConcreteComponent; ... }`.

import type { Req, Request } from "./model";
import type { Thing as Other } from "./model";

// An alias declared in this same file.
type LocalReq = Request;

/** PLAINLY TRUE: a property of type Request. */
export interface Config {
  request: Request;
}

/** GENERIC WRAPPER: a collection of the thing still holds the thing. */
export interface Wrapper {
  requests: Request[];
}

/** TRUE BUT HIDDEN: `Req` *is* Request, imported under an alias. */
export interface Aliased {
  request: Req;
}

/** TRUE BUT HIDDEN, the other way: the alias is declared in this same file. */
export interface LocalAliased {
  request: LocalReq;
}

/** FALSE AND PROVABLE: the property list is written in full and Request is not in it. */
export interface Empty {
  n: number;
}

/** FALSE AND UNPROVABLE: a renamed import in this file could be hiding it. */
export interface Opaque {
  thing: Other;
}
