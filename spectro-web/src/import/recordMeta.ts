// What the imported line says ABOUT the turn, next to the frames it produced.
//
// The frames carry the conversation. The record carries the conversation plus
// everything the client wrote down around it, and until now none of that
// reached the reader except through the source face, where it is one long line
// of escaped JSON. Measured over the 4977 transcripts in ~/.claude/projects, a
// single assistant record carries 15 top-level keys and 10 message keys, of
// which the importer reads 9; the rest — the request id, the model, the effort,
// the skill or plugin or MCP server the turn is attributed to, the working
// directory, the git branch, the client version, the cache split, the service
// tier — is in the file and nowhere on screen.
//
// THIS IS A READING, NOT A FRAME. Nothing here touches events.ts and nothing
// here is ever written: these are fields of somebody else's file. It is the
// same idiom as sourceNotes.ts, one size up — that module reads four fields
// into four chips on the collapsed row, this one opens the whole record for the
// expanded one.
//
// TWO RULES, both inherited from sourceNotes.ts:
//   1. A line that does not carry a field produces NOTHING for it. Not an empty
//      row, not a dash. Most transcripts predate most of these fields.
//   2. Values travel VERBATIM. Every one of them is a vocabulary its writer
//      extends without asking us, so nothing is looked up, mapped or rounded.
//
// AND ONE OF ITS OWN: what is not named below still shows up. A curated list
// that silently swallowed the next field Claude Code invents would recreate the
// defect this module exists to remove, so every remaining scalar falls through
// into a `rest` group, exactly the way eventDetail.ts lets unnamed payload
// fields fall through to rows. Only the fields that ARE the conversation are
// held back, because the frames already carry them.

/** One field of the record, ready to print. */
export interface MetaRow {
  /** The field's own name, as the file spells it. */
  key: string;
  /** Its value, verbatim; an object or array rendered compactly, or named by
   *  its shape when printing it whole would be a wall. */
  value: string;
  /** Set when the value is a run of the file's own bytes rather than a field's
   *  compact value, and which of the two the pane should say over it — the
   *  same two the source pane already says (readable.ts, HIDDEN_KINDS):
   *  `text` is language and is painted, `hidden` is bytes and is opened on
   *  request. Absent for an ordinary row, which is nearly all of them.
   *
   *  The value is WHOLE either way. A ceiling belongs to the pane that paints,
   *  never to the reading. */
  block?: "text" | "hidden";
}

/** The fields under one path of the record. */
export interface MetaGroup {
  /** Where these fields sit, dotted: "" for the record itself, then "message",
   *  "message.usage" and, on a compaction boundary, "compactMetadata". A wire
   *  path is its own label — it needs no translation and it cannot drift from
   *  the file. */
  path: string;
  rows: MetaRow[];
}

/**
 * Fields the frames already carry, so a row here would say it twice.
 *
 * `content` is held back HERE and opened one level down instead, by
 * {@link contentRows}: the list is the shape of the response and belongs on
 * screen, the words inside it are the conversation and do not. `usage`'s four
 * token counts are the usage frame; `role` and `timestamp` are the row's own
 * type and clock. `attachment` is read by the importer into its own frames
 * (task_reminder, edited_text_file, queued_command), and `toolUseResult` is
 * held back for a different reason: it is a tool's whole output, up to
 * megabytes of it, and it belongs in the tool card rather than in a metadata
 * list.
 *
 * WHAT IS DELIBERATELY NOT HELD BACK (card 167, findings 7 and 8): the
 * attribution fields and cwd/gitBranch/version. Both now also reach the reader
 * on the collapsed row — the attribution five as a chip (sourceNotes.ts), a
 * move of the ground as its own frame — and those are a different reading, not
 * a second copy. The chip and the frame speak only where something is worth
 * calling out: measured 2026-08-04, a skill chip appears on 19,595 of the
 * corpus's records and a ground frame on 3,933. (The corpus is a live directory
 * of transcripts and grows while it is being read, so the totals carry the day
 * they were counted; the share is what holds.) This list is the record itself,
 * opened out, and on every other record it is the only place its working
 * directory appears at all.
 *
 * `compactMetadata` is held back for the reason `message` is: it gets a group
 * of its own below. Left to the fall-through it would print as a single
 * `{trigger, preTokens, …}` shape, because the block runs well past
 * {@link INLINE_CHARS}, and the four numbers a reader came for would be a
 * summary of their own names.
 */
const ALREADY_SHOWN = new Set([
  "message",
  "compactMetadata",
  "content",
  "attachment",
  "toolUseResult",
  "timestamp",
  "role",
  "usage",
  "input_tokens",
  "output_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
]);

/** The order the named fields are read in — reading order, not file order, so
 *  the same record always reads the same way. Anything absent is skipped, and
 *  anything not named here still arrives through the fall-through. */
const RECORD_FIELDS = [
  "type",
  "requestId",
  "uuid",
  "parentUuid",
  "isSidechain",
  "effort",
  "attributionAgent",
  "attributionSkill",
  "attributionPlugin",
  "attributionMcpServer",
  "attributionMcpTool",
  "agentId",
  "slug",
  "cwd",
  "gitBranch",
  "version",
  "entrypoint",
  "userType",
  "sessionId",
] as const;

const MESSAGE_FIELDS = ["id", "model", "stop_reason", "stop_sequence", "stop_details"] as const;

/** What `system[subtype=compact_boundary]` says about the compaction, in
 *  reading order: why it fired, how big the context was on each side, how long
 *  it took, and how much has gone since the session began. The frame beside
 *  this list carries the count of turns removed and the size of the summary;
 *  these five are the file's own numbers and are read nowhere else.
 *  cumulativeDroppedTokens is on 19 of the corpus's 21 boundaries, which is
 *  exactly why nothing here is defaulted. */
const COMPACT_FIELDS = [
  "trigger",
  "preTokens",
  "postTokens",
  "durationMs",
  "cumulativeDroppedTokens",
] as const;

const USAGE_FIELDS = [
  "service_tier",
  "speed",
  "cache_creation",
  "server_tool_use",
  "iterations",
  "inference_geo",
] as const;

/** Longest an object or array is printed whole. Past it the field is named by
 *  its shape instead: the reader still learns it is there, the source face
 *  still has it whole, and the panel does not become a wall. */
export const INLINE_CHARS = 120;

/** An array by its length, an object by its keys — a field named rather than
 *  printed. Never "…": a shape is a statement, an ellipsis is a shrug. */
function shapeOf(value: object): string {
  if (Array.isArray(value)) return `[${value.length} ${value.length === 1 ? "item" : "items"}]`;
  const keys = Object.keys(value);
  return `{${keys.join(", ")}}`;
}

/**
 * One value, as a row's text.
 *
 * @return the text, or null for a value that says nothing a row could carry:
 *         undefined, an empty string, and an empty object or array. `null`
 *         itself is kept — a recorded null is a recorded answer, and
 *         `stop_reason: null` in particular means "this message reported no
 *         ending", which is not the same as a message that never had the field.
 */
function render(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") return value === "" ? null : value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (!Array.isArray(value) && Object.keys(value).length === 0) return null;
  const compact = JSON.stringify(value);
  return compact !== undefined && compact.length <= INLINE_CHARS ? compact : shapeOf(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The named fields of one object, in reading order, skipping what it lacks. */
function named(source: Record<string, unknown>, fields: readonly string[], taken: Set<string>): MetaRow[] {
  const rows: MetaRow[] = [];
  for (const key of fields) {
    if (!(key in source)) continue;
    taken.add(key);
    const value = render(source[key]);
    if (value !== null) rows.push({ key, value });
  }
  return rows;
}

/**
 * The keys inside a content block that hold the words themselves.
 *
 * THIS IS THE LINE BETWEEN THE THOUGHT AND THE ANSWER, and it is drawn by who
 * else is already showing the value, not by how long it is.
 *
 * A `text` block's words leave the importer as text_delta frames and a
 * `tool_result` block's `content` leaves it as a tool card, so both are on
 * screen a few centimetres below this panel; printing them again would turn
 * the structured face into a second chat, and a reader comparing the two
 * copies would be comparing the app to itself. A `thinking` block's words
 * leave the importer as reasoning frames too — but the owner's report is about
 * the row those frames hang under, the turn_start, where the lens work
 * measured 146 of 146 two-row blocks putting the longer row first: the thought
 * IS what the eye lands on there, the Source face already prints it under its
 * own label, and a structured face that stays silent about it makes the two
 * faces of one line disagree about whether it exists.
 *
 * So the held-back keys are named and sized, never dropped and never printed:
 * the reader learns the block is there and how big it is, which is the same
 * statement {@link shapeOf} makes about an object too long to print.
 */
const WORDS_OF_THE_ANSWER = new Set(["text", "content"]);

/** Keys inside a content block that hold bytes rather than language: the
 *  cryptographic `signature` on a thinking block and the `data` of a redacted
 *  one. The same two the source pane collapses at any length (readable.ts,
 *  opaqueField), for the same reason — 356 characters of base64 read no better
 *  than 428956. Carried whole, painted on request. */
const OPAQUE_BLOCK_KEYS = new Set(["signature", "data"]);

/** A string named rather than printed: what it is and how much of it there is.
 *  Bracketed exactly like {@link shapeOf}, because it is the same statement. */
const sized = (n: number): string => `[${n} ${n === 1 ? "character" : "characters"}]`;

/**
 * The response's own blocks, one path per field.
 *
 * Rows are keyed by the file's own path into the list — `[0].thinking`, the
 * spelling the owner used in his report and the one the source pane's readable
 * face already uses. The index is never renumbered: a thought at index 1 reads
 * as `[1]`, because a list of ours would be a claim about a file of theirs.
 *
 * Every block yields its `type` first, so the reader sees the SHAPE of the
 * response — thought, then answer, then two calls — before any of the values.
 * Everything else the block carries falls through, so a block type Claude Code
 * invents tomorrow arrives without this module being edited first.
 *
 * @param content the value of `message.content`
 * @return the rows in file order; empty for anything that is not a list of
 *         blocks, which is how a plain-string prompt says nothing here
 */
function contentRows(content: unknown): MetaRow[] {
  if (!Array.isArray(content)) return [];
  const rows: MetaRow[] = [];
  content.forEach((entry: unknown, i) => {
    const block = asRecord(entry);
    if (block === null) return;
    const at = `[${i}]`;
    const type = render(block["type"]);
    if (type !== null) rows.push({ key: `${at}.type`, value: type });
    for (const [key, value] of Object.entries(block)) {
      if (key === "type") continue;
      if (WORDS_OF_THE_ANSWER.has(key)) {
        // Named and sized at ANY size. A run of words is sized; a tool_result
        // whose `content` is a list of blocks — 20,085 of 152,172 in the
        // corpus, 2,123 of them under the inline ceiling — is shaped, and
        // shaped HERE: handed to render(), a small list would come back
        // printed whole, words and all, next to the tool card that already
        // shows them. An empty value stays silent either way, the same rule
        // render() applies everywhere.
        if (typeof value === "string") {
          if (value !== "") rows.push({ key: `${at}.${key}`, value: sized(value.length) });
          continue;
        }
        if (value !== null && typeof value === "object") {
          const empty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
          if (!empty) rows.push({ key: `${at}.${key}`, value: shapeOf(value) });
          continue;
        }
      }
      const text = render(value);
      if (text === null) continue;
      if (typeof value === "string" && OPAQUE_BLOCK_KEYS.has(key)) {
        rows.push({ key: `${at}.${key}`, value: text, block: "hidden" });
      } else if (key === "thinking" && typeof value === "string") {
        rows.push({ key: `${at}.${key}`, value: text, block: "text" });
      } else if (typeof value === "string" && value.length > INLINE_CHARS) {
        // A long string nobody named is still a run of language. The plain
        // row has no ceiling at all, so past the inline ceiling the marking
        // hands it to the pane that caps and says so — the value itself
        // stays whole, as the rule above the type demands.
        rows.push({ key: `${at}.${key}`, value: text, block: "text" });
      } else {
        rows.push({ key: `${at}.${key}`, value: text });
      }
    }
  });
  return rows;
}

/** Everything else this object carries, in the file's own order. */
function rest(source: Record<string, unknown>, taken: Set<string>): MetaRow[] {
  const rows: MetaRow[] = [];
  for (const [key, value] of Object.entries(source)) {
    if (taken.has(key) || ALREADY_SHOWN.has(key)) continue;
    const text = render(value);
    if (text !== null) rows.push({ key, value: text });
  }
  return rows;
}

/**
 * The record behind one frame, opened out.
 *
 * @param line one raw line of an imported transcript, exactly as it was read
 * @return the groups in reading order; empty for a line that is not a JSON
 *         object, and empty for a record that carries nothing beyond the
 *         conversation the frames already show
 */
export function readRecordMeta(line: string): MetaGroup[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return []; // a line we cannot read is a line we know nothing about
  }
  const record = asRecord(parsed);
  if (record === null) return [];

  const groups: MetaGroup[] = [];
  const push = (path: string, rows: MetaRow[]): void => {
    if (rows.length > 0) groups.push({ path, rows });
  };

  const takenRecord = new Set<string>();
  const recordRows = named(record, RECORD_FIELDS, takenRecord);
  push("", [...recordRows, ...rest(record, takenRecord)]);

  const compact = asRecord(record["compactMetadata"]);
  if (compact !== null) {
    const takenCompact = new Set<string>();
    const compactRows = named(compact, COMPACT_FIELDS, takenCompact);
    push("compactMetadata", [...compactRows, ...rest(compact, takenCompact)]);
  }

  const message = asRecord(record["message"]);
  if (message !== null) {
    const takenMessage = new Set<string>();
    const messageRows = named(message, MESSAGE_FIELDS, takenMessage);
    push("message", [...messageRows, ...rest(message, takenMessage)]);

    // The response before what it cost: the blocks are the turn, the usage is
    // the bill for it.
    push("message.content", contentRows(message["content"]));

    const usage = asRecord(message["usage"]);
    if (usage !== null) {
      const takenUsage = new Set<string>();
      const usageRows = named(usage, USAGE_FIELDS, takenUsage);
      push("message.usage", [...usageRows, ...rest(usage, takenUsage)]);
    }
  }
  return groups;
}
