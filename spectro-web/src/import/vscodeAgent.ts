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
//   session.start            -> ground_info {cwd} (the GitHub Copilot CLI's own
//                               file, card 605; import-only, as in claudeCode.ts);
//                               its selectedModel names the model of run_start
// Every run_start names the provider copilot (card 605, final wave item 5), so
// the files report can say where the content went.
// so a recorded Copilot session replays through the same reducers as a
// spectroscope run. Unrecognized records are skipped, never fatal.
//
// TOOL OUTPUT (card 605, task 10): tool.execution_complete records what the
// tool returned in data.result.content (95 of 103 completions in the IDE
// export, 294 of 297 in the CLI store), and a failure its data.error. The
// output is that content, plus one line "<code>: <message>" of a failure's
// error. A completion without either leaves `output` empty: a phrase like "(no
// output recorded)" would read as a tool that really returned that text, so the
// adapter counts them (ToolOutputCount) and the import says how many, once
// (components/importBar.ts). Two fields have no wire field and stay unread: result.detailedContent (the file
// diff of an edit or create) and shellExecution.exitCode. The counts are a
// census of both local corpora on 2026-11-10 (task 10 report).

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
    result?: unknown;
    error?: unknown;
    context?: { cwd?: unknown };
    selectedModel?: unknown;
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

/** A string field of an object, or null. */
function strField(o: unknown, key: string): string | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "string" ? v : null;
}

/** What a completion recorded the tool returned: result.content, then a failure's "code: message".
 *  `recorded` is false when the record held neither, so the output is an absence, not a value. */
function toolOutput(d: VsRecord["data"]): { output: string; recorded: boolean } {
  const filled = (parts: (string | null)[]) => parts.filter((x): x is string => x !== null && x !== "");
  const content = strField(d?.result, "content");
  const lines = filled([content]);
  if (d?.success === false) {
    const said = filled([strField(d.error, "code"), strField(d.error, "message")]);
    if (said.length > 0) lines.push(said.join(": "));
  }
  return { output: lines.join("\n"), recorded: content !== null || lines.length > 0 };
}

/** How many tool results of a file the record held no output for, of all of them. */
export interface ToolOutputCount {
  missing: number;
  total: number;
}

/** The stream, the line of each frame and the count of results without output. */
export interface VscodeImport extends ImportedEvents {
  toolOutputs: ToolOutputCount;
}

export function vscodeAgentToRunEvents(records: unknown[], base = 1_783_500_000_000): RunEvent[] {
  return vscodeAgentWithOrigin(records, base).events;
}

/** The stream plus the line each frame came from; see {@link ImportedEvents}. */
export function vscodeAgentWithOrigin(records: unknown[], base = 1_783_500_000_000): VscodeImport {
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

  /** A non-empty selectedModel of a session.start, else null. */
  const selectedModel = (r: VsRecord): string | null =>
    r.type === "session.start" && typeof r.data?.selectedModel === "string" && r.data.selectedModel !== ""
      ? r.data.selectedModel
      : null;
  // The model of the last session.start; a run opened before any names none.
  let model: string | null = null;

  const emittedCalls = new Set<string>();
  const callStartTs = new Map<string, number>();
  /** The tool of each call id, for the completion: a successful create made its file. */
  const callTool = new Map<string, string>();
  let started = false;
  let turn = 0;
  let lastTs = base;
  /** The folder the last session.start named, so a resume in the same folder adds nothing. */
  let cwd: string | null = null;
  const toolOutputs: ToolOutputCount = { missing: 0, total: 0 };

  const emitCall = (callId: string, name: string, input: unknown, ts: number): void => {
    if (emittedCalls.has(callId)) return;
    emittedCalls.add(callId);
    callTool.set(callId, name);
    out.push({ type: "tool_call", agentId, callId, name, input, ts });
  };

  /** An export can begin mid-session (the real one opens on a tool record).
   *  Everything downstream hangs off a run, so open one — with an empty prompt,
   *  because the request that started this slice is simply not in the file. */
  const openRun = (prompt: string, ts: number): void => {
    started = true;
    out.push({
      type: "run_start",
      runId,
      agentId,
      prompt,
      provider: "copilot",
      ...(model === null ? {} : { model }),
      ts,
    });
  };

  const handleRecord = (r: VsRecord, i: number): void => {
    const ts = tsOf(r, i, base);
    lastTs = ts;
    const d = r.data;

    switch (r.type) {
      case "session.start": {
        model = selectedModel(r) ?? model;
        // An absolute POSIX path only: the files tab joins relative paths with `/`.
        const at = d?.context?.cwd;
        if (typeof at !== "string" || !at.startsWith("/") || at === cwd) break;
        out.push({
          type: "ground_info",
          cwd: at,
          ...(cwd === null ? {} : { from: { cwd } }),
          ts,
        } as unknown as RunEvent);
        cwd = at;
        break;
      }

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
        const { output, recorded } = toolOutput(d);
        toolOutputs.total++;
        if (!recorded) toolOutputs.missing++;
        out.push({
          type: "tool_result",
          agentId,
          callId,
          output,
          isError: d?.success === false,
          durationMs: startTs === undefined ? 0 : Math.max(0, ts - startTs),
          // The CLI's create writes a new file: 17 of 17 local creates answer "Created file" (card 605).
          ...(callTool.get(callId) === "create" && d?.success === true ? { fileChange: "created" } : {}),
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
  return { events: out, origin: Int32Array.from(origin), toolOutputs };
}

export function parseVscodeAgentExport(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return vscodeAgentToRunEvents(records);
}
