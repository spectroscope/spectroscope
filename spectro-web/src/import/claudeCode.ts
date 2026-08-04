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
    /** The API response this record is a piece of. Several consecutive records
     *  share one, which is how a response written block by block is put back
     *  together — see the run grouping in claudeCodeWithOrigin. Absent on user
     *  records and on transcripts older than the field. */
    id?: string;
    /** Assistant records name the model that produced them; it can change
     *  mid-file (a /model switch, or a subagent on another model). */
    model?: string;
    /** How THIS message stopped ("end_turn", "tool_use", "max_tokens",
     *  "stop_sequence"), or null on a message that never reported an ending.
     *  Absent on user records and on transcripts old enough not to carry it. */
    stop_reason?: string | null;
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
  /** One HTTP call to the API. Read only as a second key on the response
   *  grouping below, never as content: it agrees with `message.id` on all
   *  85,369 multi-piece runs in the corpus, so demanding both costs nothing and
   *  refuses to fuse a file that ever reuses an id. */
  requestId?: string;
  /** `attachment` records: what the client recorded around the conversation. */
  attachment?: CCAttachment;
  /** `queue-operation` records: enqueue, dequeue or remove. */
  operation?: string;
  /** The queued text, on a queue-operation that kept it. */
  content?: unknown;
}

/**
 * The body of an `attachment` record.
 *
 * One record type with a discriminated body, and 25 bodies in the corpus. Four
 * are read here; the rest stay on the no-conversation pile until somebody can
 * say what a reader would do with them.
 */
interface CCAttachment {
  type?: string;
  /** task_reminder: the todo items, each `{id, subject, description, status,
   *  blocks, blockedBy, activeForm?, owner?}`. */
  content?: unknown;
  /** task_reminder: the client's own count of them. */
  itemCount?: number;
  /** edited_text_file: the path that was edited, and what changed. */
  filename?: string;
  snippet?: string;
  /** queued_command: what was typed, as a string or as content blocks. */
  prompt?: unknown;
  /** queued_command: "prompt" for something a person queued, "task-notification"
   *  for a background task reporting in. */
  commandMode?: string;
  /** queued_command: the client's own stamp on the queued command. */
  timestamp?: string;
  /** queued_command: `{kind: "human"}` on 648 of 1,213, absent on the rest. */
  origin?: unknown;
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

/**
 * What a run_end says when the file recorded no stop_reason at all.
 *
 * Measured over 4496 real transcripts: 248 carry no assistant record at all and
 * 28 more carry nothing but nulls. "end_turn" there would be an invention about
 * somebody else's session, and this importer's whole job is to say only what the
 * file says. The word is ours the same way "aborted" and "max_turns" are ours;
 * no provider emits it, and it reads in the footer as what it is.
 */
const UNRECORDED_STOP = "unrecorded";

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

/**
 * An adapted stream, with the line each frame came from.
 *
 * `origin[i]` is the index, in the file's own non-blank lines, of the record
 * that produced `events[i]`, or -1 when the importer built the frame itself
 * (the up-front provider_info, the closing run_end, the unsettled receipts).
 * The relation is frame to zero-or-one records, never frame to many: every
 * push happens inside the handling of exactly one record.
 */
export interface ImportedEvents {
  events: RunEvent[];
  origin: Int32Array;
}

export function claudeCodeToRunEvents(records: unknown[], base = 1_783_500_000_000): RunEvent[] {
  return claudeCodeWithOrigin(records, base).events;
}

export function claudeCodeWithOrigin(records: unknown[], base = 1_783_500_000_000): ImportedEvents {
  // The line index, not the position in `recs`: a line that parsed to a
  // non-object is dropped from `recs` but still occupies a line in the file,
  // and an origin that ignored that would name the wrong line on screen.
  const recs: CCRecord[] = [];
  const recLine: number[] = [];
  records.forEach((r, i) => {
    if (!!r && typeof r === "object") {
      recs.push(r as CCRecord);
      recLine.push(i);
    }
  });
  const out: RunEvent[] = [];
  const origin: number[] = [];
  /**
   * Charge every frame pushed since the last call to `line`.
   *
   * Measured from `out.length` rather than from a start index captured before
   * the record ran, because the record handler returns early in several places
   * (an orphaned sidechain, above all). A captured index skips the tail on
   * those paths and every later frame is charged to the wrong line.
   */
  const chargeTo = (line: number): void => {
    while (origin.length < out.length) origin.push(line);
  };
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

  // How each run's last assistant message stopped, keyed by agent ("main" or a
  // Task id). Latest recorded wins; a null is NOT a recording (87567 of the
  // corpus's assistant records carry one, a partial message that never reported
  // an ending), so it leaves the previous answer standing.
  const lastStop = new Map<string, string>();
  const noteStop = (agentId: string, r: CCRecord): void => {
    const s = r.message?.stop_reason;
    if (typeof s === "string" && s !== "") lastStop.set(agentId, s);
  };
  const stopOf = (agentId: string): string => lastStop.get(agentId) ?? UNRECORDED_STOP;

  // Turns are per agent: the main run and every subagent count their own.
  const turns = new Map<string, number>();
  const nextTurn = (agentId: string): number => {
    const n = (turns.get(agentId) ?? 0) + 1;
    turns.set(agentId, n);
    return n;
  };

  // ONE API RESPONSE, WRITTEN DOWN AS SEVERAL RECORDS.
  //
  // Claude Code does not write a record per response. It writes one per content
  // block — the thinking lands, then the text, then each tool_use — and every
  // piece repeats the same `message.id` AND the whole `message.usage`. Measured
  // over the 4977 transcripts in ~/.claude/projects: 265,009 assistant records
  // are 143,025 responses, and only 60,098 responses were ever a single record.
  // So reading a record as a turn counted 1.85 turns for every turn that
  // happened, and counted the response's tokens once per piece: 226,873,474
  // output tokens where the files say 142,811,312.
  //
  // WHAT ENDS A RUN. Not any gap: the pieces of one response are routinely
  // separated by the tool_result records coming back between them (measured,
  // 18,892 of 19,298 interleaved messages are separated by nothing else). A run
  // therefore survives every record that is NOT an assistant record and ends
  // only when ANOTHER assistant message begins. That guard is what keeps a
  // compaction apart: a compaction replays a record verbatim, id and all, and
  // the copy lands after other assistant messages have spoken.
  //
  // The key is `message.id` AND `requestId` together, plus the sidechain flag.
  // Measured over 85,369 multi-piece runs: requestId — one HTTP call — agrees
  // with this grouping on every single one and disagrees on none. Demanding
  // both costs nothing and refuses to fuse a file that ever reuses an id.
  //
  // `runStart[i]` is the record that opened record i's response, or -1 for a
  // record that is not an assistant one.
  const runStart = new Int32Array(recs.length).fill(-1);
  let openAt = -1;
  let openId: string | undefined;
  let openReq: string | undefined;
  let openSidechain = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (r.type !== "assistant") continue;
    const id = typeof r.message?.id === "string" && r.message.id !== "" ? r.message.id : undefined;
    // The sidechain flag is part of the identity: merging across it would move
    // a subagent's tokens onto the main run. No message in the corpus mixes the
    // two, so this half never fires today — it is here because that failure
    // would be silent and wrong, not because it is common.
    if (
      openAt >= 0 &&
      id !== undefined &&
      id === openId &&
      r.requestId === openReq &&
      !!r.isSidechain === openSidechain
    ) {
      runStart[i] = openAt;
      continue;
    }
    openAt = i;
    openId = id;
    openReq = r.requestId;
    openSidechain = !!r.isSidechain;
    runStart[i] = i;
  }
  /** Whether this record OPENS a response, and so a turn. A record with no
   *  message.id opens one of its own, which is what every transcript written
   *  before the field carried it has always done. */
  const startsTurn = (i: number): boolean => runStart[i] === i;

  // Which piece reports the response's tokens: the LAST one carrying a usage
  // object. Measured, the last piece holds the maximum output_tokens on all
  // 85,369 multi-piece runs with no exception — the earlier ones are partial
  // accountings (output_tokens 0 or 1, the cache fields absent). "The last that
  // HAS one" and not simply "the last", so a run whose final piece dropped the
  // field still reports what the file did record instead of nothing.
  const lastUsage = new Map<number, number>();
  for (let i = 0; i < recs.length; i++) {
    if (runStart[i] < 0 || !recs[i].message?.usage) continue;
    lastUsage.set(runStart[i], i);
  }
  const usageAt = new Set(lastUsage.values());

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
          // The child closes on the child's OWN last message. Every sidechain
          // record has been read by now, so the answer is complete here.
          out.push({ type: "run_end", runId: `cc-${b.tool_use_id}`, stopReason: stopOf(b.tool_use_id), ts });
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
  chargeTo(-1); // the opening announcement is the importer's, not a line's

  /**
   * The kinds a transcript records AROUND the conversation (card 141).
   *
   * These are not wire events and never become any: nothing in the Java core
   * would emit a todo list, and putting one in the union would ship a record
   * no code path constructs. They are readings of somebody else's file, the
   * idiom import/sourceNotes.ts already uses, and wire/nonWire.ts keeps them
   * out of everything this app writes.
   *
   * A frame is built only where the data is there. Every optional field is
   * spread in conditionally rather than defaulted, because a row rendering a
   * blank for a field the file never carried says something the file did not.
   *
   * Read before the sidechain branch: an attachment is never sidechain in the
   * corpus, and a stray flag would otherwise drop it into a path that emits
   * nothing. These frames name no agent, so there is no claim to get wrong.
   *
   * @return true when the record was one of these kinds and is fully handled
   */
  const emitNoConversation = (r: CCRecord, ts: number): boolean => {
    if (r.type === "queue-operation") {
      // 7,610 records: enqueue 3,810 / dequeue 2,248 / remove 1,552. The
      // client's own `timestamp` travels with the frame because `ts` is not
      // always it: stampRecords fills in a synthetic ladder for undated
      // records and clamps a stray early date, so the string is the file's
      // answer and `ts` is the stream's.
      if (typeof r.operation === "string" && r.operation !== "") {
        out.push({
          type: "queue_operation",
          operation: r.operation,
          ...(typeof r.timestamp === "string" ? { timestamp: r.timestamp } : {}),
          ...(typeof r.content === "string" && r.content !== "" ? { content: r.content } : {}),
          ts,
        } as unknown as RunEvent);
      }
      return true;
    }
    if (r.type !== "attachment") return false;
    const a = r.attachment;
    switch (a?.type) {
      case "task_reminder": {
        // 4,544 records, but 2,087 of them (45.9%) carry an empty list. The
        // items are carried whole: measured over 30,690 of them they hold
        // {id, subject, description, status, blocks, blockedBy} always,
        // activeForm on 29,087 and owner on 350, and the existing `plan` shape
        // reads only `text`, which would drop five fields of seven.
        const items = Array.isArray(a.content)
          ? a.content.filter((it) => !!it && typeof it === "object")
          : [];
        if (items.length === 0) return true;
        out.push({
          type: "task_reminder",
          items,
          // The file's own number, not a recount. It agrees with the list on
          // all 4,544 records today; a file where it does not gets to say so
          // rather than being quietly reconciled.
          ...(typeof a.itemCount === "number" ? { itemCount: a.itemCount } : {}),
          ts,
        } as unknown as RunEvent);
        return true;
      }
      case "edited_text_file": {
        // 940 records. The snippet runs to 8,223 characters and down to 0, so
        // an empty one is a real state and the frame simply does not carry it.
        if (typeof a.filename !== "string" || a.filename === "") return true;
        out.push({
          type: "edited_text_file",
          filename: a.filename,
          ...(typeof a.snippet === "string" && a.snippet !== "" ? { snippet: a.snippet } : {}),
          ts,
        } as unknown as RunEvent);
        return true;
      }
      case "queued_command": {
        // 1,213 records: 658 typed by a person, 555 a background task
        // reporting in. Both are framed. The design here said to drop the
        // notifications as already joined by emitNotification, and the corpus
        // says otherwise: 0 of the 555 appear as a user record with the same
        // text and only 21 share a task id with any user record in their own
        // file, so dropping them would lose the report entirely.
        const prompt = asText(a.prompt);
        out.push({
          type: "queued_command",
          ...(prompt !== "" ? { prompt } : {}),
          ...(typeof a.commandMode === "string" && a.commandMode !== ""
            ? { commandMode: a.commandMode }
            : {}),
          ...(typeof a.timestamp === "string" ? { timestamp: a.timestamp } : {}),
          ...(a.origin !== undefined && a.origin !== null ? { origin: a.origin } : {}),
          ts,
        } as unknown as RunEvent);
        return true;
      }
      default:
        // The other 21 attachment bodies. They are read and passed over on
        // purpose, the same way `mode` is: all 3,581 mode records in the
        // corpus say "normal" and carry no uuid and no clock, so a frame for
        // one would repeat a single word on every line of every file. What
        // carries nothing stays on the no-conversation pile, where the import
        // bar counts it honestly.
        return true;
    }
  };

  const handleRecord = (r: CCRecord, i: number): void => {
    const ts = stamps[i];
    if (emitNoConversation(r, ts)) return;
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
        noteStop(owner, r);
        // Only the piece that OPENED the response opens a turn; see startsTurn.
        if (startsTurn(i)) out.push({ type: "turn_start", agentId: owner, turn: nextTurn(owner), ts });
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
        // A user record stores its body EITHER as blocks or as a plain string,
        // and the choice says nothing about the record: the first prompt and
        // every later one are both strings. Only the first was ever read (into
        // run_start.prompt); every later one fell into the block loop, where a
        // string yields an empty array and the turn vanished. Measured over the
        // 151 transcripts in ~/.claude/projects: 1,985 records in 120 files.
        // See the test file for why this is a user_message and not a run_start.
        else if (typeof content === "string") {
          if (content !== "") out.push({ type: "user_message", text: content, ts } as unknown as RunEvent);
        } else
          // The same silence, one layer in, and the worse half of it: an array
          // body sent EVERY block through emitBlock, where a `text` block became
          // a text_delta under "main" — an assistant turn in the reducer, an
          // `answer` in the feed. The person's own words were read back as the
          // model's. It survived the string fix because these records do produce
          // a frame, so they never counted as a line carrying no conversation.
          //
          // Measured over the 4,571 transcripts in ~/.claude/projects: 776 such
          // blocks in 122 files. The split is per BLOCK, not per record, because
          // that is the grain the rule lives at — a body is a bag of blocks, and
          // `text` is the person while a `tool_result` is the machine answering
          // the machine. (In this corpus the two never share a record: text
          // appears alone in 509 and beside an `image` in 263. The per-block
          // form costs nothing and does not depend on that staying true.)
          for (const b of blocks) {
            if (b?.type === "text") {
              if ((b.text ?? "") !== "")
                out.push({ type: "user_message", text: b.text, ts } as unknown as RunEvent);
            } else emitBlock("main", b, ts);
          }
      }
    } else if (r.type === "assistant") {
      // One RESPONSE is one turn, and a response is usually several records —
      // see startsTurn. A long session is hundreds of them, and the graph draws
      // a node per turn_start.
      announce(modelOf(r), ts);
      noteStop("main", r);
      if (startsTurn(i)) out.push({ type: "turn_start", agentId: "main", turn: nextTurn("main"), ts });
      for (const b of blocks) emitBlock("main", b, ts);
      // The response's tokens, once, off the piece that finished the accounting.
      const u = usageAt.has(i) ? r.message?.usage : undefined;
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
  };

  recs.forEach((r, i) => {
    handleRecord(r, i);
    chargeTo(recLine[i]);
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
    out.push({ type: "run_end", runId, stopReason: stopOf("main"), ts: last });
  }
  // The closing frames belong to the file as a whole, not to its last line.
  chargeTo(-1);
  return { events: out, origin: Int32Array.from(origin) };
}

export function parseTranscript(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return claudeCodeToRunEvents(records);
}
