// The Lab tab: fully functional chat (left) + the Flow map with the step
// controls (middle) + the JSONL strip (right) — all three rendering the SAME
// stepped state, so one click of "Step" advances chat, map and trace in
// lockstep. The dam is client-side: the server run continues (or genuinely
// waits at a permission future) regardless of how far the user has stepped.

import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { ClientMessage, RunEvent } from "../events";
import { Chat } from "../components/Chat";
import { PermissionDialog } from "../components/PermissionDialog";
import { Resizer } from "../components/Resizer";
import { setChatW, setCtxW, setTraceW, toggleChat, toggleCtx, toggleTrace, useLayout } from "../state/layout";
import type { PendingAttachment } from "../components/AttachmentPreview";
import { backToLive, loadReplay, step, useStepper } from "../state/stepper";
import { labViewDefault } from "./labViewDefault";
import { LabHint } from "./LabControls";
import { LabTransport } from "./LabTransport";
import { FlowMap } from "./FlowMap";
import { LabTrace } from "./LabTrace";
import { LabDock, dockTitleKey } from "./LabDock";
import { DOCK_TAB_STORAGE_KEY, dockTabFrom, persistDockTab, type DockTab } from "./labDockTabs";
import { ExpandAllContext } from "./flowmap/expandContext";
import { LAB_FACES, setLabFace, useLabFace } from "../state/labFace";
import { lensFrom, WorkflowLens, type LabLens } from "./workflow/WorkflowLens";
import type { WorkflowDeclaration } from "./workflowGraph";
import { rowsPrefFrom, type RowsPref } from "./flowmap/workerGrid";
import { AnalyzeRun } from "../components/AnalyzeRun";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The card-view choice survives tab switches and reloads (TextView pattern). */
export const VIEW_STORAGE_KEY = "spectroscope.lab.view";
/** The lens choice persists the same way (card 293). */
export const LENS_STORAGE_KEY = "spectroscope.lab.lens";
/** And the worker-row choice (card 296). */
export const ROWS_STORAGE_KEY = "spectroscope.lab.rows";
/** And the dock's panel choice (card 301). Re-exported beside the lab's other
 *  storage keys so a reader finds all four in one place; the pair that reads
 *  and writes it lives in labDockTabs.ts. */
export { DOCK_TAB_STORAGE_KEY } from "./labDockTabs";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** The write half of the lens persistence — `pickLens` routes through this,
 *  and `lensFrom` (WorkflowLens) is the read half. Exported so the gate can
 *  bite the key and the round-trip without a DOM to click in. */
export function persistLens(next: LabLens): void {
  try {
    localStorage.setItem(LENS_STORAGE_KEY, next);
  } catch {
    // private mode: the toggle simply does not stick
  }
}

function storedView(): string | null {
  return stored(VIEW_STORAGE_KEY);
}

/** The write half of the row preference (card 296) — `rowsPrefFrom` in
 *  workerGrid is the read half. Exported so the gate can bite the key and the
 *  round-trip without a DOM to click in. */
export function persistRowsPref(next: RowsPref): void {
  try {
    localStorage.setItem(ROWS_STORAGE_KEY, String(next));
  } catch {
    // private mode: the choice simply does not stick
  }
}

// Pane-resize clamps: neither side pane shrinks below its minimum, and the
// centre always keeps room for the stepper visuals.
const LAB_CHAT_MIN_WIDTH_PX = 220;
const LAB_TRACE_MIN_WIDTH_PX = 200;
/** The context dock (card 300): wide enough for a peak, its bar and the
 *  sentence that says what the bar is a share of. */
const LAB_CTX_MIN_WIDTH_PX = 260;
const LAB_CENTER_MIN_WIDTH_PX = 420;

export function LabView(props: {
  /** The open archive, or null for the live run (mirrors App's replay state).
   *  `declared` (card 302) rides beside the events, never in them: what the
   *  imported run's own state file said about its columns, when the pick
   *  carried one. Absent is the normal case and the workflow lens says so. */
  replay: { id: string; events: RunEvent[]; declared?: WorkflowDeclaration } | null;
  /** App's raw live event list — the source for backToLive(). */
  liveEvents: RunEvent[];
  /** True while the live run is active (drives the "waiting" hint). */
  running: boolean;
  /** The selected LLM backend, so the Map can show remote vs local honestly. */
  provider?: string;
  /** The current model name, shown in the Map's LLM node. */
  model?: string;
  onSend: (text: string, attachments?: PendingAttachment[]) => void;
  onDecide: (callId: string, allowed: boolean, opts?: { remember?: boolean; persist?: boolean }) => void;
  onReturnToLive: () => void;
  /** Present only for resumable archives — passed through to the Lab's chat. */
  onResume?: () => void;
  /** Present only for deletable archives — passed through to the Lab's chat. */
  onDelete?: () => void;
  /** Passed through to the Lab's own Chat — its composer gear needs it too. */
  sendClient: (msg: ClientMessage) => boolean;
  /** App's focusInTrace seam (card 301): a click on a handover or a file row
   *  lands the trace on the event that recorded it. Absent = the dock's rows
   *  render but do not navigate. */
  onFocusEvent?: (agentId: string, event: RunEvent) => void;
}) {
  const st = useStepper();
  const lang = useLang();
  // The master face of the map's tool panels (card 120): moving it re-faces
  // open panels too — a per-panel pick holds only until the next move here.
  const labFace = useLabFace();
  const { replay, liveEvents } = props;

  // Compact vs expanded agent cards (owner switch): expanded provides the
  // engine's ExpandAllContext — every disclosure open, the context beside the
  // agent, the prompt beside the user — exactly the edu lessons' reading.
  // Default (card 287, owner-decided): replay and import open expanded (the
  // player), live opens compact; an explicit choice wins and sticks.
  // Which dock panel is showing (card 301). One at a time, so only that
  // panel's fold ever runs — see the note at the top of LabDock.tsx.
  const [dockTab, setDockTab] = useState<DockTab>(() => dockTabFrom(stored(DOCK_TAB_STORAGE_KEY)));
  const pickDockTab = (next: DockTab): void => {
    setDockTab(next);
    persistDockTab(next);
  };
  const [expanded, setExpanded] = useState<boolean>(() => labViewDefault(storedView(), replay !== null));
  const pickView = (next: boolean): void => {
    setExpanded(next);
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, next ? "expanded" : "compact");
    } catch {
      // private mode: the toggle simply does not stick
    }
  };
  // Opening or closing an archive re-derives the default — but only while the
  // user has never chosen (a stored value makes labViewDefault ignore the flip).
  useEffect(() => {
    setExpanded(labViewDefault(storedView(), replay !== null));
  }, [replay]);

  // The lens (card 293): machine = today's system map, workflow = the run's
  // spawn tree reconstructed from its events. Same persistence pattern as the
  // compact/expanded toggle above.
  const [lens, setLens] = useState<LabLens>(() => lensFrom(stored(LENS_STORAGE_KEY)));
  const pickLens = (next: LabLens): void => {
    setLens(next);
    persistLens(next);
  };

  // How deep the worker cards stack (card 296). A PREFERENCE on top of the
  // corrected default: auto derives the rows from the seats and the pane the
  // way the map always did, and is what a reader who never touches this gets.
  const [rowsPref, setRowsPref] = useState<RowsPref>(() => rowsPrefFrom(stored(ROWS_STORAGE_KEY)));
  const pickRowsPref = (next: RowsPref): void => {
    setRowsPref(next);
    persistRowsPref(next);
  };

  // Flow = paced auto-play: a timer calls step() every intervalMs (fine/coarse
  // honoured by step itself). An empty queue makes step() a no-op, so live
  // events that arrive later play out at the chosen pace instead of teleporting.
  useEffect(() => {
    if (st.mode !== "flow") return;
    const id = setInterval(() => step(), st.intervalMs);
    return () => clearInterval(id);
  }, [st.mode, st.intervalMs]);

  // Keep the stepper's source in sync with what the app is viewing: opening an
  // archive steps that archive; closing it steps the live run again.
  const liveEventsRef = useRef(liveEvents);
  liveEventsRef.current = liveEvents;
  useEffect(() => {
    if (replay !== null) {
      loadReplay(replay.id, replay.events);
    } else {
      backToLive(liveEventsRef.current);
    }
  }, [replay]);

  // The main agent's system prompt for the Flow map's "System-Kontext" section
  // — the same stateless GET the right panel uses (what THIS server sends to
  // the LLM before any message).
  const [sysPrompt, setSysPrompt] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/context")
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        if (alive && c && typeof c.systemPrompt === "string") setSysPrompt(c.systemPrompt);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // Permission: the dialog appears when the user STEPS ONTO the request (the
  // server is genuinely parked on the future meanwhile — the token sits at the
  // gate). Once answered, the callId hides locally until the decision event is
  // stepped; replays never ask (their decisions are already in the file).
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    if (st.applied.length === 0) setAnswered(new Set());
  }, [st.applied.length]);

  // The workflow lens reconstructs from the FULL known timeline (applied +
  // still-queued), while the cursor — applied — lights it. Same (events, upto)
  // pair the machine lens follows.
  const allEvents = useMemo(() => [...st.applied, ...st.queue], [st.applied, st.queue]);

  const viewingLive = st.source === "live";
  const pendingPermission = useMemo(
    () => (viewingLive ? st.ui.pendingPermissions.find((p) => !answered.has(p.callId)) : undefined),
    [viewingLive, st.ui.pendingPermissions, answered],
  );
  const decide = (
    callId: string,
    allowed: boolean,
    opts?: { remember?: boolean; persist?: boolean },
  ): void => {
    setAnswered((prev) => new Set(prev).add(callId));
    props.onDecide(callId, allowed, opts);
  };

  // Resizable/collapsible panes: the chat (left) and JSONL (right) can be dragged
  // or collapsed to give the stepper more room; widths persist across tab switches.
  const layout = useLayout();
  const rowRef = useRef<HTMLDivElement>(null);
  const resizeChat = (clientX: number): void => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r)
      setChatW(
        Math.max(LAB_CHAT_MIN_WIDTH_PX, Math.min(clientX - r.left, r.width - LAB_CENTER_MIN_WIDTH_PX)),
      );
  };
  // A right-anchored pane's width is the distance from the pointer to that
  // pane's OWN right edge. It used to be measured against the row's right
  // edge, which was the same thing while the JSONL strip was the last child;
  // with the context dock behind it (card 300) it no longer is, and a drag
  // measured against the row would jump by the dock's width. The row's right
  // edge stays the fallback for a pane that is not mounted.
  const paneRight = (selector: string): number | null => {
    const el = rowRef.current?.querySelector(selector);
    return el === null || el === undefined ? null : el.getBoundingClientRect().right;
  };
  const resizeTrace = (clientX: number): void => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r)
      setTraceW(
        Math.max(
          LAB_TRACE_MIN_WIDTH_PX,
          Math.min((paneRight(".lab-trace") ?? r.right) - clientX, r.width - LAB_CENTER_MIN_WIDTH_PX),
        ),
      );
  };
  const resizeCtx = (clientX: number): void => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r)
      setCtxW(
        Math.max(
          LAB_CTX_MIN_WIDTH_PX,
          Math.min((paneRight(".lab-ctx") ?? r.right) - clientX, r.width - LAB_CENTER_MIN_WIDTH_PX),
        ),
      );
  };
  const rowClass = `lab-row${layout.chatOpen ? "" : " lab-row--chat-collapsed"}${layout.traceOpen ? "" : " lab-row--trace-collapsed"}`;
  const rowStyle = {
    "--lab-chat-w": `${layout.chatW}px`,
    "--lab-trace-w": `${layout.traceW}px`,
    "--lab-ctx-w": `${layout.ctxW}px`,
  } as CSSProperties;

  return (
    <div className={rowClass} ref={rowRef} style={rowStyle}>
      <Chat
        state={st.ui}
        liveView={viewingLive}
        onSend={props.onSend}
        onReturnToLive={props.onReturnToLive}
        onResume={props.onResume}
        onDelete={props.onDelete}
        sendClient={props.sendClient}
      />
      <Resizer
        collapsed={!layout.chatOpen}
        chevron="right"
        label="Chat"
        onResize={resizeChat}
        onToggle={toggleChat}
      />

      <section className="lab-center" aria-label="System-Map (Flow)">
        <LabTransport
          running={props.running}
          trailing={
            <>
              {/* The lens (card 293): which PROJECTION the centre shows. */}
              <div className="lab-seg lab-lens-seg" role="group" aria-label={t(lang, "lab.lensAria")}>
                <span className="lab-seg-label mono" title={t(lang, "lab.lensHint")}>
                  {t(lang, "lab.lens")}
                </span>
                <button
                  type="button"
                  className={lens === "machine" ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                  aria-pressed={lens === "machine"}
                  title={t(lang, "lab.lensMachineTitle")}
                  onClick={() => pickLens("machine")}
                >
                  {t(lang, "lab.lensMachine")}
                </button>
                <button
                  type="button"
                  className={lens === "workflow" ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                  aria-pressed={lens === "workflow"}
                  title={t(lang, "lab.lensWorkflowTitle")}
                  onClick={() => pickLens("workflow")}
                >
                  {t(lang, "lab.lensWorkflow")}
                </button>
              </div>
              {/* The face and compact/expanded segments only affect the
                  machine lens, so they hide under the workflow lens — a
                  control that does nothing is the worse default (card 293
                  re-review). Drop the guard to bring them back. */}
              {lens === "machine" && (
                <>
                  {/* The labelled master, trace-parity (the trace's "hauptschalter"
                      precedent): its buttons reuse the shared face labels. */}
                  <div className="lab-seg lab-face-seg" role="group" aria-label={t(lang, "lab.faceAria")}>
                    <span className="lab-seg-label mono" title={t(lang, "lab.faceHint")}>
                      {t(lang, "lab.face")}
                    </span>
                    {LAB_FACES.map((f) => (
                      <button
                        key={f}
                        type="button"
                        className={labFace.face === f ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                        aria-pressed={labFace.face === f}
                        title={t(lang, `lab.faceTitle.${f}`)}
                        onClick={() => setLabFace(f)}
                      >
                        {t(lang, `trace.mode.${f}`)}
                      </button>
                    ))}
                  </div>
                  {/* The rows preference steers the EXPANDED seating only —
                      sceneToFlow passes opts.rowsPref into rowsFor on the
                      expanded branch and seats compact from SEAT_ROWS_COMPACT
                      — so it follows the same doctrine as the guard above and
                      hides in compact (card 296 re-review). A live run with no
                      stored choice opens compact, which is exactly where a
                      clickable control that changes nothing would have been
                      met first. */}
                  {expanded && (
                    <div className="lab-seg lab-rows-seg" role="group" aria-label={t(lang, "lab.rowsAria")}>
                      <span className="lab-seg-label mono" title={t(lang, "lab.rowsHint")}>
                        {t(lang, "lab.rows")}
                      </span>
                      {(["auto", 2, 3] as const).map((r) => (
                        <button
                          key={String(r)}
                          type="button"
                          className={rowsPref === r ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                          aria-pressed={rowsPref === r}
                          title={t(lang, r === "auto" ? "lab.rowsAutoTitle" : `lab.rows${r}Title`)}
                          onClick={() => pickRowsPref(r)}
                        >
                          {r === "auto" ? t(lang, "lab.rowsAuto") : String(r)}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="lab-seg lab-view-seg" role="group" aria-label={t(lang, "lab.viewAria")}>
                    <button
                      type="button"
                      className={!expanded ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                      aria-pressed={!expanded}
                      title={t(lang, "lab.viewCompactTitle")}
                      onClick={() => pickView(false)}
                    >
                      {t(lang, "lab.viewCompact")}
                    </button>
                    <button
                      type="button"
                      className={expanded ? "lab-seg-btn lab-seg-btn--active" : "lab-seg-btn"}
                      aria-pressed={expanded}
                      title={t(lang, "lab.viewExpandedTitle")}
                      onClick={() => pickView(true)}
                    >
                      {t(lang, "lab.viewExpanded")}
                    </button>
                  </div>
                </>
              )}
            </>
          }
        >
          {lens === "workflow" ? (
            <WorkflowLens
              events={allEvents}
              declared={replay?.declared}
              applied={st.applied}
              scene={st.scene}
              model={props.model}
              analyze={
                /* Card 294: only an IMPORTED run offers the one-shot analysis;
                   nothing is sent at import — the affordance is a click away. */
                replay !== null && replay.id.startsWith("import:") ? (
                  <AnalyzeRun viewKey={replay.id} events={allEvents} />
                ) : undefined
              }
            />
          ) : (
            <ExpandAllContext.Provider value={expanded}>
              <FlowMap
                scene={st.scene}
                applied={st.applied}
                provider={props.provider}
                model={props.model}
                systemPrompt={sysPrompt ?? undefined}
                rowsPref={rowsPref}
                // CARD 306: the declaration reaches the MAP now, not only the
                // lens. Without it the map drew a run's agents as loose cards
                // with nothing saying which phase any of them ran in.
                declared={replay?.declared}
              />
            </ExpandAllContext.Provider>
          )}
        </LabTransport>

        <LabHint />
      </section>

      <Resizer
        collapsed={!layout.traceOpen}
        chevron="left"
        label="JSONL"
        onResize={resizeTrace}
        onToggle={toggleTrace}
      />
      <LabTrace applied={st.applied} queue={st.queue} fireSeq={st.fireSeq} />

      {/* The context dock (card 300). Its two neighbours stay MOUNTED while
          collapsed and hide in CSS — the terminal's idiom, where folding must
          not kill a shell. This one has no such state, and mounting it would
          run deriveDetail over the whole applied prefix on every step for a
          panel nobody opened, so a closed dock is genuinely absent. */}
      <Resizer
        collapsed={!layout.ctxOpen}
        chevron="left"
        /* The rail names the panel it will OPEN, not the dock in general — a
           collapsed dock that says "context" while it would open the file list
           is a label that lies. */
        label={t(lang, dockTitleKey(dockTab))}
        onResize={resizeCtx}
        onToggle={toggleCtx}
      />
      {layout.ctxOpen && (
        <LabDock
          tab={dockTab}
          onPickTab={pickDockTab}
          applied={st.applied}
          /* The whole run for the moments panel — the same `applied` plus
             `queue` the transport's scrub bar and its ticks already walk. */
          stream={[...st.applied, ...st.queue]}
          /* The workspace the canon knows, for shortening displayed paths. A
             replay and an import have none, and then nothing is shortened. */
          workspaceRoot={st.ui.workspace?.path ?? null}
          onFocusEvent={props.onFocusEvent}
        />
      )}

      {pendingPermission !== undefined && (
        <PermissionDialog
          key={pendingPermission.callId}
          permission={pendingPermission}
          index={0}
          total={st.ui.pendingPermissions.length}
          workspaceConfigured={st.ui.workspace?.configured ?? false}
          onDecide={decide}
        />
      )}
    </div>
  );
}
