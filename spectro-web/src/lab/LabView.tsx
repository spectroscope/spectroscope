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
import { LabHint } from "./LabControls";
import { LabTransport } from "./LabTransport";
import { FlowMap } from "./FlowMap";
import { LabTrace } from "./LabTrace";

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
  onDecide: (
    callId: string,
    allowed: boolean,
    opts?: { remember?: boolean; persist?: boolean },
  ) => void;
  onReturnToLive: () => void;
  /** Present only for resumable archives — passed through to the Lab's chat. */
  onResume?: () => void;
  /** Present only for deletable archives — passed through to the Lab's chat. */
  onDelete?: () => void;
  /** Passed through to the Lab's own Chat — its composer gear needs it too. */
  sendClient: (msg: ClientMessage) => boolean;
}) {
  const st = useStepper();
  const { replay, liveEvents } = props;

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
    if (r) setChatW(Math.max(LAB_CHAT_MIN_WIDTH_PX,
        Math.min(clientX - r.left, r.width - LAB_CENTER_MIN_WIDTH_PX)));
  };
  const resizeTrace = (clientX: number): void => {
    const r = rowRef.current?.getBoundingClientRect();
    if (r) setTraceW(Math.max(LAB_TRACE_MIN_WIDTH_PX,
        Math.min(r.right - clientX, r.width - LAB_CENTER_MIN_WIDTH_PX)));
  };
  const rowClass =
    `lab-row${layout.chatOpen ? "" : " lab-row--chat-collapsed"}${layout.traceOpen ? "" : " lab-row--trace-collapsed"}`;
  const rowStyle = { "--lab-chat-w": `${layout.chatW}px`, "--lab-trace-w": `${layout.traceW}px` } as CSSProperties;

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
        <LabTransport running={props.running}>
          <FlowMap scene={st.scene} applied={st.applied} provider={props.provider} model={props.model} systemPrompt={sysPrompt ?? undefined} />
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
