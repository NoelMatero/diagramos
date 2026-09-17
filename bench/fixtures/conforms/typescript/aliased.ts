// TRUE BUT HIDDEN: the base is imported under an alias.
// SKILL.md's own example: a named import, renamed on the way in.

import { Base as B } from "./model";

export class Aliased extends B {}
