// Routines that read (or do not read) `Config.width`, one per shape.
import { readWidth } from "./helper";
import type { Config } from "./model";

/** PLAINLY TRUE: `width` is read directly in this body. */
export function draw(config: Config): number {
  return config.width;
}

/** TRUE BUT HIDDEN: reads `width` only through a helper that does. */
export function drawViaHelper(config: Config): number {
  return readWidth(config);
}

/** FALSE AND UNPROVABLE (routine end): reads nothing off Config at all. */
export function unrelated(config: Config): number {
  return config.height;
}

/**
 * A second routine reading `width`, so the type-end absence test (`depth`)
 * can use its own arrow rather than share `draw`'s.
 */
export function measure(config: Config): number {
  return config.width;
}
