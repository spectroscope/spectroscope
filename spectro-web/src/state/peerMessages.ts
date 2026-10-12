// Card 503: the chat's record of agent messaging, as pure data.
//
// A message reaches the reducer two ways. The socket-only `peer_message`
// frame carries what the app knows at once: a message this session sent or
// received, a held one waiting for Deliver or Decline, a status that came back,
// a send that failed. The `agent_message` record with role `peer` is what the
// session file keeps: `sent` when an agent of this run sent one, `received`
// when the loop took one in, the msg_id in `label`. Both fold into ONE block
// per msg_id, so a stored session rebuilds the blocks its sidecar and its file
// describe through the same case a live one uses (criterion 9).

import type { RunEvent } from "../events";
import type { AgentInfo, Turn, UiState } from "./reducer";
import { pairSafeCut } from "../pairSafeCut";

/** The block of one message. */
export type MessageTurn = Extract<Turn, { kind: "message" }>;

/**
 * Card 506: the label of a workflow summariser's task message, followed by the
 * step id (WorkflowRunner.SUMMARISER_LABEL_PREFIX in Java). The summariser's
 * message to its parent is the run's answer and stays in the main thread.
 */
export const WORKFLOW_SUMMARISER_LABEL_PREFIX = "workflow:";

/** The six delivery states of card 502, plus the two a block starts in. */
export type MessageStatus =
  "queued" | "received" | "held" | "denied" | "expired" | "delivered" | "refused" | "dropped";

const STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "received",
  "held",
  "denied",
  "expired",
  "delivered",
  "refused",
  "dropped",
]);

/** How far along a message is: a later state never gives way to an earlier one. */
const RANK: Record<MessageStatus, number> = {
  queued: 0,
  received: 0,
  held: 1,
  delivered: 2,
  denied: 2,
  expired: 2,
  refused: 2,
  dropped: 2,
};

/** The patch one frame or record brings to a block. */
interface Patch {
  msgId: string;
  direction?: "sent" | "received";
  from?: string;
  to?: string;
  fromSession?: string;
  time?: number;
  status?: MessageStatus;
  summary?: string;
  text?: string;
  agentId?: string;
  replay?: boolean;
  reason?: string;
  answer?: boolean;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function status(value: unknown): MessageStatus | undefined {
  return typeof value === "string" && STATUSES.has(value) ? (value as MessageStatus) : undefined;
}

function firstLine(text: string): string {
  const line = text.trim().split("\n")[0] ?? "";
  return pairSafeCut(line, 200);
}

/** Applies one patch: a new block at the end, or the block of the same msg_id updated in place. */
function upsert(state: UiState, patch: Patch): UiState {
  const at = state.turns.findIndex((t) => t.kind === "message" && t.msgId === patch.msgId);
  if (at < 0) {
    const text = patch.text ?? "";
    const turn: MessageTurn = {
      kind: "message",
      direction: patch.direction ?? "received",
      from: patch.from ?? "",
      to: patch.to ?? "",
      ...(patch.fromSession !== undefined ? { fromSession: patch.fromSession } : {}),
      time: patch.time ?? Date.now(),
      status: patch.status ?? (patch.direction === "sent" ? "queued" : "received"),
      summary: patch.summary ?? firstLine(text),
      text,
      msgId: patch.msgId,
      ...(patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
      ...(patch.replay === true ? { replay: true } : {}),
      ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      ...(patch.answer === true ? { answer: true } : {}),
    };
    return { ...state, turns: [...state.turns, turn] };
  }
  const old = state.turns[at] as MessageTurn;
  const nextStatus =
    patch.status !== undefined && RANK[patch.status] >= RANK[old.status as MessageStatus]
      ? patch.status
      : old.status;
  const merged: MessageTurn = {
    ...old,
    from: old.from !== "" ? old.from : (patch.from ?? ""),
    to: old.to !== "" ? old.to : (patch.to ?? ""),
    ...(old.fromSession === undefined && patch.fromSession !== undefined
      ? { fromSession: patch.fromSession }
      : {}),
    time: patch.time !== undefined && patch.time < old.time ? patch.time : old.time,
    status: nextStatus,
    summary: old.summary !== "" ? old.summary : (patch.summary ?? firstLine(patch.text ?? "")),
    text: old.text !== "" ? old.text : (patch.text ?? ""),
    ...(old.agentId === undefined && patch.agentId !== undefined ? { agentId: patch.agentId } : {}),
    ...(patch.replay === true ? { replay: true } : {}),
    ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
  };
  const turns = [...state.turns];
  turns[at] = merged;
  return { ...state, turns };
}

/**
 * Folds one socket-only `peer_message` frame.
 *
 * @param state the state the frame lands on
 * @param raw   the frame
 * @returns the state with the block added or updated, or a line for a send
 *          that failed, an idle notice or a rename
 */
export function foldPeerFrame(state: UiState, raw: unknown): UiState {
  const f = raw as Record<string, unknown>;
  const kind = str(f.kind);
  const direction = f.direction === "sent" ? "sent" : "received";
  const ts = typeof f.ts === "number" ? f.ts : Date.now();
  const msgId = str(f.msgId);
  if (kind === "send_failed") {
    const reason = str(f.reason) ?? "";
    return {
      ...state,
      turns: [
        ...state.turns,
        {
          kind: "info",
          text: reason,
          tone: "warn",
          infoKey: "msg.sendFailed",
          infoVars: { to: str(f.name) ?? "", reason },
        },
      ],
    };
  }
  if (kind === "idle_notice" || kind === "rename") {
    const name = str(f.name) ?? "";
    return {
      ...state,
      turns: [
        ...state.turns,
        kind === "idle_notice"
          ? {
              kind: "info",
              text: str(f.notice) ?? name,
              tone: "neutral",
              infoKey: "msg.idleNotice",
              infoVars: { name },
            }
          : {
              kind: "info",
              text: name,
              tone: "neutral",
              infoKey: "msg.renamed",
              infoVars: { old: str(f.reason) ?? "", name },
            },
      ],
    };
  }
  if (msgId === undefined) return state;
  const replay = f.replay === true ? { replay: true } : {};
  if (kind === "message" || kind === "held") {
    const text = typeof f.text === "string" ? f.text : "";
    return upsert(state, {
      msgId,
      direction,
      from: direction === "sent" ? str(f.from) : (str(f.from) ?? str(f.name)),
      to: direction === "sent" ? str(f.name) : undefined,
      fromSession: str(f.fromSession),
      time: ts,
      status: kind === "held" ? "held" : (status(f.status) ?? (direction === "sent" ? "queued" : "received")),
      summary: str(f.summary),
      text,
      ...replay,
    });
  }
  if (kind === "status") {
    return upsert(state, {
      msgId,
      direction,
      to: direction === "sent" ? str(f.name) : undefined,
      time: ts,
      status: status(f.status),
      reason: str(f.reason),
      ...replay,
    });
  }
  return state;
}

/** The children of this session's runs, the agents a message can belong to. */
function childIds(agents: readonly AgentInfo[]): Set<string> {
  return new Set(agents.filter((a) => a.parentId !== null).map((a) => a.id));
}

/**
 * Folds one `agent_message` record with role `peer`.
 *
 * @param state the state the record lands on
 * @param event the record
 * @returns the state with the block added or updated
 */
export function foldPeerRecord(state: UiState, event: Extract<RunEvent, { type: "agent_message" }>): UiState {
  const msgId = str(event.label);
  if (msgId === undefined) return state;
  const children = childIds(state.agents);
  const sent = event.state === "sent";
  // Card 506: a workflow summariser's message to its parent is the run's
  // answer; it stays in the main thread and is drawn in full there.
  const answer = !sent && !children.has(event.to) && isSummariser(state.agents, event.from);
  const agentId = answer
    ? undefined
    : children.has(event.from)
      ? event.from
      : children.has(event.to)
        ? event.to
        : undefined;
  return upsert(state, {
    msgId,
    direction: sent ? "sent" : "received",
    from: event.from,
    to: event.to,
    time: event.ts,
    status: sent ? "queued" : "delivered",
    text: event.text,
    summary: firstLine(event.text),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(answer ? { answer: true } : {}),
  });
}

/** Whether an agent is a child a workflow started as its summariser. */
function isSummariser(agents: readonly AgentInfo[], id: string): boolean {
  const agent = agents.find((a) => a.id === id);
  return (
    agent !== undefined &&
    agent.parentId !== null &&
    (agent.label ?? "").startsWith(WORKFLOW_SUMMARISER_LABEL_PREFIX)
  );
}

/**
 * Card 503, criterion 9: a stored session's events with the frames its
 * `.messages.jsonl` sidecar gave, merged by time. A frame goes after every
 * event of its own millisecond, so a record and the frame about the same
 * message stay in the order they happened.
 *
 * @param events the session's events as stored
 * @param frames the frames of GET /api/sessions/{id}/messages
 * @returns the merged list; the same list when there are no frames
 */
export function mergePeerFrames(events: RunEvent[], frames: readonly unknown[]): RunEvent[] {
  const usable = frames.filter(
    (f): f is Record<string, unknown> =>
      typeof f === "object" && f !== null && (f as { type?: unknown }).type === "peer_message",
  );
  if (usable.length === 0) return events;
  const ordered = [...usable].sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
  const out: RunEvent[] = [];
  let j = 0;
  for (const event of events) {
    const at = Number((event as { ts?: unknown }).ts ?? 0);
    while (j < ordered.length && Number(ordered[j].ts ?? 0) < at) {
      out.push(ordered[j++] as unknown as RunEvent);
    }
    out.push(event);
  }
  while (j < ordered.length) out.push(ordered[j++] as unknown as RunEvent);
  return out;
}

/**
 * Card 503, criterion 9: the frames of a stored session's `.messages.jsonl`.
 * Silent on failure: a session without messages, or a server that has no
 * such route, is a session whose chat shows none.
 *
 * @param id        the stored session
 * @param fetchImpl the fetch to use; the page's own by default
 * @returns the frames, possibly empty
 */
export async function fetchPeerFrames(
  id: string,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<unknown[]> {
  try {
    const res = await fetchImpl(`/api/sessions/${encodeURIComponent(id)}/messages`);
    if (!res.ok) return [];
    const body: unknown = await res.json();
    return Array.isArray(body) ? body : [];
  } catch {
    return [];
  }
}
