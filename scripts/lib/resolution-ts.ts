/**
 * Where the TypeScript referee used to live.
 *
 * It moved to `src/engine/referee-ts.ts` at #328, because sitting in
 * `scripts/lib` meant only the standalone `check-drift` CLI could reach it:
 * the packaged build ships `src/` alone, so the MCP server, the live board
 * and `bench:planted` ran their checks with no receiver resolver at all and
 * quietly got a weaker answer than the CLI gave on the same board.
 *
 * This file stays as the name the measurement scripts already import, so the
 * move is one file rather than fifteen. Nothing new should be added here --
 * the referee itself is the other file, and that is the one to read.
 */
export {
  createTsReferee,
  headOfPython,
  headOfTs,
  isOutsideTree,
  receiverResolutionFrom,
  typescriptModule,
  type TsReferee,
  type TsTypeAnswer,
} from "../../src/engine/referee-ts";
