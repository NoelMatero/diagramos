// The member list, and the case that leaves it open.
// Property-list shape from .corpus/vuejs-core/packages/runtime-core/src/component.ts:326.

export interface Config {
  width: number;
  height: number;
}

// SKILL.md: an index signature leaves the member list open -- nothing is
// reported either way, because `[key: string]` might be hiding the name.
export interface Dynamic {
  [key: string]: unknown;
}
