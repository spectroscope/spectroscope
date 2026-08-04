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
import { readToolResultDetail, type ToolResultDetail } from "./toolResultDetail";
import { readAgentResult, type AgentRunResult } from "./agentResult";

/** What a response reported it cost. The same four counters arrive twice: on a
 *  record's own `message.usage`, and — for a subagent whose transcript is a
 *  different file — inside the parent's `toolUseResult.usage`. */
interface CCUsage {
  input_tokens?: number;
  output_tokens?: number;
  /** Anthropic prompt caching. Additive on our wire too: absent means the
   *  provider reported none, which is not the same as zero. */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

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
    usage?: CCUsage;
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
  /** The tool's own return value, beside the tool_result block that carries
   *  the flattened text. Read by import/toolResultDetail.ts, never rendered as
   *  itself. Present on 44,208 records of 496,675 — absent-first, always. */
  toolUseResult?: unknown;
  /** `attachment` records: what the client recorded around the conversation. */
  attachment?: CCAttachment;
  /** `queue-operation` records: enqueue, dequeue or remove. */
  operation?: string;
  /** The queued text, on a queue-operation that kept it. */
  content?: unknown;
  /** `system` records: which kind. Five in the corpus; two of them say
   *  something a reader acts on and are read below (compact_boundary 21,
   *  api_error 67). The other three carry nothing new — stop_hook_summary
   *  (1,750) is the same sentence every time, local_command (16) is the client
   *  echoing itself, model_refusal_fallback (14) sits only in files that
   *  already wear a fallback chip. */
  subtype?: string;
  /** `system[compact_boundary]`: the compaction as the client recorded it. */
  compactMetadata?: CCCompactMetadata;
  /** `system[api_error]`: what failed. An OBJECT here, with `formatted` and
   *  `message`. The same key on an assistant record is a short classifier
   *  string, which is why nothing reads it without checking the shape. */
  error?: unknown;
  /** `system[api_error]`: the retry the client then made. Both present or both
   *  absent on all 67. */
  retryAttempt?: number;
  maxRetries?: number;
  /** `user`: this body is the machine's summary of the conversation it
   *  replaced, not something a person typed. */
  isCompactSummary?: boolean;
  /** `assistant`: this message is not the model answering, it is the client
   *  writing down an outage. false is a different synthetic message ("No
   *  response requested."), so only the true case may be read. */
  isApiErrorMessage?: boolean;
  /** Where the run stood when this record was written. Stamped on every user,
   *  assistant, system and attachment record, and NOT a constant: 104 of the
   *  167 session transcripts in ~/.claude/projects carry more than one cwd. */
  cwd?: string;
  /** The git branch at the time of the record. 32 of 167 session files carry
   *  more than one; the longest sequence measured is five. */
  gitBranch?: string;
  /** The Claude Code client version. 12 of 167 session files carry more than
   *  one — the client was upgraded under the running session, which is what
   *  explains why the first stretch of a file carries none of these fields. */
  version?: string;
}

/**
 * What `system[subtype=compact_boundary]` records about the compaction.
 *
 * Only the survivor list is read here. The numbers beside it —
 * trigger, preTokens, postTokens, durationMs, cumulativeDroppedTokens — are
 * fields of somebody else's file and reach the reader through
 * import/recordMeta.ts, under the frame this record produces.
 */
interface CCCompactMetadata {
  preservedMessages?: unknown;
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
  /** `tool_reference`: the tool a ToolSearch result just loaded. The whole
   *  block is `{type, tool_name}` on all 2,805 of them in the corpus. */
  tool_name?: string;
  /** `image` / `document`: the bytes, always `{type:"base64", media_type,
   *  data}` — never a path and never a URL, measured on all 8,594. */
  source?: { type?: string; media_type?: string; data?: string };
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

/** Longest a foreign block type may be when it is named on a card, and the
 *  control characters it may not smuggle in. The type is somebody else's
 *  vocabulary rendered as interface text, so it is treated the way detect.ts
 *  treats an unrecognised record type. */
const MAX_BLOCK_TYPE_CHARS = 32;
// C0, DEL, C1 and the two Unicode line separators — everything a renderer could
// read as "start a new line".
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;

const safeWord = (raw: string): string => {
  const flat = raw.replace(CONTROL, " ").trim();
  return flat.length > MAX_BLOCK_TYPE_CHARS ? `${flat.slice(0, MAX_BLOCK_TYPE_CHARS)}…` : flat;
};

/** Base64 decoded, in bytes. Four characters carry three, less the padding. */
function decodedBytes(base64: string): number {
  const pad = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64.length / 4) * 3) - pad);
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * What a block that is not text SAYS it is.
 *
 * The bytes do not travel, and that is measured rather than assumed: the corpus
 * holds 1.23 GB of base64 image data, an import is a browser-side `File.text()`
 * read with no server blob behind it, and the one frame that could carry a
 * picture — `image_generated` — resolves through `/api/images/<file>` and would
 * claim the screenshot was generated here when it was read or grabbed. So the
 * note names the media type the file itself wrote and states the size it
 * decodes to. Nothing else is invented: a block with no media type is named by
 * its own `type` word, which is the file's word, capped and stripped of control
 * characters because it is foreign data being rendered as interface text.
 *
 * @return the note, or "" for a block that is text or carries nothing to name
 */
function blockNote(b: CCBlock): string {
  if (b.type === "tool_reference") return typeof b.tool_name === "string" ? safeWord(b.tool_name) : "";
  const kind = typeof b.type === "string" ? safeWord(b.type) : "";
  if (kind === "" || kind === "text") return "";
  const media = typeof b.source?.media_type === "string" ? safeWord(b.source.media_type) : "";
  const data = typeof b.source?.data === "string" ? b.source.data : null;
  if (media === "") return `[${kind}]`;
  return data === null ? `[${media}]` : `[${media} · ${byteSize(decodedBytes(data))}]`;
}

/**
 * A message body as text.
 *
 * A text block travels VERBATIM and always has; what changed (card 167) is what
 * a block that is NOT text produces. It used to produce the empty string, which
 * on 5,269 tool_result cards in the corpus was the whole output — a tool that
 * ran, succeeded and showed nothing — and on 1,520 ToolSearch cards threw away
 * the tool names the result consisted of. Now every block says what it is, and
 * a note gets a line of its own so it can never run into the words beside it.
 *
 * A body of nothing but text is byte-identical to what this returned before:
 * every piece is joined with no separator, exactly as it was.
 */
const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  let ownLine = false;
  for (const b of content as (CCBlock | string)[]) {
    const isText = typeof b === "string" || b?.type === "text" || b?.type === undefined;
    const piece = typeof b === "string" ? b : isText ? (b.text ?? "") : blockNote(b);
    if (piece === "") continue;
    if ((ownLine || !isText) && out !== "" && !out.endsWith("\n")) out += "\n";
    out += piece;
    ownLine = !isText;
  }
  return out;
};

/**
 * What the person attached to a message of their own.
 *
 * Only on a user record, and only for the two block types that are an
 * attachment: `image` (1,446 top-level blocks in the corpus) and `document`
 * (19, all base64 PDFs). They reach `emitBlock`, match no branch there and
 * produce nothing — so 196 records whose body is nothing but attachments import
 * as no frame at all, the prompt gone from the transcript, and 298 more import
 * as the words with the screenshot they were about removed.
 *
 * @return the note to put in the person's bubble, or "" for any other block
 */
function attachmentNote(b: CCBlock): string {
  return b?.type === "image" || b?.type === "document" ? blockNote(b) : "";
}

/**
 * The messages a compaction kept, by uuid.
 *
 * `allUuids` is the full list and `uuids` the visible one; both are on all 21
 * boundaries in the corpus, and the fuller list is the right denominator for
 * "what went". A boundary that names NEITHER returns null and produces no
 * frame: `compaction`'s only number is the count of what was removed, and
 * counting it against a survivor list the file never wrote would be an
 * invention about somebody else's session. Measured 0 such boundaries.
 *
 * @return the surviving uuids, or null when the record names none
 */
function survivors(meta: CCCompactMetadata | undefined): Set<string> | null {
  const p = meta?.preservedMessages;
  if (p === null || typeof p !== "object") return null;
  const { allUuids, uuids } = p as { allUuids?: unknown; uuids?: unknown };
  const list = Array.isArray(allUuids) ? allUuids : Array.isArray(uuids) ? uuids : null;
  if (list === null) return null;
  return new Set(list.filter((u): u is string => typeof u === "string"));
}

/**
 * What an `api_error` record says went wrong, as one sentence.
 *
 * `formatted` is the client's own rendering ("429 Rate limited", "Connection
 * interrupted by system sleep") and travels verbatim; `message` is the fallback
 * for a record that carries no formatted line. The retry rides in the same
 * string because `error` has one message and no field for a retry, and a field
 * invented on events.ts for a reading of somebody else's file is exactly what
 * this importer does not do.
 *
 * @return the message, or null for a record that names no failure at all
 */
function errorMessage(r: CCRecord): string | null {
  const e = r.error;
  if (e === null || typeof e !== "object") return null;
  const { formatted, message } = e as { formatted?: unknown; message?: unknown };
  const head =
    typeof formatted === "string" && formatted !== ""
      ? formatted
      : typeof message === "string" && message !== ""
        ? message
        : "";
  if (head === "") return null;
  return typeof r.retryAttempt === "number" && typeof r.maxRetries === "number"
    ? `${head} · retry ${r.retryAttempt}/${r.maxRetries}`
    : head;
}

/** How far past a boundary its summary may sit. Measured over all 21
 *  boundaries in the corpus the gap is exactly one line every time; the window
 *  exists because the distance is the client's business, and a file that ever
 *  writes a record between the two would otherwise lose the size. */
const SUMMARY_LOOKAHEAD = 3;

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

  // COMPACTION (card 167, finding 2). `compaction` has been in events.ts all
  // along and five consumers draw it — the reducer's warn line, the text feed's
  // "[compaction −N turns]", the graph's compact node, LabTrace, TraceView —
  // and the importer emitted none, so an imported million-token session
  // restarted its conversation with no marker at all. Measured over the 5,120
  // transcripts in ~/.claude/projects: 21 boundaries in 17 files, 0 frames.
  //
  // The uuid of every main turn still standing, in order. `removedTurns` is the
  // count of these the boundary did not preserve — arithmetic over two things
  // the file states, the way the response grouping and the notification's wait
  // are. Only turns are counted, because `compaction` counts turns.
  //
  // A record the file did not name cannot be matched against a list of names,
  // so it is not tracked at all: that understates what went rather than
  // claiming a turn was dropped because the file forgot to give it a uuid.
  const mainTurnUuids: string[] = [];

  // How long the summary that follows each boundary runs, by boundary index.
  // The summary itself never becomes a frame — see the isCompactSummary branch
  // — so this is where its size is read.
  const summaryCharsAt = new Map<number, number>();
  for (let i = 0; i < recs.length; i++) {
    if (recs[i].type !== "system" || recs[i].subtype !== "compact_boundary") continue;
    for (let j = i + 1; j < Math.min(i + 1 + SUMMARY_LOOKAHEAD, recs.length); j++) {
      if (recs[j].isCompactSummary !== true) continue;
      const body = recs[j].message?.content;
      summaryCharsAt.set(i, typeof body === "string" ? body.length : asText(body).length);
      break;
    }
  }

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
  // over the transcripts in ~/.claude/projects: ~266,000 assistant records are
  // ~117,400 responses, and only 27% of responses were ever a single record.
  // So reading a record as a turn counted 2.26 turns for every turn that
  // happened, and counted the response's tokens once per piece. On the owner's
  // own session, main agent only, which is what the app frames: 1,321,954
  // output tokens on screen where the file says 599,435.
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
  // object. The one measured fact that carries this rule: across every
  // multi-piece run in the corpus, the last piece holding a usage object holds
  // the maximum output_tokens, with zero exceptions. (An earlier draft of this
  // comment said the earlier pieces are "partial accountings, output_tokens 0
  // or 1, cache fields absent". That was checked and is false — it describes 6
  // of 31,658 differing splits. The pieces differ in many ways; what does not
  // vary is which one holds the finished number.)
  //
  // "The last that HAS one" and not simply "the last", so a run whose final
  // piece dropped the field still reports what the file did record.
  //
  // A SUBAGENT'S TOKENS ARE COUNTED TOO, on the owner's own agentId (card 167,
  // finding 1, on the owner's word "zähl die subagent-tokens"). Both branches
  // charge a response the same way, so an imported session total now means what
  // the SESSION spent rather than what its main agent spent. The footer says so
  // whenever a child is in it — a total that changes meaning in silence between
  // an old import and a new one is the thing to avoid, not the higher number.
  const lastUsage = new Map<number, number>();
  for (let i = 0; i < recs.length; i++) {
    if (runStart[i] < 0 || !recs[i].message?.usage) continue;
    lastUsage.set(runStart[i], i);
  }
  const usageAt = new Set(lastUsage.values());

  const stamps = stampRecords(recs, base);
  const modelOf = (r: CCRecord): string | undefined =>
    typeof r.message?.model === "string" && r.message.model !== "" ? r.message.model : undefined;
  // The model the file opens on, for the up-front announcement and for
  // run_start. An outage record is skipped: its model is the literal string
  // "<synthetic>", and 121 transcripts in the corpus open on one, so the run
  // announced a switch to a model by that name before a word was said and
  // carried it on run_start too.
  const firstModel = recs
    .filter((r) => r.isApiErrorMessage !== true)
    .map(modelOf)
    .find((m) => m !== undefined);

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

  /**
   * One response's token bill, charged to whoever produced it.
   *
   * The main branch and the sidechain branch call this with different owners,
   * which is the whole of finding 1: a subagent's response used to reach the
   * screen with its words and without its cost.
   *
   * A cache counter is spread in only when the record wrote one. A synthesised
   * zero reads as "nothing was cached", which is a claim about a request that
   * reported nothing at all.
   */
  const emitUsage = (agentId: string, u: CCUsage, ts: number): void => {
    out.push({
      type: "usage",
      agentId,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
      ...(u.cache_creation_input_tokens !== undefined
        ? { cacheCreationTokens: u.cache_creation_input_tokens }
        : {}),
      ts,
    });
  };

  /**
   * What the launch record says about the child, beside the receipt it shows.
   *
   * `agent_detail` is import-only (wire/nonWire.ts): a reading of somebody
   * else's transcript, in the idiom sourceNotes.ts and tool_result_detail
   * already use. A record that names neither the model nor a background launch
   * produces no frame, so a row with no model chip is exactly a row whose file
   * did not name one.
   */
  const emitAgentDetail = (agentId: string, res: AgentRunResult, ts: number): void => {
    if (res.model === undefined && res.launched === undefined) return;
    out.push({
      type: "agent_detail",
      agentId,
      ...(res.model !== undefined ? { model: res.model } : {}),
      ...(res.launched !== undefined ? { launched: true } : {}),
      ts,
    } as unknown as RunEvent);
  };

  /**
   * One content block under `agentId`, whoever owns it.
   *
   * `detail` and `agent` are two readings of the owning record's ONE
   * `toolUseResult`: what a tool returned, and what a launch says about the
   * child it launched. Both ride with the block rather than being looked up
   * afterwards because the record is where they belong together: measured over
   * the corpus, NO record carries more than one tool_result block, so a
   * record's readings belong to exactly one call and the join can never pick
   * the wrong one.
   */
  const emitBlock = (
    agentId: string,
    b: CCBlock,
    ts: number,
    detail?: ToolResultDetail | null,
    agent?: AgentRunResult | null,
  ): void => {
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
        // What the record says about the child itself (card 167, finding 6):
        // the model it ran on, and whether it ever reported back.
        if (agent !== null && agent !== undefined) {
          emitAgentDetail(b.tool_use_id, agent, ts);
          // The child's own bill, under the child. Nothing else in a session
          // file carries it, and without it the fan-out looks free.
          if (agent.usage !== undefined)
            emitUsage(
              b.tool_use_id,
              {
                input_tokens: agent.usage.inputTokens,
                output_tokens: agent.usage.outputTokens,
                ...(agent.usage.cacheReadTokens !== undefined
                  ? { cache_read_input_tokens: agent.usage.cacheReadTokens }
                  : {}),
                ...(agent.usage.cacheCreationTokens !== undefined
                  ? { cache_creation_input_tokens: agent.usage.cacheCreationTokens }
                  : {}),
              },
              ts,
            );
        }
        // A launch that never reported back gets NO result message: 394 of the
        // 624 launch records in ~/.claude/projects say `async_launched`, and a
        // result message would mark every one of them completed in the roster
        // while the card showed the launch receipt as the child's answer. The
        // receipt itself stays where the launch put it, on the parent's card.
        if (agent?.launched !== true)
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
      // What the tool RETURNED, next to what the model was SHOWN. The output
      // above stays the block, byte for byte; this is the same answer
      // structured, and the card reads it where the flattened text lost
      // something (the gutter, the two streams, the place an edit landed).
      if (detail != null)
        out.push({ type: "tool_result_detail", callId: b.tool_use_id, detail, ts } as unknown as RunEvent);
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

  // WHERE THE RUN STOOD, AND WHEN IT MOVED (card 167, finding 8).
  //
  // The same idiom as provider_info directly above: announce it once, off the
  // first line that says it, and again whenever the file says it changed. A
  // constant would be header material; measured over the 167 session
  // transcripts in ~/.claude/projects, it is not one — 104 of them (62%) stand
  // in more than one directory, 32 on more than one branch, 12 on more than one
  // client version. Every relative path in every tool result after a move means
  // something else than it did before, and the app said nothing.
  //
  // The frame is IMPORT-ONLY (wire/nonWire.ts). Nothing in events.ts gained a
  // field: this is a reading of somebody else's file, and no Java or Python
  // reader would ever construct one.
  const GROUND_FIELDS = ["cwd", "gitBranch", "version"] as const;
  type GroundField = (typeof GROUND_FIELDS)[number];
  /** What the run stood on, as of the last record that said so. */
  const ground: Partial<Record<GroundField, string>> = {};
  /**
   * Announce the ground if this record moved it.
   *
   * The frame carries ONLY the fields that changed, plus a `from` naming what
   * each of them left. A record that changed nothing produces nothing, which
   * is the majority of every file. On the first announcement there is no
   * `from`: nothing was left behind, and an empty object would read as one.
   *
   * A move BACK to a directory the session already stood in is announced like
   * any other move (3,204 of the corpus's 3,672 cwd moves are exactly that):
   * the ground is where it is, not where it has ever been.
   */
  const noteGround = (r: CCRecord, ts: number): void => {
    const moved: Partial<Record<GroundField, string>> = {};
    const from: Partial<Record<GroundField, string>> = {};
    let changed = false;
    let left = false;
    for (const field of GROUND_FIELDS) {
      const value = r[field];
      if (typeof value !== "string" || value === "" || value === ground[field]) continue;
      if (ground[field] !== undefined) {
        from[field] = ground[field];
        left = true;
      }
      moved[field] = value;
      ground[field] = value;
      changed = true;
    }
    if (!changed) return;
    out.push({ type: "ground_info", ...moved, ...(left ? { from } : {}), ts } as unknown as RunEvent);
  };

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

  /**
   * A `system` record, which used to produce nothing whatever it said.
   *
   * All 1,868 of them in the corpus are non-sidechain, so this runs ahead of
   * the sidechain branch and there is no owner to get wrong. Every system
   * record is handled here, including the three subtypes that say nothing a
   * reader acts on: falling through to the conversation branches was how they
   * used to be dropped, and stating it is cheaper to read than inferring it.
   *
   * @return true always for a system record, false for anything else
   */
  const emitSystem = (r: CCRecord, i: number, ts: number): boolean => {
    if (r.type !== "system") return false;
    if (r.subtype === "compact_boundary") {
      const preserved = survivors(r.compactMetadata);
      if (preserved === null) return true;
      const kept = mainTurnUuids.filter((u) => preserved.has(u));
      const removedTurns = mainTurnUuids.length - kept.length;
      // Only what survived carries into the NEXT boundary. A second compaction
      // removes what IT removed, and a list that kept the already-dropped turns
      // would count them a second time — 4 of the corpus's 17 compacting files
      // hold more than one boundary.
      mainTurnUuids.length = 0;
      mainTurnUuids.push(...kept);
      out.push({
        type: "compaction",
        agentId: "main",
        removedTurns,
        summaryChars: summaryCharsAt.get(i) ?? 0,
        ts,
      });
      return true;
    }
    if (r.subtype === "api_error") {
      // A real API failure, and the reason a reader finds a twenty-minute gap
      // between two turns. 67 records in 10 files produced nothing at all
      // before this, so a retry ladder was a silent hole in the clock.
      const message = errorMessage(r);
      if (message !== null) out.push({ type: "error", agentId: "main", message, ts });
      return true;
    }
    return true;
  };

  /**
   * An outage the client wrote into the assistant channel.
   *
   * 350 records in the corpus, and every one of them imported as a `text_delta`
   * — "API Error: Overloaded" read in the chat as the model's own answer. The
   * turn stays (the request was made and it failed), the tokens stay (the file
   * records its own zeroes), and the words become the `error` frame that
   * events.ts has carried since the beginning.
   */
  const emitApiErrorMessage = (agentId: string, blocks: CCBlock[], ts: number): void => {
    const message = asText(blocks);
    if (message !== "") out.push({ type: "error", agentId, message, ts });
  };

  const handleRecord = (r: CCRecord, i: number): void => {
    const ts = stamps[i];
    // Before every early return below: a record that carries no conversation
    // still carries the ground, and 487 of the corpus's 3,746 moves are
    // recorded on exactly such a line (486 on a system record, 1 on an
    // attachment).
    noteGround(r, ts);
    if (emitNoConversation(r, ts)) return;
    if (emitSystem(r, i, ts)) return;
    // The machine's summary of the conversation it replaced. It used to import
    // as a plain user_message: 391,308 characters of the model's own prose,
    // across the corpus's 21 boundaries, rendered as the person's words. Its
    // size travels on the compaction frame beside it and the line itself stays
    // in the file, where the source face has it byte for byte.
    if (r.isCompactSummary === true) return;
    const apiError = r.isApiErrorMessage === true;
    const content = r.message?.content;
    const blocks = Array.isArray(content) ? (content as CCBlock[]) : [];
    // Read once per record, not once per block: the field is the record's, and
    // parsing it again for every block of a 40 MB transcript would be a second
    // pass over the file for nothing.
    const detail = readToolResultDetail(r.toolUseResult);
    const agent = readAgentResult(r.toolUseResult);
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
        // An outage record names its model "<synthetic>", and announcing that
        // made the trace claim the run had switched to a model by that name.
        if (!apiError) announce(modelOf(r), ts);
        noteStop(owner, r);
        // Only the piece that OPENED the response opens a turn; see startsTurn.
        if (startsTurn(i)) out.push({ type: "turn_start", agentId: owner, turn: nextTurn(owner), ts });
      }
      if (apiError) emitApiErrorMessage(owner, blocks, ts);
      else for (const b of blocks) emitBlock(owner, b, ts, detail, agent);
      // The child's response costs what it costs, and it is charged to the
      // child. Same rule as the main branch below, same piece of the response.
      if (r.type === "assistant" && usageAt.has(i) && r.message?.usage) emitUsage(owner, r.message.usage, ts);
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
              continue;
            }
            // An attachment is the person's too, and it goes in the bubble in
            // the file's own order — a screenshot pasted BEFORE the sentence it
            // is about reads as one message, and 298 records in the corpus are
            // exactly that. See attachmentNote for why the bytes stay behind.
            const note = attachmentNote(b);
            if (note !== "") out.push({ type: "user_message", text: note, ts } as unknown as RunEvent);
            else emitBlock("main", b, ts, detail, agent);
          }
      }
    } else if (r.type === "assistant") {
      // One RESPONSE is one turn, and a response is usually several records —
      // see startsTurn. A long session is hundreds of them, and the graph draws
      // a node per turn_start.
      if (!apiError) announce(modelOf(r), ts); // never "<synthetic>"; see emitApiErrorMessage
      noteStop("main", r);
      if (startsTurn(i)) {
        out.push({ type: "turn_start", agentId: "main", turn: nextTurn("main"), ts });
        if (typeof r.uuid === "string") mainTurnUuids.push(r.uuid);
      }
      if (apiError) emitApiErrorMessage("main", blocks, ts);
      else for (const b of blocks) emitBlock("main", b, ts, detail, agent);
      // The response's tokens, once, off the piece that finished the accounting.
      if (usageAt.has(i) && r.message?.usage) emitUsage("main", r.message.usage, ts);
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
