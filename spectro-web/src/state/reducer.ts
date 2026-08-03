// (state, event) => state — the ONLY place UI state is derived. The live
// socket stream and the replay of a stored session run through this exact
// function; replay is not a separate code path. Pure and framework-free, the
// same mental figure as buildGraph.

import type { ClientMessage, RunEvent } from "../events";

export interface ToolCard {
  callId: string;
  agentId: string;
  name: string;
  input: unknown;
  status: "pending" | "ok" | "error";
  output?: string;
  durationMs?: number;
  permission?: "pending" | "allowed" | "denied";
  /** ts of the tool_call event — drives the live duration count-up. */
  startedAt: number;
}

/** Thumbnail bytes for the user bubble — UI state only, never an event. */
export type UserAttachment = { name: string; mediaType: string; dataBase64: string };

export type Turn =
  | { kind: "user"; text: string; attachments?: UserAttachment[] }
  | {
      kind: "assistant";
      agentId: string;
      text: string;
      thinking: string;
      /** Set from this turn's `usage` event: the tokens the answer cost, and how
       *  long the turn took (its first event → the usage). Undefined until it
       *  arrives (a torn/streaming turn simply has no footer yet). The two cache
       *  counts are additive on the wire and stay optional here: absent means the
       *  provider reported no cache, which is not the same as a cache of zero. */
      usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens?: number;
        cacheCreationTokens?: number;
      };
      durationMs?: number;
      /** The usage event's ts — the answer's END wall-clock; start derives as
       *  endTs - durationMs (card 87). */
      endTs?: number;
      /** The model that produced this answer (run_start.model, card 87). */
      model?: string;
    }
  | { kind: "tool"; callId: string }
  /** agentId marks an info line that belongs to a subagent's thread (spawn). */
  | {
      kind: "info";
      text: string;
      tone: "neutral" | "warn";
      agentId?: string;
      /** Optional i18n key + vars — set by the reducer for its own info lines so
       *  the chat can render them in the live chrome language; `text` stays the
       *  English fallback (and keeps old tests/callers working). */
      infoKey?: string;
      infoVars?: Record<string, string | number>;
    }
  | { kind: "error"; text: string };

export interface PendingPermission {
  callId: string;
  agentId: string;
  name: string;
  input: unknown;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** One frame in the wire view (trace tab): dir "in" for RunEvents from the
 *  server, dir "out" for ClientMessages this UI sent. payload keeps the raw
 *  object — the trace shows what crossed the socket, not an interpretation. */
export interface TraceEntry {
  seq: number;
  dir: "in" | "out";
  ts: number;
  type: string;
  agentId?: string;
  /** The model serving the run this row belongs to (card 87) — from the last
   *  run_start's additive model; blank outside runs and in old archives. */
  model?: string;
  /** For an imported session: the index, counted from zero, of the FILE's line
   *  this frame came from. Absent on a frame the importer built itself, and on
   *  every row of a session that was produced here, where the wire line IS the
   *  stored line and there is no separate source to point at. */
  sourceLine?: number;
  payload: unknown;
}

/** Latest context_info snapshot (additive) — the context ring's
 *  introspection data. char/4 estimates; the usage events are the truth. */
export interface ContextSnapshot {
  turn: number;
  messages: number;
  estimatedTokens: number;
  threshold: number;
  parts: { label: string; chars: number; estTokens: number; text?: string }[];
}

/** One generated image — everything the gallery card needs. */
export interface GeneratedImage {
  callId: string;
  prompt: string;
  provider: string;
  model: string;
  mediaType: string;
  blobPath: string;
  sha256: string;
  ts: number;
}

/**
 * One agent in the session-wide roster (the Agents overview reads this). The
 * main agent is entry 0; every spawned subagent is appended. Folded from
 * agent_spawn / agent_message / usage and NEVER cleared on run_end — only a New
 * chat (a fresh UiState) resets it.
 */
export interface AgentInfo {
  id: string;
  parentId: string | null;
  /** The dev tool that spawned it ("build_plan", …) or null (main / plain spawn). */
  label: string | null;
  task: string;
  state: "submitted" | "working" | "completed" | "failed";
  lastStatus: string | null;
  inTokens: number;
  outTokens: number;
}

/** One step of the agent's plan (from the additive `plan` event). Wire status
 *  values stay English (pending / in_progress / completed); the UI translates. */
export interface PlanStep {
  text: string;
  status: string;
}

/** Where THIS session's agent works — from the socket-only workspace_info
 *  frame (never in the JSONL; archives replay without it). */
export interface WorkspaceInfo {
  sessionId: string;
  path: string;
  /** true when the workspace comes from the config, false for the
   *  per-session temp folder. */
  configured: boolean;
}

/** The ACTIVE LLM backend — from the socket-only provider_info frame, sent on
 *  connect and after every provider switch (never in the JSONL). The header
 *  chip, the map locality and the trace host column read wire truth from it
 *  instead of trusting optimistic client state. */
export interface ProviderInfo {
  provider: string;
  model: string;
  /** The network counterpart, e.g. "api.anthropic.com" or "localhost:11434". */
  host: string;
}

export interface UiState {
  turns: Turn[];
  /** tool_call + tool_result, paired by callId. */
  cards: Record<string, ToolCard>;
  pendingPermissions: PendingPermission[];
  /** Session totals across every run seen by this state. */
  usage: TokenUsage;
  /** The current (or most recently finished) run only. */
  runUsage: TokenUsage;
  running: boolean;
  /** Internal: only the root run's run_end may end "running". */
  rootRunId: string | null;
  /** From run_start.provider (additive) — the header chip. */
  provider: string | null;
  /** stopReason of the last finished root run ("end_turn", "aborted", ...). */
  lastStopReason: string | null;
  /** Generated images in arrival order — the gallery panel. */
  images: GeneratedImage[];
  /** Wire view (trace tab): every frame in arrival order. The fold keeps all of
   *  them; only a live stream is bounded, by {@link windowTrace} at its seam. */
  trace: TraceEntry[];
  /** Latest context_info snapshot — latest wins, null until the first one. */
  context: ContextSnapshot | null;
  /** inputTokens of the LAST usage event of the main agent — the context
   *  ring's live value (the provider reports the true request size). */
  lastInputTokens: number;
  /** True while thinking_delta is streaming for the current turn and no answer
   *  text or tool call has arrived yet — drives the live "thinking…" indicator. */
  thinkingActive: boolean;
  /** Parked on send, picked up by the root run_start case — the user
   *  bubble is created by the reducer, so there is no local echo to hang the
   *  thumbnails on. */
  outboxAttachments: UserAttachment[] | null;
  /** Session-wide agent roster (main + every subagent), persisted across runs. */
  agents: AgentInfo[];
  /** Latest `plan` snapshot (additive) — latest-wins, null until the
   *  first update_plan, cleared only by a fresh UiState (New chat). */
  plan: PlanStep[] | null;
  /** The session's workspace announcement — the Files tab reads it. */
  workspace: WorkspaceInfo | null;
  /** The active backend announcement — latest wins (connect + every switch). */
  providerInfo: ProviderInfo | null;
  /** The last SUCCESSFUL otlp export (card 137): wire truth for the deep link.
   *  A later failure does not clear it, because the trace it created still
   *  exists in the backend. The endpoint is the one that actually received the
   *  spans, taken from the frame, never from Settings (which can be edited
   *  after the fact). */
  lastOtlpExport: { endpoint: string; ts: number } | null;
  /** The last export outcome, successful or not, for the honest failure line. */
  lastOtlpOutcome: { ok: boolean; message?: string } | null;
  /** The current (or last) run's model id — run_start.model wins, provider_info
   *  is the live fallback; the trace rows and answer footers read it (card 87). */
  runModel: string | null;
  /** The active permission mode ("ask" | "auto" | "readonly") — from the
   *  socket-only permission_mode_info frame, sent on connect and after every
   *  switch. Defaults to "ask" so a state built without ever seeing the frame
   *  (e.g. a bare initialState in a test) still matches the server's default. */
  permissionMode: string;
  /** ts of the current assistant turn's first event, per agent — so the `usage`
   *  event can stamp each answer's duration. Transient bookkeeping, not shown. */
  assistantTurnStart: Record<string, number>;
}

export const initialState: UiState = {
  turns: [],
  cards: {},
  pendingPermissions: [],
  usage: { inputTokens: 0, outputTokens: 0 },
  runUsage: { inputTokens: 0, outputTokens: 0 },
  running: false,
  rootRunId: null,
  provider: null,
  lastStopReason: null,
  images: [],
  trace: [],
  context: null,
  lastInputTokens: 0,
  thinkingActive: false,
  outboxAttachments: null,
  agents: [],
  plan: null,
  workspace: null,
  providerInfo: null,
  lastOtlpExport: null,
  lastOtlpOutcome: null,
  runModel: null,
  permissionMode: "ask",
  assistantTurnStart: {},
};

/** Upsert an agent by id; patch is a partial or a function of the current row. */
function upsertAgent(
  agents: AgentInfo[],
  id: string,
  patch: Partial<AgentInfo> | ((a: AgentInfo) => Partial<AgentInfo>),
): AgentInfo[] {
  const at = agents.findIndex((a) => a.id === id);
  const blank: AgentInfo = {
    id,
    parentId: null,
    label: null,
    task: "",
    state: "submitted",
    lastStatus: null,
    inTokens: 0,
    outTokens: 0,
  };
  if (at < 0) {
    const p = typeof patch === "function" ? patch(blank) : patch;
    return [...agents, { ...blank, ...p }];
  }
  const next = [...agents];
  const p = typeof patch === "function" ? patch(next[at]) : patch;
  next[at] = { ...next[at], ...p };
  return next;
}

/** Fold one event into the session-wide agent roster (never clears it). */
function foldAgents(agents: AgentInfo[], event: RunEvent, rootRunId: string | null): AgentInfo[] {
  switch (event.type) {
    case "run_start":
      return upsertAgent(agents, event.agentId, {
        parentId: event.parentId ?? null,
        state: "working",
        ...(event.parentId == null ? { label: null } : {}),
      });
    case "agent_spawn":
      return upsertAgent(agents, event.agentId, { parentId: event.parentId, task: event.task });
    case "agent_message":
      if (event.role === "task")
        return upsertAgent(agents, event.to, {
          task: event.text,
          label: event.label ?? null,
          state: "submitted",
        });
      if (event.role === "status")
        return upsertAgent(agents, event.from, { state: "working", lastStatus: event.text });
      if (event.role === "result")
        return upsertAgent(agents, event.from, {
          state: event.state === "completed" ? "completed" : "failed",
        });
      return agents;
    case "usage":
      return upsertAgent(agents, event.agentId, (a) => ({
        inTokens: a.inTokens + event.inputTokens,
        outTokens: a.outTokens + event.outputTokens,
      }));
    case "run_end":
      // The ROOT run finished — mark the main agent done (subagents got their
      // own result message). A child's run_end has a different runId: ignore.
      if (rootRunId !== null && event.runId !== rootRunId) return agents;
      return agents.map((a) =>
        a.parentId === null && a.state === "working" ? { ...a, state: "completed" } : a,
      );
    default:
      return agents;
  }
}

const addTurn = (s: UiState, turn: Turn): UiState => ({ ...s, turns: [...s.turns, turn] });

// An append copies the trace, so a fold costs O(rows²): measured 6000 rows in
// 16 ms / +5 MB, 50 000 in 2.7 s / +116 MB. A session's worth is cheap; anything
// larger wants a batched append before it wants a bigger array.
function appendTrace(s: UiState, entry: Omit<TraceEntry, "seq">): UiState {
  const last = s.trace[s.trace.length - 1];
  return { ...s, trace: [...s.trace, { seq: (last?.seq ?? 0) + 1, ...entry }] };
}

/** How many frames a LIVE trace keeps. Measured, not picked: because an append
 *  copies the window, every live frame pays it — a 50 000-frame stream folds in
 *  164 ms at 5000 and 1.9 s at 20 000. Raising this needs the batched append. */
const LIVE_TRACE_WINDOW = 5000;

/**
 * Bound the trace of a state that is still growing — the live socket's, and only
 * that one. A stream has no end, so the array it folds into needs one; the JSONL
 * file keeps every frame either way. A finite fold (an import, an archive, a
 * replay) is whole before it starts, and windowing it would drop the oldest rows
 * of a record that fits, which for an imported transcript is where it began.
 *
 * Idempotent, and the newest row survives untouched, so `seq` keeps counting
 * from there and no two rows inside a window can share a number.
 */
export function windowTrace(state: UiState): UiState {
  const { trace } = state;
  if (trace.length <= LIVE_TRACE_WINDOW) return state;
  return { ...state, trace: trace.slice(trace.length - LIVE_TRACE_WINDOW) };
}

/** Stamp usage + duration onto the LAST assistant turn of an agent (the answer
 *  the usage belongs to). No matching turn → the turns are returned unchanged. */
function stampAssistantUsage(
  turns: Turn[],
  agentId: string,
  patch: {
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
    durationMs?: number;
    endTs?: number;
    model?: string;
  },
): Turn[] {
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.kind === "assistant" && turn.agentId === agentId) {
      const next = turns.slice();
      next[i] = { ...turn, ...patch };
      return next;
    }
  }
  return turns;
}

function patchCard(s: UiState, callId: string, patch: Partial<ToolCard>): UiState {
  const card = s.cards[callId];
  if (card === undefined) return s;
  return { ...s, cards: { ...s.cards, [callId]: { ...card, ...patch } } };
}

/**
 * Trace-tab entries for a flat, all-inbound event stream — an entered fleet's
 * frames (there are no outbound ClientMessages to a fleet). Mirrors the inbound
 * mapping {@link reduce} applies to each wire frame, so a fleet member's trace
 * reads exactly like a session's: the raw payload, uninterpreted.
 */
export function traceFromEvents(events: RunEvent[]): TraceEntry[] {
  return events.map((event, i) => {
    const raw = event as { type: string; ts?: unknown; agentId?: unknown };
    return {
      seq: i + 1,
      dir: "in" as const,
      ts: typeof raw.ts === "number" ? raw.ts : 0,
      type: raw.type,
      agentId: typeof raw.agentId === "string" ? raw.agentId : undefined,
      payload: event,
    };
  });
}

export function reduce(state: UiState, event: RunEvent): UiState {
  // EVERY incoming frame lands in the trace first — known or unknown type
  // alike. The switch below may ignore an event; the wire view must not,
  // that is its whole point.
  const raw = event as { type: string; ts?: unknown; agentId?: unknown };
  // Card 87: rows inside a run wear the run's model; the run_start row itself
  // uses its own stamp (the pre-apply state still holds the PREVIOUS run's).
  const rowModel =
    raw.type === "run_start"
      ? ((event as { model?: string }).model ?? state.providerInfo?.model)
      : (state.runModel ?? undefined);
  const traced = appendTrace(state, {
    dir: "in",
    ts: typeof raw.ts === "number" ? raw.ts : Date.now(),
    type: raw.type,
    agentId: typeof raw.agentId === "string" ? raw.agentId : undefined,
    ...(rowModel !== undefined && rowModel !== "" ? { model: rowModel } : {}),
    payload: event,
  });
  // The socket-only workspace_info frame is handled HERE, at the socket
  // boundary — the pure RunEvent switch below stays sealed to wire events.
  if (raw.type === "workspace_info") {
    const w = event as unknown as WorkspaceInfo;
    return {
      ...traced,
      workspace: { sessionId: w.sessionId, path: w.path, configured: w.configured === true },
    };
  }
  // Same boundary rule for provider_info: connect + every switch announce the
  // active backend; the chip/map/host column follow wire truth, latest wins.
  if (raw.type === "provider_info") {
    const p = event as unknown as ProviderInfo;
    const model = String(p.model ?? "");
    return {
      ...traced,
      provider: typeof p.provider === "string" ? p.provider : traced.provider,
      providerInfo: { provider: String(p.provider ?? ""), model, host: String(p.host ?? "") },
      // For a session that names its model per message (an imported transcript)
      // run_start only ever carried the first one — every switch arrives here.
      // Answers are stamped at their own usage event, so an announcement moves
      // the model for what follows and never reaches back to what is stamped.
      runModel: model !== "" ? model : traced.runModel,
    };
  }
  // Same boundary rule for otlp_export (card 137): the mirror frame is the
  // only place the browser learns that spans reached a backend, and which one.
  // Folded here rather than scanned back out of state.trace, because
  // windowTrace drops everything past LIVE_TRACE_WINDOW and a long session
  // would silently lose its link.
  if (raw.type === "otlp_export") {
    const x = event as unknown as { endpoint?: unknown; ok?: unknown; message?: unknown; ts?: unknown };
    const ok = x.ok === true;
    const endpoint = typeof x.endpoint === "string" ? x.endpoint : "";
    const ts = typeof x.ts === "number" ? x.ts : Date.now();
    return {
      ...traced,
      // Only a landed export moves this; a failure leaves the last good one
      // standing, link and all.
      lastOtlpExport: ok && endpoint !== "" ? { endpoint, ts } : traced.lastOtlpExport,
      lastOtlpOutcome: {
        ok,
        ...(typeof x.message === "string" ? { message: x.message } : {}),
      },
    };
  }
  // Same boundary rule for user_message, and for the same reason: it is not in
  // the RunEvent union, so the sealed switch below must not learn it.
  //
  // Inbound, this frame only ever comes from an import. What a person types
  // HERE goes out through recordOutgoing and never comes back — the bubble for
  // it is built by the run_start that answers it (see sendNow, which parks its
  // attachments rather than echoing a turn). So there is no path on which this
  // can double the live bubble.
  //
  // It adds a turn and nothing else. A transcript's later prompts are not run
  // boundaries: measured over 151 files, most of the 1,985 of them are slash
  // commands, their stdout, or an "[Image: …]" note the client wrote. Closing a
  // run or resetting the usage on one would be a claim the file never made.
  if (raw.type === "user_message") {
    const text = (event as unknown as { text?: unknown }).text;
    return typeof text === "string" && text !== "" ? addTurn(traced, { kind: "user", text }) : traced;
  }
  // Same boundary rule for permission_mode_info: connect + every switch
  // announce the active mode; the composer gear follows wire truth.
  if (raw.type === "permission_mode_info") {
    const m = event as unknown as { mode?: unknown };
    return { ...traced, permissionMode: typeof m.mode === "string" ? m.mode : traced.permissionMode };
  }
  // The session-wide agent roster folds separately from the UI state and uses
  // the PRE-apply rootRunId (applyEvent's run_end clears it).
  const applied = applyEvent(traced, event);
  return { ...applied, agents: foldAgents(applied.agents, event, traced.rootRunId) };
}

/** Outgoing frames (ClientMessage) enter the trace through this helper — the
 *  reducer itself stays (state, RunEvent), so replaying an archive keeps
 *  working unchanged and naturally fills the trace with dir "in" only. */
export function recordOutgoing(state: UiState, message: ClientMessage): UiState {
  return appendTrace(state, {
    dir: "out",
    ts: Date.now(),
    type: message.type,
    payload: message,
  });
}

/** UI-only trace marker for a resumed session (type "session_resume", never a
 *  wire event): sits between the re-folded history rows and everything new, so
 *  the trace shows the exact moment the old JSONL was picked back up — and the
 *  payload says how much of it rides back to the LLM with the next request. */
export function recordResumeMarker(state: UiState, payload: unknown): UiState {
  return appendTrace(state, {
    dir: "out",
    ts: Date.now(),
    type: "session_resume",
    payload,
  });
}

/** Replay placeholders show this many hex chars of an attachment's sha256. */
const ATTACHMENT_SHA_PREVIEW_CHARS = 8;

function applyEvent(state: UiState, event: RunEvent): UiState {
  switch (event.type) {
    case "run_start": {
      // Subagent runs carry parentId — they keep the run alive but get no
      // user bubble (agent_spawn already announced them).
      if (event.parentId != null) {
        return { ...state, running: true };
      }
      // Live: the root run picks up the thumbnails parked on send.
      // Replay has no bytes (the event carries only blobPath/sha256): one text
      // placeholder per attachment suffices; no blob route exists on purpose.
      const attachments = state.outboxAttachments ?? undefined;
      const placeholder =
        !attachments?.length && event.attachments?.length
          ? "\n" +
            event.attachments
              .map((a) => `[image ${a.sha256.slice(0, ATTACHMENT_SHA_PREVIEW_CHARS)}]`)
              .join(" ")
          : "";
      return addTurn(
        {
          ...state,
          running: true,
          rootRunId: event.runId,
          runUsage: { inputTokens: 0, outputTokens: 0 },
          provider: event.provider ?? state.provider,
          runModel: event.model ?? state.providerInfo?.model ?? state.runModel,
          lastStopReason: null,
          outboxAttachments: null,
        },
        {
          kind: "user",
          text: event.prompt + placeholder,
          ...(attachments?.length ? { attachments } : {}),
        },
      );
    }

    case "turn_start":
      // No UI element of its own — the next text_delta begins the block.
      return state;

    case "thinking_delta": {
      // Reasoning stream: appends to the current assistant turn's thinking buffer,
      // creating the turn if none is open for this agent. Marks thinking active —
      // the disclosure header pulses until the answer (or a tool) arrives.
      const last = state.turns[state.turns.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.agentId === event.agentId) {
        return {
          ...state,
          thinkingActive: true,
          turns: [...state.turns.slice(0, -1), { ...last, thinking: last.thinking + event.text }],
        };
      }
      return addTurn(
        {
          ...state,
          thinkingActive: true,
          assistantTurnStart: { ...state.assistantTurnStart, [event.agentId]: event.ts },
        },
        { kind: "assistant", agentId: event.agentId, text: "", thinking: event.text },
      );
    }

    case "text_delta": {
      // The answer begins: thinking for this turn is settled (the buffer stays for
      // the disclosure, but the live indicator stops).
      const last = state.turns[state.turns.length - 1];
      if (last !== undefined && last.kind === "assistant" && last.agentId === event.agentId) {
        return {
          ...state,
          thinkingActive: false,
          turns: [...state.turns.slice(0, -1), { ...last, text: last.text + event.text }],
        };
      }
      return addTurn(
        {
          ...state,
          thinkingActive: false,
          assistantTurnStart: { ...state.assistantTurnStart, [event.agentId]: event.ts },
        },
        { kind: "assistant", agentId: event.agentId, text: event.text, thinking: "" },
      );
    }

    case "tool_call": {
      const card: ToolCard = {
        callId: event.callId,
        agentId: event.agentId,
        name: event.name,
        input: event.input,
        status: "pending",
        startedAt: event.ts,
      };
      return addTurn(
        { ...state, thinkingActive: false, cards: { ...state.cards, [card.callId]: card } },
        { kind: "tool", callId: card.callId },
      );
    }

    case "permission_request": {
      // Idempotent per callId — replay and live must not queue duplicates.
      if (state.pendingPermissions.some((p) => p.callId === event.callId)) return state;
      const next = patchCard(state, event.callId, { permission: "pending" });
      return {
        ...next,
        pendingPermissions: [
          ...next.pendingPermissions,
          { callId: event.callId, agentId: event.agentId, name: event.name, input: event.input },
        ],
      };
    }

    case "permission_decision": {
      const next = patchCard(state, event.callId, {
        permission: event.allowed ? "allowed" : "denied",
      });
      return {
        ...next,
        pendingPermissions: next.pendingPermissions.filter((p) => p.callId !== event.callId),
      };
    }

    case "tool_result":
      return patchCard(state, event.callId, {
        output: event.output,
        durationMs: event.durationMs,
        status: event.isError ? "error" : "ok",
      });

    case "agent_spawn":
      return addTurn(state, {
        kind: "info",
        text: `Subagent ${event.agentId} spawned: ${event.task}`,
        infoKey: "info.spawned",
        infoVars: { id: event.agentId, task: event.task },
        tone: "neutral",
        agentId: event.agentId, // groups the line into the child's chat thread
      });

    case "compaction":
      return addTurn(state, {
        kind: "info",
        text: `History compacted: ${event.removedTurns} turns summarized`,
        infoKey: "info.compacted",
        infoVars: { n: event.removedTurns },
        tone: "warn",
      });

    case "usage": {
      const start = state.assistantTurnStart[event.agentId];
      return {
        ...state,
        // The per-message footer: this turn's token cost + how long it took.
        // The cache counts are spread in only when the provider sent them —
        // a synthesised zero would read as "nothing was cached", which is a
        // claim about a provider that said nothing at all.
        turns: stampAssistantUsage(state.turns, event.agentId, {
          usage: {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            ...(event.cacheReadTokens !== undefined ? { cacheReadTokens: event.cacheReadTokens } : {}),
            ...(event.cacheCreationTokens !== undefined
              ? { cacheCreationTokens: event.cacheCreationTokens }
              : {}),
          },
          durationMs: start !== undefined ? Math.max(0, event.ts - start) : undefined,
          endTs: event.ts,
          ...(state.runModel !== null ? { model: state.runModel } : {}),
        }),
        usage: {
          inputTokens: state.usage.inputTokens + event.inputTokens,
          outputTokens: state.usage.outputTokens + event.outputTokens,
        },
        runUsage: {
          inputTokens: state.runUsage.inputTokens + event.inputTokens,
          outputTokens: state.runUsage.outputTokens + event.outputTokens,
        },
        // The context ring reads the LAST request size of the main agent —
        // subagent usage has its own window and must not move the gauge.
        // With Anthropic prompt caching, inputTokens is only the UNCACHED
        // remainder; the additive cache counts complete the true window fill.
        lastInputTokens:
          event.agentId === "main"
            ? event.inputTokens + (event.cacheReadTokens ?? 0) + (event.cacheCreationTokens ?? 0)
            : state.lastInputTokens,
      };
    }

    case "run_end":
      // A subagent's run_end must not flip the UI to "ready" mid-run.
      if (state.rootRunId !== null && event.runId !== state.rootRunId) return state;
      return {
        ...state,
        running: false,
        rootRunId: null,
        thinkingActive: false,
        lastStopReason: event.stopReason,
      };

    case "error":
      return addTurn(state, { kind: "error", text: event.message });

    case "image_generated": {
      // Idempotent per callId — a reconnect replays the session history and
      // must not duplicate gallery entries. Replay uses this same path.
      if (state.images.some((i) => i.callId === event.callId)) return state;
      const image: GeneratedImage = {
        callId: event.callId,
        prompt: event.prompt,
        provider: event.provider,
        model: event.model,
        mediaType: event.mediaType,
        blobPath: event.blobPath,
        sha256: event.sha256,
        ts: event.ts,
      };
      return { ...state, images: [...state.images, image] };
    }

    case "context_info":
      // No chat turn — introspection feeds the context ring and the trace
      // only. Latest snapshot wins.
      return {
        ...state,
        context: {
          turn: event.turn,
          messages: event.messages,
          estimatedTokens: event.estimatedTokens,
          threshold: event.threshold,
          parts: event.parts,
        },
      };

    case "plan":
      // No chat turn — the Plan tab renders this snapshot. Latest wins, exactly
      // like context_info.
      return { ...state, plan: event.steps };

    default:
      // Unknown event types are ignored — forward compatibility. Frontends
      // never crash because the core learned a new event.
      return state;
  }
}

/** Replay and frame batches: whole event lists through the same reducer. The
 *  fold is complete for both — a caller whose stream has no end windows the
 *  result, so forgetting costs memory rather than the start of a record. */
export const reduceAll = (s: UiState, events: RunEvent[]): UiState => events.reduce(reduce, s);

/** Normalize a replayed archive: nothing runs and no question is open — even
 *  if the stored session ended without a run_end (crash, abort, old file). */
export function normalizeReplay(state: UiState): UiState {
  return { ...state, running: false, rootRunId: null, thinkingActive: false, pendingPermissions: [] };
}
