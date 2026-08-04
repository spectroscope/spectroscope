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
}

/** The fields under one path of the record. */
export interface MetaGroup {
  /** Where these fields sit, dotted: "" for the record itself, then "message"
   *  and "message.usage". A wire path is its own label — it needs no
   *  translation and it cannot drift from the file. */
  path: string;
  rows: MetaRow[];
}

/**
 * Fields the frames already carry, so a row here would say it twice.
 *
 * `content` is the conversation itself and would print the whole record a
 * second time; `usage`'s four token counts are the usage frame; `role` and
 * `timestamp` are the row's own type and clock. `attachment` is read by the
 * importer into its own frames (task_reminder, edited_text_file,
 * queued_command), and `toolUseResult` is held back for a different reason: it
 * is a tool's whole output, up to megabytes of it, and it belongs in the tool
 * card rather than in a metadata list.
 */
const ALREADY_SHOWN = new Set([
  "message",
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

  const message = asRecord(record["message"]);
  if (message !== null) {
    const takenMessage = new Set<string>();
    const messageRows = named(message, MESSAGE_FIELDS, takenMessage);
    push("message", [...messageRows, ...rest(message, takenMessage)]);

    const usage = asRecord(message["usage"]);
    if (usage !== null) {
      const takenUsage = new Set<string>();
      const usageRows = named(usage, USAGE_FIELDS, takenUsage);
      push("message.usage", [...usageRows, ...rest(usage, takenUsage)]);
    }
  }
  return groups;
}
