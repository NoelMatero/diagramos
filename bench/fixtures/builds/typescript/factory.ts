// A factory in another file, so a caller of it writes no construction of its own.
import { Request } from "./model";

export function make(): Request {
  return new Request("");
}
