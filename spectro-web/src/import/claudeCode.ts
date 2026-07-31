// The Claude Code transcript adapter. A Claude Code session file is JSONL of
// user/assistant records whose `message.content` holds blocks (text, thinking,
// tool_use, tool_result). This maps them onto spectroscope's RunEvent stream:
//   tool_use            -> tool_call        (name = Task/Agent -> agent_spawn)
//   tool_result block   -> tool_result
//   text / thinking     -> text_delta / thinking_delta
//   message.usage       -> usage
//   <task-notification> -> tool_result on the launch it belongs to (see below)
// so a real recorded session replays through the same reducers as a spectroscope run.
// Unrecognized records are skipped, never fatal — real transcripts vary.
// Ported from the LLM_Simulator; keep the two in sync.

import type { RunEvent } from "../events";

interface CCRecord {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
    /** Assistant records name the model that produced them; it can change
     *  mid-file (a /model switch, or a subagent on another model). */
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      /** Anthropic prompt caching. Additive on our wire too: absent means the
       *  provider reported none, which is not the same as zero. */
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp?: string;
}

interface CCBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Records without a timestamp get synthetic ones this far apart. */
const SYNTHETIC_TS_STEP_MS = 1000;

/**
 * A background task reporting back.
 *
 * Three separate things in the file make one event here: a `Workflow`/`Monitor`
 * tool_use launches it, its tool_result is a RECEIPT naming a task id, and much
 * later an unrelated user-role message carries a `<task-notification>` block.
 * Only the block is parsed here; {@link claudeCodeToRunEvents} does the join.
 */
export interface TaskNotification {
  taskId: string;
  /** `<tool-use-id>`, the exact join key — absent on progress events. */
  callId: string | null;
  /** `<status>`; null on a progress event, which is not an ending. */
  status: string | null;
  summary: string;
  /** Every other tag, in the block's own order, so a field we have never seen
   *  still reaches the reader instead of being silently dropped. */
  fields: { label: string; value: string }[];
}

const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/;
/** One tag and its body. Non-overlapping and left-to-right, so `<usage>`'s
 *  children are consumed with it and never read as fields of their own. */
const TAG = /<([a-z][a-z0-9_-]*)>([\s\S]*?)<\/\1>/g;
/** The tags the join itself uses; they carry no reading value on the card. */
const JOIN_TAGS = new Set(["task-id", "tool-use-id"]);

/**
 * The `<task-notification>` block inside a message body, or null.
 *
 * Defensive by construction: an unterminated block, a block with no task id, or
 * a message that merely mentions one is NOT a notification. A half-read block
 * would eat a record that a reader can still make sense of, so the failure mode
 * is to leave the message exactly as it was.
 *
 * @param text the raw message body
 * @return the parsed notification, or null when the body does not carry one
 */
export function parseTaskNotification(text: string): TaskNotification | null {
  const block = NOTIFICATION.exec(text);
  if (block === null) return null;
  const fields: { label: string; value: string }[] = [];
  let taskId = "";
  let callId: string | null = null;
  let status: string | null = null;
  let summary = "";
  TAG.lastIndex = 0;
  for (let m = TAG.exec(block[1]); m !== null; m = TAG.exec(block[1])) {
    const [, label, raw] = m;
    // The usage block is inline children; flatten it to one readable line
    // rather than inventing a layout for numbers we did not compute.
    const value =
      label === "usage"
        ? [...raw.matchAll(/<([a-z_]+)>([^<]*)<\/\1>/g)].map((u) => `${u[1]}=${u[2]}`).join(" ")
        : raw.trim();
    if (label === "task-id") taskId = value;
    else if (label === "tool-use-id") callId = value === "" ? null : value;
    else if (label === "status") status = value === "" ? null : value;
    if (label === "summary") summary = value;
    if (!JOIN_TAGS.has(label)) fields.push({ label, value });
  }
  if (taskId === "") return null;
  return { taskId, callId, status, summary, fields };
}

/**
 * The first line of a launch's tool_result, when it announces a task id.
 *
 * Two grammars in the wild: "Workflow launched in background. Task ID: x" and
 * "Monitor started (task x, ...)". Both are matched on the FIRST LINE only and
 * both must say launched/started, because a tool output that merely QUOTES a
 * task id further down is not a launch — measured: a Bash result in the owner's
 * session printed one, and an unanchored match adopted it as a receipt.
 *
 * @param output the tool_result text
 * @return the task id this call started, or null
 */
function receiptTaskId(output: string): string | null {
  const first = output.split("\n", 1)[0];
  const m = /\b(?:launched|started)\b[^\n]*?\btask(?:\s+id)?[:\s]\s*([A-Za-z0-9_-]{4,})\b/i.exec(first);
  return m === null ? null : m[1];
}

/** What a notification adds under the receipt it belongs to. */
function outcomeSection(n: TaskNotification): string {
  const head = `--- task ${n.taskId}${n.status === null ? "" : ` · ${n.status}`} ---`;
  const body = n.fields
    .filter((f) => f.label !== "status" && f.value !== "")
    .map((f) => `${f.label}: ${f.value}`);
  return [head, ...body].join("\n");
}

/** A launch that promised a notification and never got one. */
const UNFINISHED = (taskId: string): string =>
  `--- task ${taskId} · no result by the end of the transcript ---`;

/**
 * One stamp per record, in file order and never decreasing.
 *
 * Timestamps are per record, not per file: a transcript can date some records
 * and leave others bare. Every date the file DOES carry is the truth about
 * when the session ran — the synthetic ladder is a relative filler that hangs
 * off the nearest one, so the stream keeps the file's own span instead of a
 * calendar of its own. A file with no date at all rides the ladder from `base`.
 */
function stampRecords(recs: CCRecord[], base: number): number[] {
  const dated = recs.map((r) => {
    const t = r.timestamp !== undefined ? Date.parse(r.timestamp) : Number.NaN;
    return Number.isFinite(t) ? t : null;
  });
  const first = dated.findIndex((t) => t !== null);
  if (first < 0) return recs.map((_, i) => base + i * SYNTHETIC_TS_STEP_MS);

  const stamps: number[] = [];
  // Records ahead of the first dated one have nothing to continue from: hang
  // them one rung apart IN FRONT of it, which keeps their order without
  // claiming a wall-clock time the file never recorded.
  const origin = dated[first] as number;
  for (let i = 0; i < first; i++) stamps.push(origin - (first - i) * SYNTHETIC_TS_STEP_MS);
  let latest = origin;
  for (let i = first; i < recs.length; i++) {
    const t = dated[i];
    if (t !== null) {
      stamps.push(t);
      latest = Math.max(latest, t); // a stray early date must not pull the ladder back
    } else {
      latest += SYNTHETIC_TS_STEP_MS;
      stamps.push(latest);
    }
  }
  return stamps;
}

// "Task" is the classic subagent tool; newer Claude Code versions call it "Agent".
const isSpawnTool = (name: unknown): boolean => name === "Task" || name === "Agent";

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b: CCBlock | string) => (typeof b === "string" ? b : (b.text ?? ""))).join("");
  return "";
};

export function claudeCodeToRunEvents(records: unknown[], base = 1_783_500_000_000): RunEvent[] {
  const recs = records.filter((r): r is CCRecord => !!r && typeof r === "object");
  const out: RunEvent[] = [];
  const runId = "cc-import";
  let started = false;

  // Task tool_use ids double as the child agentIds. A sidechain record finds
  // its owning Task by walking parentUuid up: the chain roots either directly
  // at the Task id or at another sidechain record whose chain does.
  const taskIds = new Set<string>();
  for (const r of recs) {
    const content = r.type === "assistant" ? r.message?.content : null;
    if (Array.isArray(content)) {
      for (const b of content as CCBlock[])
        if (b?.type === "tool_use" && isSpawnTool(b.name) && typeof b.id === "string") taskIds.add(b.id);
    }
  }
  const byUuid = new Map(
    recs.filter((r) => typeof r.uuid === "string").map((r) => [r.uuid as string, r] as const),
  );
  const ownerOf = (r: CCRecord): string | null => {
    let cur: CCRecord | undefined = r;
    const seen = new Set<string>();
    while (cur?.parentUuid && !seen.has(cur.parentUuid)) {
      if (taskIds.has(cur.parentUuid)) return cur.parentUuid;
      seen.add(cur.parentUuid);
      cur = byUuid.get(cur.parentUuid);
    }
    return null;
  };
  const childStarted = new Set<string>();
  // Who spawned a Task, and what for — a Task nested inside a sidechain belongs
  // under its spawner, not under main.
  const spawnedBy = new Map<string, string>();
  const taskOf = new Map<string, string>();

  // Background tasks, joined across the three records that make one of them.
  // `text` accumulates because one task can report many times (a monitor fires
  // per event); each notification patches the SAME card, so the card has to
  // carry everything that arrived, not only the last thing.
  const calls = new Set<string>();
  const launchOf = new Map<string, string>(); // task id -> callId, first wins
  // callId -> what the card shows, and whose call it was: a subagent can launch
  // a background task too, and the outcome belongs to the launcher.
  const results = new Map<string, { ts: number; text: string; agentId: string }>();
  const promised = new Map<string, { taskId: string; settled: boolean }>(); // receipt-bearing calls only

  // Turns are per agent: the main run and every subagent count their own.
  const turns = new Map<string, number>();
  const nextTurn = (agentId: string): number => {
    const n = (turns.get(agentId) ?? 0) + 1;
    turns.set(agentId, n);
    return n;
  };

  const stamps = stampRecords(recs, base);
  const modelOf = (r: CCRecord): string | undefined =>
    typeof r.message?.model === "string" && r.message.model !== "" ? r.message.model : undefined;
  const firstModel = recs.map(modelOf).find((m) => m !== undefined);

  // provider_info is the socket-only announcement of the active backend, and
  // the reducer takes the latest one. A transcript names its model per message,
  // so the file itself says when it changed: announce it once up front and
  // again at each switch. Two fields stay OUT: the API host, which a transcript
  // never records, and the provider — a Claude model id says which model spoke,
  // not whether it came from the Anthropic API, Bedrock or Vertex, and the
  // trace turns a claimed "anthropic" into a claimed endpoint. Absent reads as
  // unknown; a guess would read as fact.
  let announced: string | undefined;
  const announce = (model: string | undefined, ts: number): void => {
    if (model === undefined || model === announced) return;
    announced = model;
    out.push({ type: "provider_info", model, ts } as unknown as RunEvent);
  };

  /** One content block under `agentId`, whoever owns it. */
  const emitBlock = (agentId: string, b: CCBlock, ts: number): void => {
    // Signature-only thinking / empty text blocks would render as empty
    // activities and empty stream slices — skip them.
    if (b?.type === "thinking" && (b.thinking ?? "") !== "") {
      out.push({ type: "thinking_delta", agentId, text: b.thinking ?? "", ts });
    } else if (b?.type === "text" && (b.text ?? "") !== "") {
      out.push({ type: "text_delta", agentId, text: b.text ?? "", ts });
    } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      if (isSpawnTool(b.name)) {
        const task = typeof b.input?.description === "string" ? b.input.description : "subtask";
        // The agent type ("Explore", "code-reviewer") is the only readable name
        // a subagent has — its id is the raw tool-use id. It travels on the task
        // message, which is what the roster and the spectrum lane read.
        const label = typeof b.input?.subagent_type === "string" ? b.input.subagent_type : "task";
        spawnedBy.set(b.id, agentId);
        taskOf.set(b.id, task);
        out.push({ type: "agent_spawn", agentId: b.id, parentId: agentId, task, ts });
        out.push({
          type: "agent_message",
          from: agentId,
          to: b.id,
          role: "task",
          state: "submitted",
          text: task,
          label,
          ts,
        });
      } else if (!calls.has(b.id)) {
        // A compaction replays whole records verbatim, launch call included. The
        // reducer keys cards by callId, so emitting the call twice re-creates the
        // card and strands whatever had already been patched onto it.
        calls.add(b.id);
        out.push({ type: "tool_call", agentId, callId: b.id, name: b.name, input: b.input, ts });
      }
    } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
      if (taskIds.has(b.tool_use_id)) {
        // A Task's result: close the child before the parent resumes.
        if (childStarted.has(b.tool_use_id)) {
          out.push({ type: "run_end", runId: `cc-${b.tool_use_id}`, stopReason: "end_turn", ts });
        }
        out.push({
          type: "agent_message",
          from: b.tool_use_id,
          to: agentId,
          role: "result",
          state: b.is_error ? "failed" : "completed",
          text: asText(b.content),
          ts,
        });
      }
      const output = asText(b.content);
      const taskId = receiptTaskId(output);
      // A duplicated record (the same receipt replayed after a compaction) must
      // not restart the clock or drop what already arrived: first wins.
      const replayed = results.has(b.tool_use_id);
      if (!replayed) results.set(b.tool_use_id, { ts, text: output, agentId });
      if (taskId !== null) {
        if (!launchOf.has(taskId)) launchOf.set(taskId, b.tool_use_id);
        if (!promised.has(b.tool_use_id)) promised.set(b.tool_use_id, { taskId, settled: false });
      }
      // The replay carries the receipt again, and a compaction can put it AFTER
      // the outcome landed. The reducer patches by callId and the last write
      // wins, so re-emitting here would erase the outcome and reset its measured
      // wait to zero. The card already holds this content.
      if (replayed) return;
      out.push({
        type: "tool_result",
        agentId,
        callId: b.tool_use_id,
        output,
        isError: !!b.is_error,
        durationMs: 0,
        ts,
      });
    }
  };

  /**
   * A notification, landed where it belongs.
   *
   * The outcome IS the launch call's outcome, so it rides on that call's
   * tool_result: the reducer patches the card by callId and adds no turn, which
   * is what lets a result arriving nineteen minutes later reach its card without
   * moving a single thing that was written in between.
   *
   * With no launch in the file (compaction trimmed it, or it was started in an
   * earlier session) there is no card to patch — patching an unknown callId is a
   * no-op — so the task reports as itself instead. Every field of that message
   * is the notification's own text.
   */
  const emitNotification = (n: TaskNotification, ts: number): void => {
    const callId = n.callId !== null && calls.has(n.callId) ? n.callId : (launchOf.get(n.taskId) ?? null);
    if (callId !== null && calls.has(callId)) {
      const card = results.get(callId) ?? { ts, text: "", agentId: "main" };
      card.text = card.text === "" ? outcomeSection(n) : `${card.text}\n\n${outcomeSection(n)}`;
      results.set(callId, card);
      const p = promised.get(callId);
      if (p !== undefined && n.status !== null) p.settled = true;
      out.push({
        type: "tool_result",
        agentId: card.agentId,
        callId,
        output: card.text,
        // The status the task reported, never the launch's own exit: a launch
        // that returned a receipt succeeded at launching.
        isError: n.status !== null && n.status !== "completed",
        durationMs: Math.max(0, ts - card.ts),
        ts,
      });
      return;
    }
    const text = n.fields
      .filter((f) => f.label !== "output-file" && f.value !== "")
      .map((f) => f.value)
      .join("\n");
    out.push({
      type: "agent_message",
      from: n.taskId,
      to: "main",
      // No status is a progress report, not an ending.
      role: n.status === null ? "status" : "result",
      state: n.status ?? "working",
      text: text === "" ? n.summary : text,
      ts,
    });
  };

  announce(firstModel, stamps[0] ?? base);

  recs.forEach((r, i) => {
    const ts = stamps[i];
    const content = r.message?.content;
    const blocks = Array.isArray(content) ? (content as CCBlock[]) : [];
    if (r.isSidechain) {
      const owner = ownerOf(r);
      if (!owner) return; // orphaned sidechain: skip, never crash
      if (!childStarted.has(owner)) {
        out.push({
          type: "run_start",
          runId: `cc-${owner}`,
          agentId: owner,
          parentId: spawnedBy.get(owner) ?? "main",
          prompt: taskOf.get(owner) ?? "subtask",
          ts,
        });
        childStarted.add(owner);
      }
      if (r.type === "assistant") {
        announce(modelOf(r), ts);
        out.push({ type: "turn_start", agentId: owner, turn: nextTurn(owner), ts });
      }
      for (const b of blocks) emitBlock(owner, b, ts);
      return;
    }
    if (r.type === "user") {
      if (!started) {
        out.push({
          type: "run_start",
          runId,
          agentId: "main",
          prompt: asText(content),
          ...(firstModel !== undefined ? { model: firstModel } : {}),
          ts,
        });
        started = true;
      } else {
        // A notification rides in the user channel as plain text, so it is read
        // before the blocks — a body that is not one falls through untouched.
        const n = typeof content === "string" ? parseTaskNotification(content) : null;
        if (n !== null) emitNotification(n, ts);
        else for (const b of blocks) emitBlock("main", b, ts);
      }
    } else if (r.type === "assistant") {
      // One assistant message is one turn. A long session is hundreds of them,
      // and the graph draws a node per turn_start.
      announce(modelOf(r), ts);
      out.push({ type: "turn_start", agentId: "main", turn: nextTurn("main"), ts });
      for (const b of blocks) emitBlock("main", b, ts);
      const u = r.message?.usage;
      if (u)
        out.push({
          type: "usage",
          agentId: "main",
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens !== undefined
            ? { cacheCreationTokens: u.cache_creation_input_tokens }
            : {}),
          ts,
        });
    }
  });

  if (started) {
    // The closing stamp is the last moment the file recorded, so the run_end
    // can never predate the events it closes and the session's span stays the
    // session's own.
    const last = stamps.reduce((m, t) => (t > m ? t : m), stamps[0] ?? base);
    // A receipt is a promise of a notification. Where none ever came, the task
    // was still running when the file ended — a real state, and one the card
    // cannot show by the absence of an outcome alone. Only receipts are marked:
    // a call that promised nothing owes nothing. The status stays clean because
    // the LAUNCH did succeed; it is the outcome that is unknown.
    for (const [callId, p] of promised) {
      if (p.settled) continue;
      const card = results.get(callId) ?? { ts: last, text: "", agentId: "main" };
      const text = card.text === "" ? UNFINISHED(p.taskId) : `${card.text}\n\n${UNFINISHED(p.taskId)}`;
      out.push({
        type: "tool_result",
        agentId: card.agentId,
        callId,
        output: text,
        isError: false,
        durationMs: Math.max(0, last - card.ts),
        ts: last,
      });
    }
    out.push({ type: "run_end", runId, stopReason: "end_turn", ts: last });
  }
  return out;
}

export function parseTranscript(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return claudeCodeToRunEvents(records);
}
