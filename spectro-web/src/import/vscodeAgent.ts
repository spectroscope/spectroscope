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
//   subagent.started         -> agent_spawn + the child's run_start
//   subagent.completed       -> the child's run_end
//   session.usage_record     -> usage
//   session.error            -> error {message}
//   abort                    -> error "aborted: <reason>"
//   session.start            -> ground_info {cwd} (the GitHub Copilot CLI's own
//                               file, card 605; import-only, as in claudeCode.ts)
// so a recorded Copilot session replays through the same reducers as a
// spectroscope run. Unrecognized records are skipped, never fatal. A file that
// opens on a turn or a tool record opens a run with an empty prompt; an error
// or an abort before the first run stands alone, and a usage record or a spawn
// waits for the first run (task 11 item 9).
//
// MODEL (card 605, task 10): every run_start names the provider copilot, so the
// files report can say where the content went, and the model in force for that
// run. session.start's selectedModel is "auto" in the CLI store (5 of 29 that
// name one) and in the IDE export (4 of 4); the model auto mode picked is in
// session.auto_mode_resolved.chosenModel, a switch in session.model_change's
// newModel. A run takes the latest of those two at or before its first
// assistant turn, else the first one after that turn within the run, else the
// selectedModel of the latest session.start when it is not "auto". A switch to
// "auto" ends the model in force until auto mode resolves, and "auto" alone
// names no model. A child's run takes the model of its subagent.started.
//
// LANES (card 605, task 10): a record's top-level agentId, when it names a
// child (a non-empty string other than "main"), is the agentId of every frame
// the record produces; the CLI store writes it on 1,546 of its 2,649 records,
// the IDE export on none. A child follows the Claude Code importer's idiom: its
// spawn and its own run open at subagent.started, with the prompt of the
// parent's task call (joined on toolCallId) as the task; it numbers its own
// turns; its run ends at subagent.completed, the child's own last record. Its
// user.message is that same task (28 of 28 in the store) and gives no frame,
// so it never reads as a prompt somebody typed.
//
// ERRORS (card 605, task 10): session.error gives an error with its message,
// else its errorType. The wire's `abort` is a client command (ClientMessage in
// events.ts), not a recorded event, so a recorded abort (8 in the CLI store,
// each with a string reason) gives an error "aborted", plus ": <reason>" when
// the reason is a string. session.warning stays unread: the wire has no
// warning event.
//
// USAGE (card 605, task 10): the CLI store writes session.usage_record per
// call, the IDE export none. Its data.usage.inputTokens counts the cache reads
// and writes inside it: inputTokens >= cacheReadTokens + cacheWriteTokens on
// 232 of 232 records, and on all 204 with a cache write the rest is smaller
// than that write (census, 2026-11-10). The wire's inputTokens is the uncached
// remainder, so the importer takes both out: inputTokens - cacheReadTokens -
// cacheWriteTokens, never below zero; cacheReadTokens and, from
// cacheWriteTokens, cacheCreationTokens ride beside it when the record names
// them. aiCredits stays out: spectro-core's Copilot provider computes it from
// copilotUsage.totalNanoAiu, no field of that name and meaning exists here.
//
// TOOL OUTPUT (card 605, task 10): tool.execution_complete records what the
// tool returned in data.result.content (95 of 103 completions in the IDE
// export, 294 of 297 in the CLI store), and a failure its data.error. The
// output is that content, plus one line "<code>: <message>" of a failure's
// error. A completion without either leaves `output` empty: a phrase like "(no
// output recorded)" would read as a tool that really returned that text, so the
// adapter counts them (ToolOutputCount) and the import says how many, once
// (components/importBar.ts). Two fields have no wire field and stay unread:
// result.detailedContent (the file diff of an edit or create) and
// shellExecution.exitCode. The counts are a census of both local corpora on
// 2026-11-10 (task 10 report).

import type { RunEvent } from "../events";
import type { ImportedEvents } from "./claudeCode";

interface VsToolRequest {
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
}

interface VsRecord {
  type?: string;
  /** The lane: absent or "main" on the main agent's records, the child's id on a child's. */
  agentId?: unknown;
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
    /** session.auto_mode_resolved: the model auto mode picked. */
    chosenModel?: unknown;
    /** session.model_change: the model switched to. */
    newModel?: unknown;
    /** subagent.started: the child's model. */
    model?: unknown;
    /** session.usage_record: one call's bill. */
    usage?: unknown;
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

const MAIN = "main";

/** The lane of a record: its agentId when that names a child, else main. */
const laneOf = (r: VsRecord): string =>
  typeof r.agentId === "string" && r.agentId !== "" && r.agentId !== MAIN ? r.agentId : MAIN;

/** A count of a usage record: a finite number not below zero, else null. */
function count(o: unknown, key: string): number | null {
  if (typeof o !== "object" || o === null) return null;
  const v = (o as Record<string, unknown>)[key];
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

/** A model name: a non-empty string other than "auto", else null. */
const modelName = (v: unknown): string | null =>
  typeof v === "string" && v !== "" && v !== "auto" ? v : null;

/** A child's task, from its parent's task call: the prompt, else the description, else the Claude Code importer's word. */
function taskOf(input: unknown): string {
  return strField(input, "prompt") || strField(input, "description") || "subtask";
}

/** Either announcement site can carry `arguments` as a string:
 *  assistant.message.toolRequests carries the payload as a JSON string, and
 *  tool.execution_start carries the IDE export's apply_patch as the patch text
 *  itself (9 of 9 local calls, none of them JSON). Decode a JSON string so the
 *  call reaches the card as fields rather than as escaped JSON. Anything that
 *  does not parse to an object is passed through untouched: it is still what
 *  the export said. */
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

  // Every tool call is announced twice: once in assistant.message.toolRequests
  // and once as tool.execution_start. execution_start is the better source (it
  // is stamped at the moment the call ran, and it is the record the duration is
  // measured from), so the announcement only fills in for calls that never got
  // one — measured in the real export, four completions arrive with no start.
  const startedCallIds = new Set<string>();
  /** Each call's lane and input, for the spawn its toolCallId names. */
  const calls = new Map<string, { agentId: string; input: unknown }>();
  for (const r of recs) {
    const id = r.type === "tool.execution_start" ? r.data?.toolCallId : undefined;
    if (typeof id === "string") {
      startedCallIds.add(id);
      calls.set(id, { agentId: laneOf(r), input: decodeArguments(r.data?.arguments) });
    }
  }

  /** A non-empty selectedModel of a session.start, else null. */
  const selectedModel = (r: VsRecord): string | null =>
    r.type === "session.start" && typeof r.data?.selectedModel === "string" && r.data.selectedModel !== ""
      ? r.data.selectedModel
      : null;
  // The selectedModel of the last session.start; a run opened before any names none.
  let selected: string | null = null;
  /** Each choice of a model in record order; `model` is null for a switch to auto. */
  const choices: { at: number; model: string | null }[] = [];
  /** The record index of each main-lane assistant turn or message. */
  const turnsAt: number[] = [];
  /** Each root run_start: where it sits in `out`, the record that opened it, the selectedModel then. */
  const roots: { index: number; at: number; selected: string | null }[] = [];

  const emittedCalls = new Set<string>();
  const callStartTs = new Map<string, number>();
  /** The tool of each call id, for the completion: a successful create made its file. */
  const callTool = new Map<string, string>();
  let started = false;
  /** Turns are per agent, as in the Claude Code importer. */
  const turns = new Map<string, number>();
  const nextTurn = (agentId: string): number => {
    const n = (turns.get(agentId) ?? 0) + 1;
    turns.set(agentId, n);
    return n;
  };
  /** Each spawned child's run id, and the children whose run has ended. */
  const childRuns = new Map<string, string>();
  const ended = new Set<string>();
  let lastTs = base;
  /** The folder the last session.start named, so a resume in the same folder adds nothing. */
  let cwd: string | null = null;
  const toolOutputs: ToolOutputCount = { missing: 0, total: 0 };

  const emitCall = (agentId: string, callId: string, name: string, input: unknown, ts: number): void => {
    if (emittedCalls.has(callId)) return;
    emittedCalls.add(callId);
    callTool.set(callId, name);
    out.push({ type: "tool_call", agentId, callId, name, input, ts });
  };

  /** Frames that wait for the first run, each charged to its own record's line
   *  (task 11 item 9): a run_start resets the run's usage, and a spawn belongs
   *  to the run that follows. */
  const held: { events: RunEvent[]; line: number }[] = [];
  const flushHeld = (): void => {
    for (const h of held) {
      out.push(...h.events);
      while (origin.length < out.length) origin.push(h.line);
    }
    held.length = 0;
  };
  /** Pushes the frames now when a run is open, else holds them for the first one. */
  const emitInRun = (events: RunEvent[], at: number): void => {
    if (started) out.push(...events);
    else held.push({ events, line: recLine[at] });
  };

  /** An export can begin mid-session (the real one opens on a tool record).
   *  Everything downstream hangs off a run, so open one, with an empty prompt,
   *  because the request that started this slice is simply not in the file.
   *  An error, an abort, a usage record or a spawn opens none (task 11 item 9). */
  const openRun = (prompt: string, ts: number, at: number): void => {
    started = true;
    roots.push({ index: out.length, at, selected });
    // The model is named after the pass, when the run's turns and choices are known.
    out.push({ type: "run_start", runId, agentId: MAIN, prompt, provider: "copilot", ts });
    if (held.length > 0) {
      chargeTo(recLine[at]);
      flushHeld();
    }
  };

  const handleRecord = (r: VsRecord, i: number): void => {
    const ts = tsOf(r, i, base);
    lastTs = ts;
    const d = r.data;
    const agentId = laneOf(r);

    switch (r.type) {
      case "session.start": {
        selected = selectedModel(r) ?? selected;
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
        // A child's message is its task, already on its spawn and its run.
        if (agentId !== MAIN) break;
        // Re-opening the run under the SAME runId is what puts a user bubble in
        // the chat; the reducer draws one per root run_start.
        openRun(typeof d?.content === "string" ? d.content : "", ts, i);
        break;
      }

      case "assistant.turn_start": {
        if (!started) openRun("", ts, i);
        if (agentId === MAIN) turnsAt.push(i);
        // turnId is a per-request counter that restarts (fifteen distinct values
        // across 189 records in the real export), so position is the only key.
        out.push({ type: "turn_start", agentId, turn: nextTurn(agentId), ts });
        break;
      }

      case "assistant.message": {
        if (!started) openRun("", ts, i);
        if (agentId === MAIN) turnsAt.push(i);
        const reasoning = typeof d?.reasoningText === "string" ? d.reasoningText : "";
        const content = typeof d?.content === "string" ? d.content : "";
        // Empty blocks would render as empty activities and empty stream slices.
        if (reasoning !== "") out.push({ type: "thinking_delta", agentId, text: reasoning, ts });
        if (content !== "") out.push({ type: "text_delta", agentId, text: content, ts });
        for (const req of d?.toolRequests ?? []) {
          const callId = req?.toolCallId;
          if (typeof callId !== "string" || startedCallIds.has(callId)) continue;
          emitCall(
            agentId,
            callId,
            typeof req.name === "string" ? req.name : "tool",
            decodeArguments(req.arguments),
            ts,
          );
        }
        break;
      }

      case "tool.execution_start": {
        if (!started) openRun("", ts, i);
        const callId = d?.toolCallId;
        if (typeof callId !== "string") break;
        callStartTs.set(callId, ts);
        emitCall(
          agentId,
          callId,
          typeof d?.toolName === "string" ? d.toolName : "tool",
          decodeArguments(d?.arguments),
          ts,
        );
        break;
      }

      case "tool.execution_complete": {
        if (!started) openRun("", ts, i);
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

      case "subagent.started": {
        // A start on the main lane names no child; a replayed one spawns it once.
        if (agentId === MAIN || childRuns.has(agentId)) break;
        const call = typeof d?.toolCallId === "string" ? calls.get(d.toolCallId) : undefined;
        const parentId = call === undefined || call.agentId === agentId ? MAIN : call.agentId;
        const task = taskOf(call?.input);
        const childRun = `vscode-${agentId}`;
        childRuns.set(agentId, childRun);
        const childModel = modelName(d?.model);
        emitInRun(
          [
            { type: "agent_spawn", agentId, parentId, task, ts },
            {
              type: "run_start",
              runId: childRun,
              agentId,
              parentId,
              prompt: task,
              provider: "copilot",
              ...(childModel === null ? {} : { model: childModel }),
              ts,
            },
          ],
          i,
        );
        break;
      }

      case "session.usage_record": {
        const u = d?.usage;
        const input = count(u, "inputTokens");
        const output = count(u, "outputTokens");
        if (input === null && output === null) break;
        const read = count(u, "cacheReadTokens");
        const written = count(u, "cacheWriteTokens");
        emitInRun(
          [
            {
              type: "usage",
              agentId,
              inputTokens: Math.max(0, (input ?? 0) - (read ?? 0) - (written ?? 0)),
              outputTokens: output ?? 0,
              ...(read === null ? {} : { cacheReadTokens: read }),
              ...(written === null ? {} : { cacheCreationTokens: written }),
              ts,
            },
          ],
          i,
        );
        break;
      }

      case "session.error": {
        const message = strField(d, "message") || strField(d, "errorType");
        if (!message) break;
        // No run opens for it: an error before the first person's turn stands
        // alone, and the chat draws it without one (task 11 item 7).
        out.push({ type: "error", agentId, message, ts });
        break;
      }

      case "abort": {
        // Like session.error: no run opens for it.
        const reason = strField(d, "reason");
        out.push({ type: "error", agentId, message: reason ? `aborted: ${reason}` : "aborted", ts });
        break;
      }

      case "session.auto_mode_resolved":
      case "session.model_change": {
        const named = r.type === "session.model_change" ? d?.newModel : d?.chosenModel;
        if (typeof named === "string" && named !== "") choices.push({ at: i, model: modelName(named) });
        break;
      }

      case "subagent.completed": {
        const childRun = childRuns.get(agentId);
        if (childRun === undefined || ended.has(agentId)) break;
        ended.add(agentId);
        out.push({ type: "run_end", runId: childRun, stopReason: "end_turn", ts });
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

  // The model in force for each root run (see the file header).
  roots.forEach((run, k) => {
    const end = roots[k + 1]?.at ?? Infinity;
    const turn = turnsAt.find((at) => at >= run.at && at < end);
    const until = turn ?? end;
    let latest: (typeof choices)[number] | undefined;
    for (const c of choices) if (c.at < until) latest = c;
    let model = latest?.model ?? null;
    if (model === null && turn !== undefined)
      model = choices.find((c) => c.at > turn && c.at < end && c.model !== null)?.model ?? null;
    if (model === null && latest === undefined) model = modelName(run.selected);
    if (model !== null) out[run.index] = { ...out[run.index], model } as RunEvent;
  });

  // Held frames with no run after them stand alone.
  flushHeld();
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
