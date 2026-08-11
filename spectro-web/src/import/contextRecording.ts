// What reached the model, out of a file that never wrote the request down.
//
// THE MEASUREMENT, run 2026-08-11 over the 188 session transcripts in
// ~/.claude/projects (210,211 records): not one message carries
// `role: "system"`. The 2,118 records of `type: "system"` are runtime events —
// 1,998 stop_hook_summary, 67 api_error, 23 compact_boundary, 16 local_command,
// 14 model_refusal_fallback — and none of them is a prompt. Claude Code
// assembles the system prompt per request in the client and never persists it.
// A spectroscope session does persist it, as a `context_info` part labelled
// "system prompt" (events.ts), which is why the panel is full for our runs and
// says nothing for an import.
//
// So there are two statements to make and they are different statements:
// "this format does not record the request" is not "the session had no system
// prompt", and only the first one is true. {@link recordsSystemPrompt} is the
// first. Nothing in this module produces the second, and nothing in it
// reconstructs a prompt from what is there — a guessed prompt inside a tool
// built to show what actually happened is worse than an empty field.
//
// WHAT THE FILE DOES CARRY. The client writes down every context INJECTION as
// an `attachment` record even though it omits the base. Measured the same day,
// by running this module over all 188 files: 2,872 attachment records outside
// the three kinds the importer already frames, of which 2,553 carry a body,
// spread over 176 of the 188 files and holding 12,087,402 characters — hook
// output, skill listings, MCP server instructions, deferred tool loads, agent
// rosters, the nested CLAUDE.md files that were read in. (That count is
// JavaScript string length, so it is UTF-16 units; the same corpus is
// 12,087,326 Unicode code points, and the 76 of difference are characters
// outside the basic plane. The unit is named because the number is quoted.)
//
// Every one of them is thrown away today: claudeCode.ts frames task_reminder,
// edited_text_file and queued_command and passes over the rest, and
// recordMeta.ts holds `attachment` back on the grounds that the importer reads
// it — which is true of three types out of twenty-two.
//
// THIS IS A READING, NOT A FRAME. Nothing here touches events.ts and nothing
// here is ever written: the same idiom as sourceNotes.ts and recordMeta.ts, and
// the reason it is a reading rather than a frame is that a frame would need a
// name in wire/nonWire.ts to stay out of an exported file, and a written line
// the Java reader cannot name is a line that silently disappears.
//
// TWO RULES, both inherited: a body that carries nothing produces NOTHING (319
// of those 2,872 records carry nothing but their own type name), and values
// travel VERBATIM under the file's own key names. There is no vocabulary of
// attachment types anywhere below. Nineteen kinds are in this corpus and the
// twentieth is Claude Code's to invent; a lookup table would drop it in
// silence, which is the defect this module exists to remove.

import type { ImportKind } from "./detect";
import { INLINE_CHARS, type MetaRow } from "./recordMeta";

/**
 * Whether the format wrote down the request that was sent, as opposed to the
 * conversation that came back.
 *
 * `spectroscope`: yes. A run emits `context_info` whose `parts` are labelled
 * "system prompt", "tool schemas" and "conversation", each with its own size.
 *
 * `claude-code`: no, measured — see the census at the top of this file.
 *
 * `vscode-agent`: no. That export has a closed six-type vocabulary
 * (detect.ts, VSCODE_AGENT_TYPES) and none of the six is a place a prompt could
 * sit. This one is read off the vocabulary rather than off a corpus: there is
 * no real VS Code export on this machine to count, and a claim from a
 * hand-written fixture would be a claim about the fixture.
 */
export function recordsSystemPrompt(kind: ImportKind): boolean {
  return kind === "spectroscope";
}

/** One thing the client put into the context, read off the record that
 *  recorded it. */
export interface ContextInjection {
  /** The attachment type, exactly as the file spells it. Never mapped: the
   *  list is the writer's to extend. */
  kind: string;
  /** The record this injection hung under — the file's OWN attribution, so a
   *  reader is told which turn it arrived on rather than shown a position this
   *  module inferred. Measured over the corpus: 2,398 of the 2,553 injections
   *  carry one, and the 155 that do not are all `hook_success`. Absent here
   *  for those, rather than filled with a guess — an injection nailed to the
   *  wrong turn is a worse reading than one that says where it sat in the
   *  file and no more. */
  parentUuid?: string;
  /** How many characters of text the body carries, its own type name aside.
   *  Counted over every string in it, identifiers included — telling a hook's
   *  name from a hook's output would take exactly the vocabulary this module
   *  refuses to have. The corpus total above is counted the same way. */
  chars: number;
  /** The body opened out, in the file's own key order, in the shape
   *  recordMeta.ts already renders. */
  fields: MetaRow[];
}

/** The three kinds claudeCode.ts already builds a frame for. Read here as
 *  well, they would put one todo list on screen twice and let the two copies
 *  disagree — the defect wire/nonWire.ts was written about, one level down. */
const ALREADY_FRAMED = new Set(["task_reminder", "queued_command", "edited_text_file"]);

/** Cheap prefilter, the same one sourceNotes.ts uses and for the same reason: a
 *  transcript runs to 80 MB and is mostly conversation, and every attachment
 *  record spells this key. */
const CANDIDATE = '"attachment"';

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isEmpty = (value: object): boolean =>
  Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;

/**
 * One value of the body, as rows keyed by the file's own path into it.
 *
 * Small things print and big things are OPENED, rather than named by their
 * shape: `{addedNames: […60 tools]}` past the inline ceiling would come back as
 * "[60 items]", and which tools were loaded is the whole reason a reader opened
 * this. So the descent is what happens where a compact print would not fit,
 * and it goes all the way down — `skills[0].content`, `content.content` — on
 * the file's own paths, the spelling recordMeta.ts already uses for a response
 * block.
 *
 * A long run of language is the one thing NOT split up: it stays whole and is
 * marked `text`, so the pane that paints it applies its own ceiling and says so.
 * A ceiling belongs to the pane, never to the reading.
 */
function walk(value: unknown, path: string, rows: MetaRow[]): void {
  if (typeof value === "string") {
    if (value === "") return;
    if (value.length > INLINE_CHARS) rows.push({ key: path, value, block: "text" });
    else rows.push({ key: path, value });
    return;
  }
  if (value === undefined) return;
  if (value === null) {
    rows.push({ key: path, value: "null" });
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    rows.push({ key: path, value: String(value) });
    return;
  }
  if (typeof value !== "object") return;
  if (isEmpty(value)) return;
  const compact = JSON.stringify(value);
  if (compact !== undefined && compact.length <= INLINE_CHARS) {
    rows.push({ key: path, value: compact });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => walk(entry, `${path}[${i}]`, rows));
    return;
  }
  for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`, rows);
}

/** Every character of language the body holds. Walks the whole value rather
 *  than the rows, because a row can be one compact print of a list of six. */
function textLength(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + textLength(v), 0);
  const record = asRecord(value);
  if (record === null) return 0;
  let total = 0;
  for (const entry of Object.values(record)) total += textLength(entry);
  return total;
}

/**
 * What one line of an imported transcript put into the model's context.
 *
 * @param line one raw line of the file, exactly as it was read
 * @return the injection, or null for a line that is not an attachment record,
 *         one whose kind already becomes a frame, one whose body says nothing
 *         beyond its own type name, and one that does not parse — a line we
 *         cannot read is a line we know nothing about, and the source pane
 *         still shows it verbatim.
 */
export function readContextInjection(line: string): ContextInjection | null {
  if (!line.includes(CANDIDATE)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  if (record === null || record["type"] !== "attachment") return null;
  const body = asRecord(record["attachment"]);
  if (body === null) return null;
  const kind = body["type"];
  if (typeof kind !== "string" || kind === "" || ALREADY_FRAMED.has(kind)) return null;

  const fields: MetaRow[] = [];
  let chars = 0;
  for (const [key, value] of Object.entries(body)) {
    if (key === "type") continue; // the kind above, not a field of it
    walk(value, key, fields);
    chars += textLength(value);
  }
  if (fields.length === 0) return null;

  const parentUuid = record["parentUuid"];
  return {
    kind,
    ...(typeof parentUuid === "string" && parentUuid !== "" ? { parentUuid } : {}),
    chars,
    fields,
  };
}

/** One injection and the line of the file it was read from. */
export interface LocatedInjection {
  /** An index into {@link ImportSource.lines} — the file's own line, counted
   *  from zero, blanks left in place. The same numbering detect.ts hands the
   *  source pane, or the two would name different lines. */
  line: number;
  injection: ContextInjection;
}

/**
 * Everything a whole imported file put into the context, in the order it
 * arrived.
 *
 * Sparse and ordered: only lines that carry an injection appear, so a session
 * with none costs one `includes` per line.
 *
 * WHY THIS ONE MAY BE EAGER when TraceView's record reading may not. That one
 * parses on click because an index over an 80 MB import would parse the whole
 * file to fill a panel nobody opened; here the prefilter means only the lines
 * that name an attachment are ever parsed. Measured on the three largest
 * transcripts on this machine: 86.9 MB / 5,941 lines → 41 injections, 962
 * rows, 28.8 ms; 78.7 MB → 23.2 ms; 50.1 MB → 12.4 ms. Once per import.
 *
 * @param lines the import's own lines, or null/undefined for a session that was
 *              produced here and has no separate source
 */
export function contextInjections(lines: readonly string[] | null | undefined): LocatedInjection[] {
  const found: LocatedInjection[] = [];
  if (!lines) return found;
  for (let i = 0; i < lines.length; i++) {
    const injection = readContextInjection(lines[i]);
    if (injection !== null) found.push({ line: i, injection });
  }
  return found;
}
