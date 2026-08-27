/**
 * The panel that says what a box means, and lets a person change it.
 *
 * Two holes, one shape. You could not *see* what file a box pointed at (#114) —
 * the anchor lives in `customData`, which no part of the UI showed — and you
 * could not *set* it (#111), so every semantic edit went through an agent,
 * including the most natural planning gesture there is: sketching the bit that
 * does not exist yet.
 *
 * Rendering only. Every rule lives in `inspect.ts` next door, where it is
 * testable without a browser.
 *
 * Three things it refuses to do:
 *
 * - **Guess.** A hand-drawn dashed box is not read as `planned`. Dashed is a
 *   thing people draw because it looks right, and everywhere else in this tool
 *   something read off the picture is marked inferred and is never allowed to
 *   make a claim. `planned` is one click here, which is fewer keystrokes than
 *   drawing a dashed border anyway.
 * - **Ask for a path.** Anchoring is picking from the files the repository
 *   actually has, not typing one. A typed ref can be typo'd, and a typo'd ref is
 *   a false claim that fires every turn until somebody hunts it down.
 * - **Nag.** Every field is optional and blank is a real answer — an unanchored
 *   box is an honest sketch. The panel is only here while something is selected.
 */
import { useEffect, useMemo, useState } from "react";

import { rowsOf, type DriftView } from "./drift";
import {
  STATE_WORDS,
  refExists,
  type Edit,
  type Meaning,
  type NodeState,
} from "./inspect";

/**
 * Which states a thing can be in.
 *
 * An arrow has no `external`: "not our code" is an answer about a *thing*, and a
 * connection between two boxes on this board is either wired up or it is work to
 * do. Offering it would be offering a word the report has nowhere to put.
 */
const BOX_STATES: NodeState[] = ["built", "planned", "external"];
const ARROW_STATES: NodeState[] = ["built", "planned"];

/** The datalist every file field shares — one list, however many fields are open. */
const PATH_LIST = "repo-paths";

function StateChoice({
  states,
  value,
  onPick,
}: {
  states: NodeState[];
  value: NodeState;
  onPick: (state: NodeState) => void;
}) {
  return (
    <div className="inspect-choice" role="radiogroup" aria-label="Does it exist yet?">
      {states.map((state) => (
        <button
          key={state}
          type="button"
          role="radio"
          aria-checked={state === value}
          className={`inspect-option${state === value ? " inspect-option-on" : ""}`}
          onClick={() => onPick(state)}
        >
          {STATE_WORDS[state]}
        </button>
      ))}
    </div>
  );
}

/**
 * One file field.
 *
 * The tick beside it is answered against the list the picker is already holding,
 * so a path that is not there says so while the cursor is still in the field.
 * It is the cheap half of the question on purpose — "there is somewhere to
 * look", never "checked" — and the findings below are where the real verdict is.
 */
function PathField({
  value,
  paths,
  onCommit,
  onRemove,
}: {
  value: string;
  paths: ReadonlySet<string>;
  onCommit: (next: string) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(value);
  // Someone else may have changed this box — an agent writing the board, or the
  // selection moving to another one. The field follows the file unless it is
  // being typed in, which is what `value` changing means here.
  useEffect(() => setDraft(value), [value]);

  const known = draft.trim() ? refExists(paths, draft) : undefined;
  return (
    <div className="inspect-path">
      <input
        className="inspect-input"
        list={PATH_LIST}
        value={draft}
        spellCheck={false}
        placeholder="start typing a file name"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => draft !== value && onCommit(draft)}
        onKeyDown={(event) => {
          if (event.key === "Enter") onCommit(draft);
          if (event.key === "Escape") setDraft(value);
        }}
      />
      <span
        className={`inspect-check${known === false ? " inspect-check-bad" : ""}`}
        title={
          known === undefined
            ? undefined
            : known
              ? "this is in the repository"
              : "nothing in the repository is at that path yet — fine for something planned, a typo otherwise"
        }
      >
        {known === undefined ? "" : known ? "✓" : "✗"}
      </span>
      {onRemove ? (
        <button type="button" className="inspect-drop" onClick={onRemove} title="Stop pointing at this file">
          ×
        </button>
      ) : null}
    </div>
  );
}

/**
 * The front doors of a `closed` box: the files inside it that outside code is
 * allowed to reach.
 *
 * Its own component so the list keeps its narrowing — and because an empty list
 * is a real claim here, not a missing one. "Nothing outside reaches inside, and
 * there are no doors" is total isolation; `src/viewer` in this repository is
 * exactly that shape. So the trailing blank field adds a door and never means
 * the claim is unfinished.
 */
function Doors({
  elementId,
  through,
  paths,
  onChange,
}: {
  elementId: string;
  through: string[];
  paths: ReadonlySet<string>;
  onChange: (through: string[]) => void;
}) {
  return (
    <>
      <div className="inspect-label inspect-label-sub">except through</div>
      {[...through, ""].map((door, index) => (
        <PathField
          key={`${elementId}:door:${index}`}
          value={door}
          paths={paths}
          onCommit={(next) => {
            const list = [...through];
            if (index < list.length) list[index] = next;
            else if (next.trim()) list.push(next);
            onChange(list.filter(Boolean));
          }}
          onRemove={
            index < through.length
              ? () => onChange(through.filter((_, at) => at !== index))
              : undefined
          }
        />
      ))}
    </>
  );
}

export default function Inspector({
  meaning,
  report,
  paths,
  onEdit,
}: {
  meaning?: Meaning;
  report?: DriftView;
  paths: readonly string[];
  onEdit: (edit: Edit) => void;
}) {
  const known = useMemo(() => new Set(paths), [paths]);
  // An extra empty field, so "point this at another file too" is a click rather
  // than a thing you have to know is possible.
  const [extra, setExtra] = useState(false);
  useEffect(() => setExtra(false), [meaning?.elementId]);

  const findings = useMemo(() => {
    if (!report || !meaning?.node) return [];
    return rowsOf(report).filter((row) => row.node === meaning.node);
  }, [report, meaning?.node]);

  if (!meaning) return null;

  const heading =
    meaning.kind === "box"
      ? meaning.title || "this box"
      : `${meaning.fromLabel} → ${meaning.toLabel}`;

  return (
    <div className="inspect">
      <div className="inspect-head" title={meaning.node ?? "drawn by hand — not checked yet"}>
        {heading}
      </div>

      <datalist id={PATH_LIST}>
        {paths.map((entry) => (
          <option key={entry} value={entry} />
        ))}
      </datalist>

      {meaning.kind === "box" ? (
        <>
          <div className="inspect-label">This box is about</div>
          {(meaning.refs.length ? meaning.refs : [""]).map((ref, index) => (
            <PathField
              key={`${meaning.elementId}:${index}`}
              value={ref}
              paths={known}
              onCommit={(next) => {
                const refs = [...meaning.refs];
                refs[index] = next;
                onEdit({ set: "refs", refs });
              }}
              onRemove={
                meaning.refs.length > 1
                  ? () => onEdit({ set: "refs", refs: meaning.refs.filter((_, at) => at !== index) })
                  : undefined
              }
            />
          ))}
          {extra ? (
            <PathField
              value=""
              paths={known}
              onCommit={(next) => {
                if (next.trim()) onEdit({ set: "refs", refs: [...meaning.refs, next] });
                setExtra(false);
              }}
              onRemove={() => setExtra(false)}
            />
          ) : (
            <button type="button" className="inspect-add" onClick={() => setExtra(true)}>
              + another file
            </button>
          )}
        </>
      ) : null}

      <div className="inspect-label">Does it exist yet?</div>
      <StateChoice
        states={meaning.kind === "box" ? BOX_STATES : ARROW_STATES}
        value={meaning.state}
        onPick={(state) => onEdit({ set: "state", state })}
      />

      {meaning.kind === "box" ? (
        <>
          <label className="inspect-tick">
            <input
              type="checkbox"
              checked={Boolean(meaning.closed)}
              onChange={(event) => onEdit({ set: "closed", closed: event.target.checked, through: meaning.closed?.through })}
            />
            Nothing outside reaches inside it
          </label>
          {meaning.closed ? (
            <Doors
              elementId={meaning.elementId}
              through={meaning.closed.through}
              paths={known}
              onChange={(through) => onEdit({ set: "closed", closed: true, through })}
            />
          ) : null}
        </>
      ) : (
        <>
          {/*
            Two words, one arrow, so ticking one takes the other off: an arrow
            asserts one thing, and the engine reads two claims as garbled rather
            than guessing which was meant. Ticks rather than a dropdown because
            each one is a sentence about *these two boxes* -- which is the whole
            reason this panel reads better than the JSON it replaced.
          */}
          <label className="inspect-tick">
            <input
              type="checkbox"
              checked={meaning.claim === "needs"}
              onChange={(event) => onEdit({ set: "claim", ...(event.target.checked ? { claim: "needs" as const } : {}) })}
            />
            <span>
              <b>{meaning.fromLabel}</b> needs <b>{meaning.toLabel}</b>
            </span>
          </label>
          <label className="inspect-tick">
            <input
              type="checkbox"
              checked={meaning.claim === "feeds"}
              onChange={(event) => onEdit({ set: "claim", ...(event.target.checked ? { claim: "feeds" as const } : {}) })}
            />
            <span>
              <b>{meaning.fromLabel}</b>&apos;s result goes into <b>{meaning.toLabel}</b>
            </span>
          </label>
          {/*
            The payoff, said once and only where it applies: an arrow that only
            means "related, somehow" can never be confirmed as anything in
            particular, because finding a connection somewhere says nothing
            about what this arrow asserts. Claiming one of the two is what gives
            the check a question it can answer.
          */}
          {meaning.claim ? null : (
            <div className="inspect-note">
              Tick one and the check has something to answer: a backwards
              dependency it can catch, or a flow it can go and find.
            </div>
          )}
          {meaning.claim === "needs" ? (
            <div className="inspect-note">
              Only tick this if you have read the import. A wrong one is reported
              in red, with the line that disproves it.
            </div>
          ) : null}
          {meaning.claim === "feeds" ? (
            <div className="inspect-note">
              Confirmed by finding the flow — one function binding the first
              result and passing it to the second. Not finding it is never held
              against the arrow.
            </div>
          ) : null}
          {meaning.claim && !meaning.labelled ? (
            <div className="inspect-note">
              Recorded, but not written on the arrow. Double-click the arrow to give it a
              label and the claim shows there too.
            </div>
          ) : null}
        </>
      )}

      <div className="inspect-findings">
        {!meaning.node ? (
          <div className="inspect-row tone-dim">drawn by hand — nothing checks it yet</div>
        ) : findings.length === 0 ? (
          <div className="inspect-row tone-good">nothing wrong with this one</div>
        ) : (
          findings.map((row) => (
            <div key={`${row.tone}:${row.text}`} className={`inspect-row tone-${row.tone}`}>
              {row.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
