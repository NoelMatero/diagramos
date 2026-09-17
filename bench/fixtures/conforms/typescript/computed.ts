// FALSE AND UNPROVABLE: the base is an expression, not a name -- the mixin
// pattern. SKILL.md: "an expression rather than a name (`extends mixin(B)`)"
// is one of the two things `@conforms` cannot read at all.

type Ctor = new () => object;

function mixin(Base: Ctor): Ctor {
  return class extends Base {};
}

export class Computed extends mixin(class {}) {}
