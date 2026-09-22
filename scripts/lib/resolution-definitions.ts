/**
 * Where the language-server pool and declaration lookup used to live.
 *
 * It moved to `src/engine/referee-pool.ts` at #337, for the reason #328 moved the
 * TypeScript referee out of this directory: `src/` is the product and
 * `scripts/` is the harness that measures it, so the product may not import
 * from here. Until the move the Python and Rust referees sat on the wrong
 * side of that line, and only the standalone `check-drift` CLI ever asked
 * them anything -- the MCP server, the live board and `bench:planted` all
 * checked Python and Rust boards with no receiver resolver at all.
 *
 * This file stays as the name the measurement scripts and tests already
 * import, so the move is six files rather than thirty. Nothing new should be
 * added here -- the referee itself is the other file, and that is the one to
 * read.
 */
export * from "../../src/engine/referee-pool";
