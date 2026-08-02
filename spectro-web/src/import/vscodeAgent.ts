// The VS Code / GitHub Copilot agent-mode export adapter. That export is JSONL
// of records shaped { type, data, id, timestamp, parentId } — a dotted type
// namespace with the whole payload under `data`. This maps them onto
// spectroscope's RunEvent stream:
//   user.message             -> run_start (the first one opens the run, later
//                               ones re-open it so each renders as a user turn)
//   assistant.turn_start     -> turn_start
//   assistant.message        -> thinking_delta / text_delta / tool_call
//   tool.execution_start     -> tool_call
//   tool.execution_complete  -> tool_result
// so a recorded Copilot session replays through the same reducers as a
// spectroscope run. Unrecognized records are skipped, never fatal.
//
// WHAT THIS FORMAT CANNOT GIVE US: tool.execution_complete carries nothing but
// { toolCallId, success }. There is no tool output anywhere in the export, so
// every tool_result leaves `output` empty. Filling it with a phrase like "(no
// output recorded)" would be indistinguishable from a tool that really returned
// that text — the absence is reported once, by the importer, from the "kind"
// detectAndLoad returns.

import type { RunEvent } from "../events";
import type { ImportedEvents } from "./claudeCode";

interface VsToolRequest {
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
}

interface VsRecord {
  type?: string;
  data?: {
    turnId?: string;
    messageId?: string;
    content?: string;
    toolRequests?: VsToolRequest[];
    reasoningText?: string;
    toolCallId?: string;
    toolName?: string;
    arguments?: unknown;
    success?: boolean;
  };
  id?: string;
  timestamp?: string;
}

/** Every record in a real export carries an ISO 8601 timestamp. A file that
 *  lost one still has to fold in order, so it borrows a synthetic step — the
 *  same fallback the Claude Code adapter uses. */
const SYNTHETIC_TS_STEP_MS = 1000;

const tsOf = (r: VsRecord, i: number, base: number): number => {
  const parsed = r.timestamp ? Date.parse(r.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : base + i * SYNTHETIC_TS_STEP_MS;
};

const asRecord = (r: unknown): VsRecord | null =>
  r && typeof r === "object" && !Array.isArray(r) ? (r as VsRecord) : null;

/** The two announcement sites disagree about the type of `arguments`:
 *  tool.execution_start carries an object, assistant.message.toolRequests
 *  carries the same payload as a JSON string. Decode the string form so a call
 *  known only from a toolRequests entry reaches the card as fields rather than
 *  as escaped JSON. Anything that does not parse is passed through untouched —
 *  it is still what the export said. */
function decodeArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null ? parsed : value;
  } catch {
    return value;
  }
}

export function vscodeAgentToRunEvents(records: unknown[], base = 1_783_500_000_000): RunEvent[] {
  return vscodeAgentWithOrigin(records, base).events;
}

/** The stream plus the line each frame came from; see {@link ImportedEvents}. */
export function vscodeAgentWithOrigin(records: unknown[], base = 1_783_500_000_000): ImportedEvents {
  // As in the Claude Code adapter: a dropped record still occupies a line.
  const recs: VsRecord[] = [];
  const recLine: number[] = [];
  records.forEach((r, i) => {
    const v = asRecord(r);
    if (v !== null) {
      recs.push(v);
      recLine.push(i);
    }
  });
  const out: RunEvent[] = [];
  const origin: number[] = [];
  const chargeTo = (line: number): void => {
    while (origin.length < out.length) origin.push(line);
  };
  const runId = "vscode-import";
  const agentId = "main";

  // Every tool call is announced twice: once in assistant.message.toolRequests
  // and once as tool.execution_start. execution_start is the better source (it
  // is stamped at the moment the call ran, and it is the record the duration is
  // measured from), so the announcement only fills in for calls that never got
  // one — measured in the real export, four completions arrive with no start.
  const startedCallIds = new Set<string>();
  for (const r of recs) {
    const id = r.type === "tool.execution_start" ? r.data?.toolCallId : undefined;
    if (typeof id === "string") startedCallIds.add(id);
  }

  const emittedCalls = new Set<string>();
  const callStartTs = new Map<string, number>();
  let started = false;
  let turn = 0;
  let lastTs = base;

  const emitCall = (callId: string, name: string, input: unknown, ts: number): void => {
    if (emittedCalls.has(callId)) return;
    emittedCalls.add(callId);
    out.push({ type: "tool_call", agentId, callId, name, input, ts });
  };

  /** An export can begin mid-session (the real one opens on a tool record).
   *  Everything downstream hangs off a run, so open one — with an empty prompt,
   *  because the request that started this slice is simply not in the file. */
  const openRun = (prompt: string, ts: number): void => {
    started = true;
    out.push({ type: "run_start", runId, agentId, prompt, ts });
  };

  const handleRecord = (r: VsRecord, i: number): void => {
    const ts = tsOf(r, i, base);
    lastTs = ts;
    const d = r.data;

    switch (r.type) {
      case "user.message": {
        // Re-opening the run under the SAME runId is what puts a user bubble in
        // the chat; the reducer draws one per root run_start.
        openRun(typeof d?.content === "string" ? d.content : "", ts);
        break;
      }

      case "assistant.turn_start": {
        if (!started) openRun("", ts);
        // turnId is a per-request counter that restarts (fifteen distinct values
        // across 189 records in the real export), so position is the only key.
        out.push({ type: "turn_start", agentId, turn: ++turn, ts });
        break;
      }

      case "assistant.message": {
        if (!started) openRun("", ts);
        const reasoning = typeof d?.reasoningText === "string" ? d.reasoningText : "";
        const content = typeof d?.content === "string" ? d.content : "";
        // Empty blocks would render as empty activities and empty stream slices.
        if (reasoning !== "") out.push({ type: "thinking_delta", agentId, text: reasoning, ts });
        if (content !== "") out.push({ type: "text_delta", agentId, text: content, ts });
        for (const req of d?.toolRequests ?? []) {
          const callId = req?.toolCallId;
          if (typeof callId !== "string" || startedCallIds.has(callId)) continue;
          emitCall(
            callId,
            typeof req.name === "string" ? req.name : "tool",
            decodeArguments(req.arguments),
            ts,
          );
        }
        break;
      }

      case "tool.execution_start": {
        if (!started) openRun("", ts);
        const callId = d?.toolCallId;
        if (typeof callId !== "string") break;
        callStartTs.set(callId, ts);
        emitCall(callId, typeof d?.toolName === "string" ? d.toolName : "tool", d?.arguments, ts);
        break;
      }

      case "tool.execution_complete": {
        if (!started) openRun("", ts);
        const callId = d?.toolCallId;
        if (typeof callId !== "string") break;
        const startTs = callStartTs.get(callId);
        out.push({
          type: "tool_result",
          agentId,
          callId,
          output: "", // the export records no tool output; see the file header
          isError: d?.success === false,
          durationMs: startTs === undefined ? 0 : Math.max(0, ts - startTs),
          ts,
        });
        break;
      }

      // assistant.turn_end has no counterpart on the wire: a turn ends where the
      // next one starts, and the run ends with the file.
      default:
        break;
    }
  };

  recs.forEach((r, i) => {
    handleRecord(r, i);
    chargeTo(recLine[i]);
  });

  if (started) out.push({ type: "run_end", runId, stopReason: "end_turn", ts: lastTs });
  chargeTo(-1); // the closing run_end is the importer's own
  return { events: out, origin: Int32Array.from(origin) };
}

export function parseVscodeAgentExport(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return vscodeAgentToRunEvents(records);
}
