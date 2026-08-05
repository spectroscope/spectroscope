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
import { readSubagentTranscript, type SubagentTranscript } from "./subagentFile";
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
  /** The agent that wrote this record, on a subagent transcript. Read only by
   *  import/subagentFile.ts, and only at the level of the whole file. */
  agentId?: string;
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

/**
 * A notification's own words, and only those.
 *
 * The join keys are already gone (parseTaskNotification keeps them out of
 * `fields`); `output-file` goes too, because it is a path on the machine that
 * ran the task and says nothing to a reader who is not on it.
 */
function notificationText(n: TaskNotification): string {
  return n.fields
    .filter((f) => f.label !== "output-file" && f.value !== "")
    .map((f) => f.value)
    .join("\n");
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
/**
 * The media types an imported picture may be rendered as.
 *
 * An allowlist rather than a blocklist, because `mediaType` is FOREIGN input
 * that gets interpolated into a `data:` URI. A type of
 * `text/html,<svg onload=…>` yields a URI that is inert in an `<img src>` — it
 * fails to decode and hits onError — and becomes live the moment the same
 * string reaches an `<a href>`, an iframe or a fetch. One check here beats
 * trusting every renderer that will ever exist.
 *
 * Measured over the store: 6,214 jpeg, 3,717 png, 134 webp — and exactly FOUR
 * `image/svg+xml`. The list costs those four, and they are the ones worth
 * losing: an SVG in an `<img>` runs no script, but it is still a parser and a
 * decompression surface, and nothing in this corpus needs it. Everything off
 * the list keeps its note exactly as before.
 */
const RENDERABLE_MEDIA: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

/** Base64 and nothing else. The string reaches an attribute in three renderers
 *  and an offline HTML export; one charset check at the door beats trusting
 *  each of them to escape it. */
const BASE64_ONLY = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The picture a block carries, when it is one this app may draw.
 *
 * The bytes are already resident — the whole file was `JSON.parse`d to get
 * here — so carrying them retains a string and adds no read.
 *
 * @param b the content block
 * @return the media type and data, or null when this block is not a renderable
 *         picture (which leaves {@link blockNote}'s sentence in place)
 */
function renderableImage(b: CCBlock): { mediaType: string; dataBase64: string } | null {
  const media = typeof b.source?.media_type === "string" ? b.source.media_type : "";
  const data = typeof b.source?.data === "string" ? b.source.data : "";
  if (!RENDERABLE_MEDIA.has(media) || data === "" || !BASE64_ONLY.test(data)) return null;
  return { mediaType: media, dataBase64: data };
}

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
 * a block that is NOT text produces. It used to produce the empty string.
 *
 * COUNTED TWICE, because the two counts are not the same number and only one of
 * them is about a reader. 6,789 tool_result BLOCKS in the corpus flattened to
 * nothing — 5,269 whose only block was an image or a document, 1,520 whose only
 * block was a `tool_reference` — but 5,240 of those sit in `agent-*.jsonl`
 * sidechain files, which import to a couple of frames and no tool cards at all.
 * What a reader could actually open blank is 1,546 CARDS: 1,348 that showed a
 * tool which ran, succeeded and displayed nothing, and 201 ToolSearch results
 * that threw away the 439 tool names they consisted of. All 1,546 now say what
 * they hold, and a note gets a line of its own so it can never run into the
 * words beside it.
 *
 * A body of nothing but text is byte-identical to what this returned before:
 * every piece is joined with no separator, exactly as it was.
 */
const asText = (content: unknown, picturesTravel = false): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  let ownLine = false;
  for (const b of content as (CCBlock | string)[]) {
    // Card 179: where the picture itself now travels, its note is a stand-in
    // for something present, and printing both puts "[image/png · 31.0 KB]" on
    // screen directly above the picture it describes — and makes that string
    // the session's title. A picture we CANNOT render keeps its note, because
    // then the note is the only record there is.
    if (picturesTravel && typeof b !== "string" && renderableImage(b) !== null) continue;
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
/**
 * A picture the file carried, as its own import-only frame — or its note.
 *
 * The note said what a block WAS and dropped what it held, which is the whole
 * of "das war das mega bomben feature" going missing: the bytes are in the
 * transcript and nothing put them on screen.
 *
 * The bytes ride in the fold rather than behind an endpoint, and that is
 * measured. The old comment's number — 1.23 GB — is the CORPUS total, and no
 * import ever pays a corpus. The grain an import pays is the file: of 5,260
 * transcripts, 764 hold pictures at all, and the median such file holds 1.17 MB
 * of base64 (p90 5.08 MB). It is also already resident — the line was
 * JSON.parsed to reach this function — so carrying it retains a string and adds
 * no read. And an endpoint could not serve half the imports anyway: the file
 * picker hands over a File from anywhere on the disk, with no store path behind
 * it.
 *
 * What the old comment got right is kept in full: `image_generated` is NOT
 * emitted, because that frame means "generated here" and this was read or
 * grabbed. This is `attachment_image`, an import-only type beside
 * `tool_result_detail`, which `isWireEvent` keeps out of every written file.
 *
 * @param b the block
 * @param ts the record's clock
 * @param agentId who the frame belongs to
 * @param callId the call this block answered, when it sat in a tool_result
 * @return the frame to push, or null when the block is not a picture this app
 *         may draw — in which case the caller falls back to its note
 */
/** Whether a block is words somebody actually wrote — the test for "did this
 *  record say anything besides showing a picture". */
function isSpokenText(b: CCBlock): boolean {
  return b?.type === "text" && (b.text ?? "") !== "";
}

function imageFrame(
  b: CCBlock,
  ts: number,
  agentId: string,
  callId?: string,
  standalone = false,
): RunEvent | null {
  const pic = renderableImage(b);
  if (pic === null) return null;
  return {
    type: "attachment_image",
    agentId,
    mediaType: pic.mediaType,
    dataBase64: pic.dataBase64,
    // The file's own sentence travels too, so every surface has an alt without
    // recomputing a size and without inventing a word.
    note: blockNote(b),
    ...(callId === undefined ? {} : { callId }),
    // Nothing else in this record spoke, so the picture IS the message and
    // gets its own bubble. Without this it waited for the next sentence and
    // glued itself to a message it had nothing to do with — measured on the
    // fixture, a screenshot-only prompt landed on the words that came after it.
    ...(standalone ? { standalone: true } : {}),
    ts,
  } as unknown as RunEvent;
}

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
  /** Present only when the file was one agent's transcript rather than a
   *  session's (card 152). The import bar says so; absent means an ordinary
   *  session and the bar says nothing of the kind. */
  subagent?: SubagentTranscript;
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

  // WHOSE TRANSCRIPT IS THIS (card 152).
  //
  // A file whose records are ALL sidechain is one agent's transcript, and that
  // agent is the root of this stream: its owner lives in another file, which is
  // exactly why run_start.parentId is left off rather than pointed at a `main`
  // this file does not hold. `subagentRoot` is null for every session file, so
  // `rootId` is the literal "main" everywhere else and every path below reads
  // identically to how it read before.
  const subagent = readSubagentTranscript(recs);
  const subagentRoot = subagent?.agentId ?? null;
  const rootId = subagentRoot ?? "main";

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
  /**
   * Every place a record can carry a `<task-notification>` block.
   *
   * Three channels, and the file picks one without telling anybody: the user
   * record read inline further down, the `queue-operation` that enqueued the
   * text, and the `queued_command` attachment that holds it. Measured over
   * ~/.claude/projects on 2026-08-04, of the 365 terminal notifications that
   * name an async launch of their own file, 218 arrive as a user record and
   * 147 only in the other two. Which record type carried it says nothing about
   * whether the child reported back.
   */
  const notificationTexts = (r: CCRecord): string[] => {
    const texts: string[] = [];
    const body = r.message?.content;
    if (typeof body === "string") texts.push(body);
    if (r.type === "queue-operation" && typeof r.content === "string") texts.push(r.content);
    if (r.type === "attachment" && r.attachment?.type === "queued_command")
      texts.push(asText(r.attachment.prompt));
    return texts;
  };

  /**
   * Launch calls that this file names again in a notification, whatever it says.
   *
   * The badge these suppress reads "launched, never reported back", and that is
   * the app's claim about somebody else's transcript. Measured over
   * ~/.claude/projects on 2026-08-04, the transcript refutes it on 365 of the
   * 394 async launches — the notification is right there in the same file, and
   * the same import used to render it a second time as a parentless roster row
   * under the task id. A progress notification counts too: it has no ending in
   * it, but a task that files a progress report has reported back.
   *
   * Read up front because the notification lands after the launch record that
   * would otherwise have already claimed the silence.
   */
  const reportedBack = new Set<string>();
  for (const r of recs)
    for (const text of notificationTexts(r)) {
      const n = parseTaskNotification(text);
      if (n !== null && n.callId !== null && taskIds.has(n.callId)) reportedBack.add(n.callId);
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
  /**
   * Children already billed from their OWN records in this file.
   *
   * The launch record's `usage` is the child's whole run — on the real records
   * its four counters add up to `totalTokens` exactly — so in a file that also
   * holds the child's sidechain records it is the same money a second time.
   * Charging both put the child, and the session total, at double. The child's
   * own records win: they are the per-response grain, and the summary only
   * repeats them. (Not reachable on today's corpus: 0 of 311,332 sidechain
   * records resolve an owner inside their own file. The branch exists for the
   * mixed transcript, and it has to be right there or nowhere.)
   */
  const billedOwn = new Set<string>();
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
  // How many main turns stand, named or not. An understatement is one thing; a
  // file whose records carry NO uuid would leave the list empty and report
  // "0 turns removed" about a session that was cut in half, which is a count
  // nobody wrote — the very thing survivors() refuses a frame over. So that
  // boundary produces no frame either. 0 files in ~/.claude/projects are like
  // that (every boundary there removed 184 to 848 turns, median 397), so this
  // holds a latch rather than a live bug.
  let mainTurnsStanding = 0;

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
  // finding 1, on the owner's word "zähl die subagent-tokens"). An imported
  // session total therefore means what the SESSION spent rather than what its
  // main agent spent. The footer says so whenever a child is in it — a total
  // that changes meaning in silence between an old import and a new one is the
  // thing to avoid, not the higher number.
  //
  // Both branches charge through the one emitter below, and a response is
  // charged ONCE. (An earlier version of this sentence said the two branches
  // "charge a response the same way, so a mixed transcript that does hold its
  // children counts them too". They did, and it counted them twice: the launch
  // record's `usage` is the child's whole run, so a file that also holds the
  // child's own records says the same bill in both places. See billedOwn.)
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
  // run_start. A record the file FLAGS as an outage is skipped: its model is
  // the literal string "<synthetic>", and 121 transcripts in the corpus open
  // on one, so the run announced a switch to a model by that name before a
  // word was said.
  //
  // What that is worth, re-measured over ~/.claude/projects rather than
  // argued: the up-front announcement goes 122 → 1, and "<synthetic>"
  // announcements of every kind go 191 → 29. It does NOT clear run_start:
  // exactly 1 file opened on a synthetic model before and the same 1 does
  // after (6b9d11d3-4fea-4964-99f3-6c3aea453b59), because the record it opens
  // on carries isApiErrorMessage:false. The 28 mid-file announcements that
  // remain sit on such records too, all of them reading "No response
  // requested.". The flag is the file's own word and this filter follows it;
  // reading the model string instead would be us deciding what somebody
  // else's record meant.
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
        // A compaction replays whole records verbatim, and a replayed launch
        // used to spawn the child a SECOND time: the task message that comes
        // with it says `submitted`, so a child the file had already reported
        // finished went back to "not started yet". Same guard the tool_call
        // branch below has had, for the same reason. Measured over
        // ~/.claude/projects: 1 row (32ab8b5d…, toolu_01AS7uYQ…, replayed 926
        // records after its launch).
        if (spawnedBy.has(b.id)) return;
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
        // A report the file wrote down before this launch, held back so it
        // would not land in front of the row it is about. Its own record still
        // carries its own timestamp; this frame is stamped where the reader
        // learns of it, which is the earliest point in the stream where the
        // child exists to be reported on.
        const held = pending.get(b.id);
        if (held !== undefined) {
          pending.delete(b.id);
          pushOutcome(b.id, held, ts);
        }
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
          // The record says "async_launched" and it is right — but only about
          // the launch. Whether the child ever came back is the FILE's answer,
          // and a notification naming this call is it.
          const { launched: _wentBackground, ...rest } = agent;
          emitAgentDetail(b.tool_use_id, reportedBack.has(b.tool_use_id) ? rest : agent, ts);
          // The child's own bill, under the child. Nothing else in a session
          // file carries it, and without it the fan-out looks free — unless the
          // child's own records already paid it, see billedOwn.
          if (agent.usage !== undefined && !billedOwn.has(b.tool_use_id))
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
        // A background launch gets NO result message HERE: 394 of the 624
        // launch records in ~/.claude/projects say `async_launched`, and this
        // message would mark every one of them completed off a receipt that
        // reads "Async agent launched successfully." — the launch's answer,
        // not the child's. What finishes such a child is its own
        // task-notification later in the file (emitLaunchOutcome), which is
        // where its real answer is. The receipt itself stays where the launch
        // put it, on the parent's card.
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
      // NOT picturesTravel here, deliberately. A tool card's `output` is read by
      // more than the card's own picture row — the text feed, the structured
      // face, the receipt parser — and card 167 exists because a tool result
      // that flattened to nothing left a blank card. Beside a thumbnail the note
      // reads as a caption; dropped, those other surfaces go blank again.
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
      // The pictures the tool RETURNED — a screenshot from the browser, a
      // rendered chart. Roughly 7,300 of the corpus's 8,788 image blocks sit
      // here rather than in a person's message, so this is the bulk of what was
      // being thrown away. They carry the callId, so the card they belong to
      // can hold them (reducer: patchCard, the tool_result_detail idiom).
      if (Array.isArray(b.content))
        for (const inner of b.content as CCBlock[]) {
          const pic = imageFrame(inner, ts, agentId, b.tool_use_id);
          if (pic !== null) out.push(pic);
        }
      // What the tool RETURNED, next to what the model was SHOWN. The output
      // above stays the block, byte for byte; this is the same answer
      // structured, and the card reads it where the flattened text lost
      // something (the gutter, the two streams, the place an edit landed).
      if (detail != null)
        out.push({ type: "tool_result_detail", callId: b.tool_use_id, detail, ts } as unknown as RunEvent);
    }
  };

  /** Outcomes already landed, so one block carried by three records lands once. */
  const landed = new Set<string>();
  /**
   * Reports the file wrote down BEFORE the launch they answer.
   *
   * 4 rows in ~/.claude/projects do this: the queue-operation that took the
   * notification sits ahead of the assistant record holding the tool_use,
   * because a compaction replayed the launch after it. Pushing the outcome
   * there would put the child's ending in front of its own spawn, and the task
   * message that follows would reset the row to "submitted" — the file says
   * "completed" and the app would have said "not started yet".
   */
  const pending = new Map<string, TaskNotification>();

  /**
   * A launched child reporting back, on the child's own row.
   *
   * A `<task-notification>` whose `<tool-use-id>` names a launch THIS file made
   * is that child talking, and it belongs where the child is — not under its
   * task id as a roster row of its own with no parent, which is what the
   * fallback below did with it. Measured over ~/.claude/projects on 2026-08-04,
   * that fallback drew 245 parentless rows in the 70 files that fan out, and
   * 218 of them were a child the same import had already drawn.
   *
   * A terminal `<status>` ends the child (`killed`, `stopped` and `failed` all
   * read as failed, which is what the reducer has words for); no status is a
   * progress report and leaves it working with what it said. The text is the
   * notification's own fields, same as the fallback.
   *
   * @return true when this notification belonged to a launch in this file
   */
  const emitLaunchOutcome = (n: TaskNotification, ts: number): boolean => {
    if (n.callId === null || !taskIds.has(n.callId)) return false;
    // A background agent files a notification every time it comes to rest, and
    // the client writes each one down up to three times (queued, attached,
    // delivered). Same call, same status, same summary is the same report.
    const key = [n.callId, n.status ?? "", n.summary].join(" ");
    if (landed.has(key)) return true;
    landed.add(key);
    // The launch is not in the stream yet: hold the report until it is.
    if (!spawnedBy.has(n.callId)) {
      pending.set(n.callId, n);
      return true;
    }
    pushOutcome(n.callId, n, ts);
    return true;
  };

  /** The report itself, on the child's row. */
  const pushOutcome = (callId: string, n: TaskNotification, ts: number): void => {
    const text = notificationText(n);
    out.push({
      type: "agent_message",
      from: callId,
      to: spawnedBy.get(callId) ?? "main",
      role: n.status === null ? "status" : "result",
      state: n.status ?? "working",
      text: text === "" ? n.summary : text,
      ts,
    });
  };

  /**
   * The same, off a record that is not the delivered user message.
   *
   * A `queue-operation` and a `queued_command` attachment carry the block
   * verbatim. Only the launch-outcome half runs here: the fallback that turns
   * an unjoinable notification into a report of its own stays on the user
   * channel, where it was measured, so these records add no roster row that
   * was not already there.
   */
  const landNotification = (r: CCRecord, ts: number): void => {
    for (const text of notificationTexts(r)) {
      const n = parseTaskNotification(text);
      if (n !== null) emitLaunchOutcome(n, ts);
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
    if (emitLaunchOutcome(n, ts)) return;
    const callId = n.callId !== null && calls.has(n.callId) ? n.callId : (launchOf.get(n.taskId) ?? null);
    if (callId !== null && calls.has(callId)) {
      const card = results.get(callId) ?? { ts, text: "", agentId: rootId };
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
    const text = notificationText(n);
    out.push({
      type: "agent_message",
      from: n.taskId,
      to: rootId,
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
   * any other move (3,221 of the corpus's 3,692 cwd moves are exactly that,
   * measured 2026-08-04): the ground is where it is, not where it has ever
   * been.
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
      // 147 of the 365 notifications that answer an async launch of their own
      // file are only ever HERE and in the attachment below — the delivered
      // user record is not in the transcript. The frame above carries the text
      // for the reader; this carries the answer to the child's row.
      landNotification(r, ts);
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
        // The pictures a person pasted into a queued prompt (card 179). This
        // is the ONE block-reading path in the file with no imageFrame call,
        // and it is not a rare one: 212 blocks over 177 records, every single
        // one commandMode "prompt" — a person's own paste, never a task
        // notification. 145 of those records have their words nowhere else in
        // the file and 17 carry no words at all, so this frame is the only
        // trace of the whole message.
        //
        // standalone always: the words of a queued command go into the frame
        // below and never into a user bubble, so a parked picture would glue
        // itself to the next message, which it had nothing to do with.
        if (Array.isArray(a.prompt))
          for (const b of a.prompt as CCBlock[]) {
            const pic = imageFrame(b, ts, "main", undefined, true);
            if (pic !== null) out.push(pic);
          }
        const prompt = asText(a.prompt, true);
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
        landNotification(r, ts);
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
      // Turns stood and not one of them is named: nothing can be counted
      // against the survivor list, and 0 would read as "nothing was dropped".
      // Same refusal as the boundary that names no survivors.
      if (mainTurnsStanding > 0 && mainTurnUuids.length === 0) return true;
      const kept = mainTurnUuids.filter((u) => preserved.has(u));
      const removedTurns = mainTurnUuids.length - kept.length;
      // Only what survived carries into the NEXT boundary. A second compaction
      // removes what IT removed, and a list that kept the already-dropped turns
      // would count them a second time — 4 of the corpus's 17 compacting files
      // hold more than one boundary.
      mainTurnUuids.length = 0;
      mainTurnUuids.push(...kept);
      mainTurnsStanding = kept.length;
      out.push({
        type: "compaction",
        agentId: "main",
        removedTurns,
        // 0 is this field's own word for "no summary within the window" —
        // events.ts types it as a number, and the reducer already reads the 0
        // as absence and drops the size from the line rather than saying
        // "into 0 characters" (reducer.ts, case "compaction").
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
    // still carries the ground. Measured 2026-08-04 over the 167 transcripts:
    // 621 of the 3,933 ground frames come off a line that produces nothing
    // else — 488 of the 3,766 moves (487 on a `system/stop_hook_summary`
    // record, one on a `user` one) and 133 of the 167 openings, every one of
    // those on an `attachment`.
    noteGround(r, ts);
    if (emitNoConversation(r, ts)) return;
    // Every other record type, so that what SUPPRESSES the "never reported
    // back" badge and what LANDS the child's outcome are read off the same
    // records. They came apart once: the badge came off 365 children and only
    // 361 of them got an outcome, and the four left over fell back to
    // "submitted" — a worse sentence than the one being fixed.
    landNotification(r, ts);
    if (emitSystem(r, i, ts)) return;
    // The machine's summary of the conversation it replaced. It used to import
    // as a plain user_message: 391,308 characters of the model's own prose,
    // across the corpus's 21 boundaries, rendered as the person's words. Its
    // size travels on the compaction frame beside it. The words themselves now
    // reach NO face of the app: every face hangs off a row — sourcePane reads
    // `row.sourceLine` (traceDetail.ts) and the structured face reads
    // `sourceLines[entry.sourceLine]` (TraceView.tsx) — and a line that
    // produces no frame has no row, so nothing in the app points at it.
    // Measured over ~/.claude/projects: 21 frames were charged to an
    // isCompactSummary line before this, 0 after. The bytes stay in the
    // transcript on disk, and that is the whole of where they stay. (An
    // earlier version of this comment said the source face has them byte for
    // byte. It cannot: there is no row to open.) Whether 19 KB of machine
    // summary should be readable in the app is an owner's call — `compaction`
    // has no text field, and inventing one on events.ts for a reading of
    // somebody else's file is what this importer does not do (card 167).
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
      // The owner IN THE FILE first: a spawn nested inside a subagent
      // transcript still resolves the ordinary way, so the gate is additive and
      // never displaces the existing path. `subagentRoot` catches what is left
      // over, and only in a file that is entirely one agent's.
      const owner = ownerOf(r) ?? subagentRoot;
      if (!owner) return; // orphaned sidechain: skip, never crash
      if (owner === subagentRoot) {
        // The file's own agent. It is the root of this stream, so it opens the
        // run this import closes, and it carries NO parentId: the spawn that
        // named it lives in another file, and pointing at a `main` that is not
        // here would be the invention this whole path exists to avoid.
        if (!started) {
          // The pictures this agent was handed, before the run_start they
          // belong to — the same hole the main path had, in the same shape:
          // this record BECOMES the run_start and returns below without its
          // blocks ever being read. Order matters for the same reason: the
          // reducer parks these and the run_start's bubble collects them.
          if (r.type === "user") {
            for (const b of blocks) {
              const pic = imageFrame(b, ts, owner, undefined, !blocks.some(isSpokenText));
              if (pic !== null) out.push(pic);
            }
          }
          out.push({
            type: "run_start",
            runId,
            agentId: owner,
            prompt: r.type === "user" ? asText(content, true) : "",
            ...(firstModel !== undefined ? { model: firstModel } : {}),
            ts,
          });
          started = true;
          // The first record is the task the agent was given, and it has now
          // been read as the prompt. Reading it twice would put it on screen
          // twice, once as the prompt and once as a message.
          if (r.type === "user") return;
        }
      } else if (!childStarted.has(owner)) {
        out.push({
          type: "run_start",
          runId: `cc-${owner}`,
          agentId: owner,
          parentId: spawnedBy.get(owner) ?? rootId,
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
        // No blocks and no usage here: both are the shared tail below.
        //
        // This branch briefly emitted and billed its own and returned, written
        // against a rule that had since stopped existing — back when a
        // subagent's usage became no frame at all, the file's own agent needed
        // a hand-rolled one or the footer read zero. Card 167 changed that: the
        // tail bills EVERY sidechain owner through emitUsage + billedOwn, and
        // `owner === subagentRoot` is an owner like any other. Keeping both
        // would have been two usage frames for one response, and the reducer
        // folds usage additively — the footer, the agents panel and the context
        // ring would each have doubled, with nothing anywhere to fail.
      }
      if (r.type === "user") {
        // THE SIDECHAIN BRANCH GETS THE MAIN BRANCH'S USER HANDLING (card 152).
        //
        // Card 141 fixed both halves of this fifty lines below and never
        // carried either across. A string body went straight to the block loop,
        // where a string yields an empty array and the turn vanished — and 51 of
        // those in the corpus are a coordinator sending a working subagent the
        // revision it asked for, a real turn no trace has ever shown. An array
        // body sent every block through emitBlock, so a `text` block became a
        // text_delta under the agent: all 253 of them read "[Request
        // interrupted by user]", which is the trace telling the reader the
        // model said something the model did not say.
        //
        // The sender here is the parent rather than a person, and `user_message`
        // is still the right frame: what it means on our wire is "these words
        // are not the model's", which is exactly the claim being corrected. One
        // rule on both branches beats a second vocabulary for the same fact.
        //
        // Measured over ~/.claude/projects on 2026-08-04: 5,739 string bodies
        // and 253 text blocks, ALL of them in files the gate above claims, and
        // ZERO in a session file. So this reads identically on every session
        // file in the corpus, and the byte-compare confirms it rather than
        // being asked to trust it.
        //
        // Card 141 has a THIRD half, and it is the one the copy left behind:
        // the notification join runs BEFORE the string rule. A
        // `<task-notification>` rides in the user channel as plain text, so the
        // string rule would swallow it into a chat bubble, the launch's promise
        // would never settle, and its tool card would read "no result by the
        // end of the transcript" while the file recorded `completed`. Measured:
        // no sidechain record in the store carries a parseable notification
        // today — a subagent transcript closes when the agent returns, and
        // notifications inject into the live top-level channel. So this is a
        // gap rather than a defect anyone has hit; the promise machinery does
        // arm on real files, which is why it is closed here and not later.
        const n = typeof content === "string" ? parseTaskNotification(content) : null;
        if (n !== null) {
          emitNotification(n, ts);
          return;
        }
        if (typeof content === "string") {
          if (content !== "") out.push({ type: "user_message", text: content, ts } as unknown as RunEvent);
          return;
        }
        for (const b of blocks) {
          if (b?.type === "text") {
            if ((b.text ?? "") !== "")
              out.push({ type: "user_message", text: b.text, ts } as unknown as RunEvent);
          } else {
            const pic = imageFrame(b, ts, owner, undefined, !blocks.some(isSpokenText));
            if (pic !== null) out.push(pic);
            else emitBlock(owner, b, ts, detail, agent);
          }
        }
        return;
      }
      if (apiError) emitApiErrorMessage(owner, blocks, ts);
      else for (const b of blocks) emitBlock(owner, b, ts, detail, agent);
      // The child's response costs what it costs, and it is charged to the
      // child. Same rule as the main branch below, same piece of the response.
      // Once this fires, the launch record's summary of the same run is a
      // second copy of the same money — see billedOwn.
      if (r.type === "assistant" && usageAt.has(i) && r.message?.usage) {
        emitUsage(owner, r.message.usage, ts);
        billedOwn.add(owner);
      }
      return;
    }
    if (r.type === "user") {
      if (!started) {
        // The pictures the FIRST prompt came with, BEFORE the run_start they
        // belong to. This record becomes the run_start and never enters the
        // block loop below, so without this the commonest case of all is
        // missed — the owner's own file carries four screenshots on its opening
        // user record. Order is the whole of it: the reducer parks these and
        // the run_start's bubble picks them up on the way past, the same seam a
        // live send uses for what was attached in the composer. Pushed after,
        // they would arrive at an empty room.
        for (const b of blocks) {
          const pic = imageFrame(b, ts, "main");
          if (pic !== null) out.push(pic);
        }
        out.push({
          type: "run_start",
          runId,
          agentId: "main",
          prompt: asText(content, true),
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
            // The picture itself when this app may draw it; the note only
            // when it may not, so a reader never gets both.
            const pic = imageFrame(b, ts, rootId, undefined, !blocks.some(isSpokenText));
            if (pic !== null) {
              out.push(pic);
              continue;
            }
            const note = attachmentNote(b);
            if (note !== "") out.push({ type: "user_message", text: note, ts } as unknown as RunEvent);
            else emitBlock(rootId, b, ts, detail, agent);
          }
      }
    } else if (r.type === "assistant") {
      // One RESPONSE is one turn, and a response is usually several records —
      // see startsTurn. A long session is hundreds of them, and the graph draws
      // a node per turn_start.
      if (!apiError) announce(modelOf(r), ts); // never "<synthetic>"; see emitApiErrorMessage
      noteStop(rootId, r);
      if (startsTurn(i)) {
        out.push({ type: "turn_start", agentId: rootId, turn: nextTurn(rootId), ts });
        mainTurnsStanding++;
        if (typeof r.uuid === "string") mainTurnUuids.push(r.uuid);
      }
      if (apiError) emitApiErrorMessage(rootId, blocks, ts);
      else for (const b of blocks) emitBlock(rootId, b, ts, detail, agent);
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
      const card = results.get(callId) ?? { ts: last, text: "", agentId: rootId };
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
    out.push({ type: "run_end", runId, stopReason: stopOf(rootId), ts: last });
  }
  // The closing frames belong to the file as a whole, not to its last line.
  chargeTo(-1);
  return {
    events: out,
    origin: Int32Array.from(origin),
    ...(subagent !== null ? { subagent } : {}),
  };
}

export function parseTranscript(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return claudeCodeToRunEvents(records);
}
