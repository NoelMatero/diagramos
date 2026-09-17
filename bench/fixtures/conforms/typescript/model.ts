// The base class, and the subclasses that do (or do not) extend it.
// Class shape from .corpus/nestjs-nest/packages/core -- exceptions extending
// RuntimeException throughout that package.

export class Base {}

export class Local extends Base {}

// FALSE AND PROVABLE: the extends clause is written in full and Base is not it.
export class NeverExtends {}

/** WRONG KIND OF END: a routine has no base list. */
export function handle(): void {}
