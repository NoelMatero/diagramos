// A routine a reader can be called through.
import type { Config } from "./model";

export function readWidth(config: Config): number {
  return config.width;
}
