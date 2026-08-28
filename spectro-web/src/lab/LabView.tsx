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
import { setChatW, setTraceW, toggleChat, toggleTrace, useLayout } from "../state/layout";
import type { PendingAttachment } from "../components/AttachmentPreview";
import { backToLive, loadReplay, step, useStepper } from "../state/stepper";
import { labViewDefault } from "./labViewDefault";
import { LabHint } from "./LabControls";
import { LabTransport } from "./LabTransport";
import { FlowMap } from "./FlowMap";
import { LabTrace } from "./LabTrace";
import { ExpandAllContext } from "./flowmap/expandContext";
import { LAB_FACES, setLabFace, useLabFace } from "../state/labFace";
import { lensFrom, WorkflowLens, type LabLens } from "./workflow/WorkflowLens";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";

/** The card-view choice survives tab switches and reloads (TextView pattern). */
const VIEW_STORAGE_KEY = "spectroscope.lab.view";
/** The lens choice persists the same way (card 293). */
export const LENS_STORAGE_KEY = "spectroscope.lab.lens";

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

// Pane-resize clamps: neither side pane shrinks below its minimum, and the
// centre always keeps room for the stepper visuals.
const LAB_CHAT_MIN_WIDTH_PX = 220;
const LAB_TRACE_MIN_WIDTH_PX = 200;
const LAB_CENTER_MIN_WIDTH_PX = 420;

export function LabView(props: {
  /** The open archive, or null for the live run (mirrors App's replay state). */
  replay: { id: string; events: RunEvent[] } | null;
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
  const resizeTrace = (clientX: number): void => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r)
      setTraceW(
        Math.max(LAB_TRACE_MIN_WIDTH_PX, Math.min(r.right - clientX, r.width - LAB_CENTER_MIN_WIDTH_PX)),
      );
  };
  const rowClass = `lab-row${layout.chatOpen ? "" : " lab-row--chat-collapsed"}${layout.traceOpen ? "" : " lab-row--trace-collapsed"}`;
  const rowStyle = {
    "--lab-chat-w": `${layout.chatW}px`,
    "--lab-trace-w": `${layout.traceW}px`,
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
            <WorkflowLens events={allEvents} applied={st.applied} scene={st.scene} model={props.model} />
          ) : (
            <ExpandAllContext.Provider value={expanded}>
              <FlowMap
                scene={st.scene}
                applied={st.applied}
                provider={props.provider}
                model={props.model}
                systemPrompt={sysPrompt ?? undefined}
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
