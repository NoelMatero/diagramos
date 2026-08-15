# Design: what a box can say

Answer to `docs/ref-brief.md`, measured in this repo on 2026-08-15. A design, not
code — nothing below is implemented. Where a claim was measured, the number is
given; where something is opinion it says so. If this file disagrees with the
code once something ships, trust the code and fix this file.

## The finding first, because the brief asked for it plainly

**A box's meaning cannot be checked deterministically. Its anchors can.**
"Add logging" as an idea is out of mechanical reach forever — no regex knows
whether the logging is the logging the author meant. What a machine *can* verify
is anchors: a path exists, a directory is non-empty, a symbol is declared in a
file, a route literal appears in a server file. So the design stops trying to
make the check smarter about prose and instead widens what an anchor can be,
until every kind of box people actually draw has at least one honest anchor
available. A box with no anchor is not checkable, and the design says so out
loud (coverage, below) instead of guessing.

The second finding is about migration, and it killed half the ideas on the
whiteboard: **the 106 refless labels contain nothing inferable.** Measured
today: 0 path-like, 0 route-like, 0 directory-like labels in the whole corpus.
Every refless label is a bare word like "Auth" or "S-CSCF". Smarter label
guessing — the obvious migration move — reaches exactly zero existing boxes.
Migration has to come from the model and the tool surface, not from inference.

## The syntax

`ref` stays **one string** — models write strings reliably, and every existing
ref keeps working unchanged. One addition beside it: an optional `refs: string[]`
for a box that means several anchors at once. A box is clean when every target
is clean; each target reports individually.

Six target forms, four of them new:

| form | example | claim |
| --- | --- | --- |
| file | `src/engine/drift.ts` | this file exists *(today, unchanged)* |
| symbol | `src/engine/drift.ts#checkDrift` | the file mentions — ideally declares — this symbol *(today, upgraded below)* |
| directory | `src/engine/` | this directory exists and is non-empty *(today it half-works; trailing slash makes it explicit)* |
| dir symbol | `src/engine/#Workspace` | some TS/JS file directly in this directory mentions the symbol *(today: `unresolvable-ref`)* |
| glob | `src/engine/*.ts` | at least one file matches. `*` allowed in the **last segment only**, no `**` — the directory prefix is literal, so expansion is one `readdir` through `Workspace`, never a tree walk |
| route | `src/server/board-server.ts#/api/board` | a symbol starting with `/` is a route claim: the exact literal appears in the file or its direct imports. An optional method token (`#POST /api/file`) is accepted for the reader and ignored by the check, and that is said in the docs rather than hidden |

Also legal: `#/api/board` with no path — checked against the board's
neighborhood route pool (every ref'd file on the board plus one import hop, the
same set the arrow check already builds). Weaker claim, weaker tier.

**"Deliberately not code" is not a ref form.** It belongs to the intent axis
(`planned` / `built` / `external`) so there is exactly one way to say it. Until
states ship, the interim is one board-level field: `describes: "repo" | "concept"`
in the board's customData. A concept board's boxes are excused honestly —
"auth: concept board, not checked" — which is a different sentence from "33
boxes nobody annotated". This resolves forgot-vs-deliberate at the granularity
where it actually exists in the corpus: whole diagrams (the telecom boards are
wholly conceptual, board-internals wholly repo), not individual boxes.

Everything resolves through `Workspace` exactly as today. The glob restriction
is the security design: a ref can name one directory's listing, never a search.

## Verification, and what it costs

All measured on this repo, this machine, today:

- Parsing all 7 boards through `readGraph`: **2.4 ms**.
- The declaration regex over all 109 real exported symbols in `src/`, file reads
  included: **3.9 ms**.
- Glob: one `readdir` of one directory. Directory-symbol: reads the directory's
  own TS/JS files, capped (50; beyond the cap the target is *skipped and
  counted*, never guessed). Route: the file plus its direct imports — the arrow
  check already reads these, so the marginal cost is a cached lookup.
- The whole per-turn path stays where it is now, well under 50 ms, no parse, no
  network, no model.

**The symbol upgrade** is the one piece with any subtlety. Today `#symbol` is a
word-boundary mention over the whole file, which cannot tell *declared here*
from *mentioned here*. The upgrade is a second, stricter regex tier — declaration
patterns (`function X` / `class X` / `const X = ` / method definitions /
re-export lists) — measured against every real export:

- Finds its own declaration: **109 of 109**.
- Discrimination: of 71 (file, symbol) pairs where a symbol is mentioned but
  declared elsewhere, the declaration regex wrongly says "declared" in **13** —
  re-exports, parameter type annotations, a call inside a ternary. Every one of
  those errors makes the check **quieter**, never louder. That is the same
  asymmetry `mentions()` already commits to on purpose.

So the tiers stack without adding any loud path that does not exist today:
declared → certainly fine, silent. Mentioned but not declared → fine per-turn,
listed as "worth a look" only in the on-demand command. Neither → `missing-symbol`,
loud, exactly as now. A real TS parse was considered for the per-turn path and
refused (cost, below); if the regex tier ever proves too coarse, a parse belongs
in the on-demand command only.

## Findings and their tiers

| finding | trigger | tier | channel |
| --- | --- | --- | --- |
| `missing-file` | recorded path gone | near-certain | per-turn, loud *(today)* |
| `empty-ref` | glob or directory matches nothing | near-certain | per-turn, loud *(new)* |
| `missing-symbol` | no mention in the target set | near-certain | per-turn, loud *(today)* |
| `missing-route` | anchored literal gone from file + one hop | near-certain | per-turn, loud *(new)* |
| `unresolvable-ref` | bad syntax, escapes the root | near-certain | per-turn *(today)* |
| `undeclared-symbol` | mentioned, not declared | plausible | on-demand only *(new)* |
| `missing-route` (pool form) | not in the board's neighborhood pool | plausible | on-demand only *(new)* |
| coverage | "n of m boxes carry an anchor; k boards are concept" | information | on-demand only *(new)* |

Composed with the intent axis, the same finding changes meaning, not tier: on a
`planned` box, `missing-symbol` reads "not built yet — the file is there, the
function is not", a work item; on a `built` box it reads as regression. The
detection is identical; only the sentence differs.

## Migration — where the 106 boxes actually go

Measured: label inference cannot help (zero inferable labels). The paths that
remain, in order of leverage:

1. **One field per board.** Mark `auth`, `ims`, `ims-volte`, `ims_2`, `example`
   as `describes: "concept"`. Five one-word edits (or `/update-diagram` asks
   once) and **89 of the 106 refless boxes are excused honestly** — they were
   never claims about this repo.
2. **An annotate mode on `/update-diagram`.** The settled constraint allows a
   model in the *fixing* loop, and this is fixing: for a repo board, the model
   proposes a ref per refless box, the human approves, the refs are written
   once, and detection is mechanical ever after. This is how
   `architecture.excalidraw`'s 16 boxes get anchors without anyone editing 16
   boxes by hand — one command, one review. The evidence says people will never
   annotate manually; the model drew most of these boxes and can annotate them.
3. **Coverage in the on-demand report, never per-turn.** "3 of 16 boxes on
   architecture carry an anchor" makes the gap visible exactly when someone is
   already looking, which is the only pressure that has ever produced refs here
   (board-internals got its 11 because the tool wrote them).
4. **New boxes pay at the door.** `create_diagram`'s node schema keeps `ref`
   optional but the tool description tells the model a repo-board box without
   one lands unchecked. The corpus shows the tool, not the human, is where refs
   come from.

## Measured results, per the brief's evaluation rules

1. **False positives on the real corpus: 0.** No committed diagram uses any new
   form yet, so the new checks flag nothing; the tier changes add no loud path;
   the baseline check today reports exactly one pre-existing arrow finding on
   the working-tree copy of board-internals and nothing else. The new design
   cannot regress per-turn noise because nothing new is loud unless an exact
   recorded anchor is gone.
2. **True positives, constructed:** a ghost symbol
   (`drift.ts#thisSymbolWasRenamedAway`) is caught by both tiers — measured. An
   anchored route ref `board-server.ts#/api/board` passes against today's code
   (the literal is really there, and also in `viewer/sync.ts` one hop from the
   viewer's box); pointing it at `#/api/ghost` flags. A glob
   `src/engine/*.rs` matches nothing and flags.
3. **Not measured:** how the annotate mode's proposals score on precision — that
   needs the mode to exist; and how directory-symbol behaves on a large
   directory — this repo has none near the cap.
4. **Cost per turn:** 2.4 ms boards + single-digit ms for every anchor form on
   this repo; files read: the ref'd files plus one import hop, the same set the
   arrow check already reads.

## Refused, with reasons

- **Repo-wide symbol search** (`#symbol` with no path). Unbounded cost, a ref
  becomes a disk probe, and any mention anywhere whitewashes — the same failure
  the arrow brief measured on bare path mentions.
- **`**` globs, or globs anywhere but the last segment.** Each widening step
  turns "check one directory listing" back into "walk the tree on a
  model-authored string". The single-star form covers "the engine" today;
  widen only if a real diagram cannot be expressed, and measure then.
- **Any further label guessing.** Measured reach on this corpus: zero boxes.
  All risk, no coverage. `PATH_LIKE` stays as-is.
- **A TS parse on the per-turn path.** The compiler API costs hundreds of
  milliseconds before the first file; the regex tier gets 109/109 on
  declarations with all 13 discrimination errors falling in the silent
  direction. Wrong side of the budget for no measured gain.
- **Verifying route methods** (POST vs GET) or anything behavioral. Needs
  framework parsing that is different per framework and wrong per framework.
  The method token is display-only and documented as such.
- **Semantic verification of prose.** Whether the code *does what the box
  says* is a model's question, asked in the fixing channel where a human
  invoked it. Pretending a mechanical check answers it is how checks start
  crying wolf.

## Order of work, if this ships

1. Board-level `describes` field + the coverage line in the on-demand command.
   Zero new loud findings; 89 boxes stop being ambiguous.
2. Directory/glob/dir-symbol forms (`empty-ref` finding) and the trailing-slash
   convention. Small, language-agnostic, fixes the known arrow-check hole where
   a directory ref silently disables edges.
3. The symbol declaration tier (on-demand `undeclared-symbol`) and route
   anchors.
4. The annotate mode on `/update-diagram`, measured on
   `architecture.excalidraw` first: proposals reviewed by a human, precision
   recorded here.

Each step behind the existing flag discipline: anything new that can speak
per-turn gets its own switch, so a noisy newcomer can be shot without losing
the quiet checks.
