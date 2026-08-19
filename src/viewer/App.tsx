import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { BoardSync, withBoard, type BoardPayload, type SyncStatus } from "./sync";
import { planReveal, prefersReducedMotion } from "./reveal";
import { rowsOf, summaryOf, tallyOf, worstToneOf, type DriftView } from "./drift";

const STATUS_LABEL: Record<SyncStatus, string> = {
  connecting: "connecting",
  live: "live",
  saving: "saving",
  offline: "offline",
};

const STALE_NOTE = "Not connected — this may no longer be the board being served.";

function StatusPill({
  status,
  detail,
  file,
}: {
  status: SyncStatus;
  detail?: string;
  file?: string;
}) {
  // The filename only means anything while the connection is up. With it down,
  // the server may have been pointed at another board, or replaced entirely, and
  // the page has no way to know: it is reporting the last thing it was told, so
  // it has to look like that rather than like fact.
  const stale = status === "offline" && Boolean(file);
  const title = stale
    ? `${file} — ${STALE_NOTE}${detail ? ` (${detail})` : ""}`
    : detail ?? file ?? "";

  return (
    <div className={`status status-${status}`} title={title}>
      <span className="status-dot" />
      {/* Which board this is showing. Without it, a page pointed at another
          file looks identical to one that simply is not updating. */}
      {file ? (
        <span className={`status-file${stale ? " status-file-stale" : ""}`}>{file.split("/").pop()}</span>
      ) : null}
      {STATUS_LABEL[status]}
    </div>
  );
}

/**
 * The board's status, on the board.
 *
 * Every signal the drift checker produces used to reach only the CLI; this is
 * the same report on the page the diagram lives on. Collapsed it is a chip with
 * the notice's tally; open it lists the findings, and clicking one reveals the
 * box it is about. Quiet green when there is nothing to say -- worded as what
 * was checked, because "in sync" and "unread" must not look alike.
 */
function DriftPanel({
  report,
  onReveal,
}: {
  report?: DriftView;
  onReveal: (node: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (!report) return null;

  const tally = tallyOf(report);
  const rows = rowsOf(report);
  const quiet = rows.length === 0;
  const tone = quiet ? "good" : worstToneOf(rows);

  return (
    <div className="drift">
      <button
        type="button"
        className="drift-chip"
        onClick={() => setOpen((current) => !current)}
        title="Diagram status — click for details"
      >
        <span className={`drift-dot tone-${tone}`} />
        {quiet
          ? report.concept
            ? "concept board"
            : "in sync"
          : tally.map((part) => (
              <span key={part.text} className={`tone-${part.tone}`}>
                {part.text}
              </span>
            ))}
      </button>
      {open ? (
        <div className="drift-body">
          {quiet ? (
            <div className="drift-row tone-dim">{summaryOf(report)}</div>
          ) : (
            rows.map((row) => (
              <button
                type="button"
                key={`${row.tone}:${row.text}`}
                className={`drift-row tone-${row.tone}`}
                disabled={!row.node}
                onClick={() => row.node && onReveal(row.node)}
                title={row.node ? "Show on the board" : undefined}
              >
                {row.text}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [detail, setDetail] = useState<string>();
  const [file, setFile] = useState<string>();
  const [drift, setDrift] = useState<DriftView>();

  /**
   * Ask the server for the board's status. Failure leaves the last report up
   * rather than blanking the panel: a hiccup should not read as "all clean".
   */
  const refreshDrift = useCallback(async () => {
    try {
      const response = await fetch(withBoard("/api/drift"), { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as { report?: DriftView };
      if (payload.report) setDrift(payload.report);
    } catch {
      // Offline is already told by the status pill; stale beats wrong here.
    }
  }, []);

  /**
   * Reveal the element a status row is about: centre it and select it. The
   * report names nodes semantically; the canvas knows them by customData.
   */
  const revealNode = useCallback((node: string) => {
    const api = apiRef.current;
    if (!api) return;
    const match = api.getSceneElements().find((element) => {
      const custom = (
        element as unknown as {
          customData?: { node?: string; edge?: { from?: string; to?: string } };
        }
      ).customData;
      if (!custom) return false;
      if (custom.node === node) return true;
      return custom.edge ? `${custom.edge.from} -> ${custom.edge.to}` === node : false;
    });
    if (!match) return;
    // Centre without changing zoom: fitting one box to the screen is a lurch.
    api.scrollToContent([match], { animate: true });
    api.updateScene({ appState: { selectedElementIds: { [match.id]: true } } });
  }, []);

  // Suppresses the onChange that our own updateScene triggers, so applying a
  // remote board does not immediately bounce back as a local save. It stays set
  // for the whole staggered reveal: a half-revealed scene must never be written
  // to the file, and every frame of the reveal fires onChange.
  const applyingRemote = useRef(false);
  // Frame the board once on open. Re-fitting on every remote update would
  // yank the viewport out from under someone who has scrolled somewhere.
  const framed = useRef(false);
  // Timer for the reveal in progress, so a board arriving mid-reveal can cancel
  // it. Without this the outgoing animation's later frames would land on top of
  // the newer scene and put the old diagram back.
  const revealTimer = useRef<number | undefined>(undefined);

  const sync = useMemo(
    () =>
      new BoardSync({
        onRemoteBoard: (board, meta) => {
          const api = apiRef.current;
          if (!api) return;
          if (meta.file) setFile(meta.file);
          if (revealTimer.current !== undefined) window.clearTimeout(revealTimer.current);
          applyingRemote.current = true;

          const files = Object.values(board.files ?? {});
          if (files.length) api.addFiles(files as Parameters<ExcalidrawImperativeAPI["addFiles"]>[0]);
          type SceneElements = NonNullable<
            Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"]
          >;
          const elements = board.elements as unknown as SceneElements;

          // Only a wholesale scene is worth drawing on: an ordinary addition is
          // already a small visible change, and staggering it would delay a
          // couple of elements for no gain.
          const stagger = meta.wholesale && !prefersReducedMotion();
          const { frames, intervalMs } = stagger
            ? planReveal(board.elements)
            : { frames: [board.elements], intervalMs: 0 };

          // Frame against the finished diagram, not the first frame, so the
          // viewport is settled before anything is drawn into it and the reveal
          // does not walk the view across the canvas.
          if (elements.length > 0 && (!framed.current || meta.wholesale)) {
            framed.current = true;
            api.scrollToContent(elements, { fitToContent: true, animate: false });
          }

          const settle = () => {
            // Read the scene back: updateScene re-stamps versions, so the file's
            // own numbers are not what the canvas now holds.
            sync.markApplied(api.getSceneElements() as unknown as Array<Record<string, unknown>>);
            // updateScene notifies listeners synchronously; release on the next
            // tick so the resulting onChange is the one we skip.
            setTimeout(() => {
              applyingRemote.current = false;
            }, 0);
            // The board just changed on disk, so its status likely did too.
            window.setTimeout(() => void refreshDrift(), 250);
          };

          const showFrame = (index: number) => {
            api.updateScene({ elements: frames[index] as unknown as SceneElements });
            if (index === frames.length - 1) {
              revealTimer.current = undefined;
              settle();
              return;
            }
            revealTimer.current = window.setTimeout(() => showFrame(index + 1), intervalMs);
          };
          showFrame(0);
        },
        onStatus: (next, why) => {
          setStatus(next);
          setDetail(why);
        },
      }),
    [refreshDrift],
  );

  useEffect(() => {
    void sync.start();
    return () => {
      if (revealTimer.current !== undefined) window.clearTimeout(revealTimer.current);
      sync.stop();
    };
  }, [sync]);

  /*
   * Drift can arrive from the code side with no board write at all -- deleting
   * a file the board points at changes the status and fires no SSE. Refetching
   * on focus catches "I flipped to the browser to look", and a slow visible-tab
   * timer catches watching the page while working elsewhere. Cheap on purpose;
   * a file-system watcher over the whole repo is a different kind of process.
   */
  useEffect(() => {
    void refreshDrift();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refreshDrift();
    }, 30_000);
    const onFocus = () => void refreshDrift();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshDrift]);

  const onChange = useCallback(
    (
      elements: readonly unknown[],
      _appState: unknown,
      files: Record<string, unknown>,
    ) => {
      if (applyingRemote.current) return;
      sync.push({
        type: "excalidraw",
        version: 2,
        source: "board-viewer",
        elements: elements as Array<Record<string, unknown>>,
        appState: {},
        files: files ?? {},
      } satisfies BoardPayload);
    },
    [sync],
  );

  return (
    <div className="board-root">
      <StatusPill status={status} detail={detail} file={file} />
      <DriftPanel report={drift} onReveal={revealNode} />
      <Excalidraw
        excalidrawAPI={(api) => {
          apiRef.current = api;
          // Test affordance: end-to-end checks must assert against the scene
          // the canvas is actually showing, not against what the API returns.
          (window as unknown as { __boardScene?: () => unknown }).__boardScene = () => {
            const elements = api.getSceneElements();
            const all = api.getSceneElementsIncludingDeleted();
            return {
              count: elements.length,
              ids: elements.map((element) => element.id),
              // Soft-deleted residue matters: onChange reports these too, so a
              // save can carry them into the file. A canvas that looks right can
              // still be about to write elements from a board it no longer shows.
              deleted: all.length - elements.length,
              deletedIds: all.filter((element) => element.isDeleted).map((element) => element.id),
              // Lets a test wait for the reveal to finish instead of sleeping a
              // guessed number of milliseconds and hoping.
              revealing: revealTimer.current !== undefined,
            };
          };
        }}
        onChange={onChange}
        initialData={{ appState: { viewBackgroundColor: "#ffffff" } }}
        // Open stays available: it is a useful escape hatch for inspecting
        // another board. Saving an unrelated scene over this one is prevented in
        // BoardSync.push, which refuses a scene sharing no element ids with the
        // one it loaded, rather than by removing the menu item.
      />
    </div>
  );
}
