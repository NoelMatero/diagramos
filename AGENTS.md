# Board AI agent instructions

How to *report* your work — summaries and PR descriptions — is a separate file:
[CLAUDE.md](CLAUDE.md). Read that before writing either.

This repository is a diagram-driven-development toolkit: an MCP server that gives
a coding agent read/write access to `.excalidraw` files that live in the repo,
plus a live local board for editing them alongside a human.

## Ground rules

- **The file is the source of truth.** Every operation is a read-modify-write on a
  `.excalidraw` file. Never hold diagram state in memory across a session.
- **Never destroy hand-drawn work.** Elements without a `customData` marker were
  drawn by a human. Regeneration replaces only what the engine generated; a
  sketch is a specification, not a draft to be redrawn.
- **Supply meaning, not geometry.** Callers pass nodes and edges. Layout, sizing,
  connector routing, and bindings are the engine's job. If a diagram needs manual
  coordinates, the layout has a bug worth fixing instead.
- **Keep output deterministic.** Ids and seeds are hashed from stable ids so an
  unchanged diagram regenerates byte-identically. Anything introducing randomness
  or timestamps into a board file breaks git diffs and the tests that guard them.
- **Confine every path.** Tool inputs resolve through `src/mcp/paths.ts`, which
  refuses anything outside the workspace root, symlinks included.

## Working on this repo

- Report provenance honestly: `readGraph` marks each fact `recorded` or
  `inferred`, and callers depend on that distinction. Never present a geometric
  guess as a recorded fact.
- Prefer reproducing a bug over reasoning about it. Both wrong diagnoses in this
  codebase's history came from theorising; the fixes came from a probe or a test.
- Assertions should check the thing a user sees. The board sync bug hid behind a
  test that asserted on an HTTP response instead of the rendered canvas.
- A tool that cannot report its own state forces the caller to guess. When a
  failure comes from an agent misusing a tool, first ask whether the tool made
  the truth observable.

## Running the tests

`npm test` is a three-minute command. It is the gate before you hand work over,
not a thing to reach for after every edit — a session that runs it eight times
has spent half an hour watching files it never touched.

- **While you are working, run the files you are working on.** `npm run
  build:cli` once, then `npx vitest run tests/<file>.test.ts` for as many
  targeted runs as you like. The build is what `pretest` does; without it four
  files fail on a stale `out/cli` and the failures look like real ones.
- **Run the whole suite once**, when the change is finished.
- **`npm run test:e2e:board` needs `npm run build:viewer` first**, or it tests
  the last bundle instead of yours. Two minutes, and it drives a real browser —
  worth it for anything touching `src/viewer`, wasted on anything else.

### A red suite is not always a broken change

Several sessions share this checkout and its worktrees, and vitest saturates the
machine. Under that load the 30-second timeout in `vitest.config.ts` starts
firing on files that pass alone: a run measured at 93 seconds idle took 340 with
four other vitest processes going, and reported eleven failures, every one of
them a timeout in a file the change never touched.

So before blaming your change, look at *how* it failed. `Test timed out in
30000ms` in unrelated files is the machine, and re-running costs three more
minutes to learn the same thing. An assertion failure is yours. If you genuinely
cannot tell, run the one suspect file alone rather than the suite again, and say
plainly in your summary what you ran and what you saw.
