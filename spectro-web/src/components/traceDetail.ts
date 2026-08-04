// Pure view-mode logic for the trace detail panel. Every entry has "wire
// lines": an ordinary frame is exactly ONE line (JSON as it crossed the
// socket, no artificial breaks); the synthetic session_resume marker carries
// the whole re-uploaded history, one JSONL line per event. Wire and Compact
// carry the same text and differ in how it is painted: Wire keeps one row per
// wire line and scrolls sideways, Compact wraps so the whole record is on
// screen (owner 2026-08-03, and the reason the two names now mean two things).
// The wrap is a stylesheet fact only. This module still hands the clipboard one
// line per wire line, because a copy that pasted the pane's line breaks would
// paste a file nobody wrote.
//
// The fifth face, source, shows something else entirely: the line of the
// IMPORTED FILE the frame was read from. Wire and source are the same bytes
// for a session this app produced and different bytes for an imported one, so
// they are two faces and never one. The face that used to be called "raw" is
// called "wire" for the same reason, see state/traceFace.ts.

import { readableText } from "./readable";
import { replayEyebrow } from "./replayEyebrow";
import type { RunEvent } from "../events";
import type { WithSource } from "../state/traceSource";
import { NON_WIRE_TYPES } from "../wire/nonWire";

export type DetailMode = "insight" | "compact" | "wire" | "source";

export const DETAIL_MODES: readonly DetailMode[] = ["insight", "compact", "wire", "source"];

/** How a pane renders what it was given. Verbatim is the bytes; readable is
 *  openly an interpretation of them (see readable.ts). Readable is what the pane
 *  shows first (owner call, 2026-08-03): a source line is escaped JSON inside
 *  escaped JSON, and that form is unreadable at a glance, so opening on it makes
 *  the pane look broken rather than faithful. What keeps the pane honest is not
 *  which rendering comes up first but that the strip above it names the one on
 *  screen and verbatim is one click away. Deliberately NOT a face, and the
 *  choice is session only: it is never persisted, so it cannot follow a reader
 *  into the next file they look at. */
export type Reading = "verbatim" | "readable";

export const READINGS: readonly Reading[] = ["verbatim", "readable"];

export function detailLines(type: string, payload: unknown): string[] {
  if (type === "session_resume" && payload !== null && typeof payload === "object") {
    const history = (payload as { history?: RunEvent[] }).history;
    if (Array.isArray(history)) return history.map((e) => JSON.stringify(e));
  }
  return [JSON.stringify(payload)];
}

/**
 * Where the frames on screen came from, when no file was imported.
 *
 * "No file" is not one situation. A live session and a stored archive were
 * produced by this app and written down by it; a scenario was compiled in the
 * browser out of its script and never written anywhere; an entered fleet's
 * frames were produced by other processes. Read off the ids the app already
 * carries, through replayEyebrow, so the word in the header and the sentence in
 * the pane cannot drift apart.
 */
export type TraceProvenance = "stored" | "scenario" | "fleet";

/**
 * @param replayId the replay on screen, or null while the live session is
 * @param fleetId  the entered fleet's context id, or null when none is entered
 */
export function traceProvenance(replayId: string | null, fleetId: string | null): TraceProvenance {
  // A fleet scenario is entered like a live fleet and is still a scenario, so
  // the id decides before the fleet flag does.
  const id = fleetId ?? replayId;
  if (id !== null && replayEyebrow(id) === "hdr.scenario") return "scenario";
  return fleetId !== null ? "fleet" : "stored";
}

/** Frame types no session file ever holds. Two groups, one rule: a session's
 *  JSONL holds the engine's run events and nothing else.
 *
 *  Taken from the writers' own gate, plus the one name that gate cannot know:
 *  system_context is built in this browser for this screen, so it is neither a
 *  wire event nor a socket frame and nothing on the Java side has ever heard of
 *  it. Everything else the pane calls unstored is exactly what no writer may put
 *  in a file, and the two used to be hand-kept lists that disagreed: this one
 *  named otlp_export and the two fleet frames while the writers' one did not,
 *  and the export wrote them.
 *
 *  Everything this app SENDS is unstored too, whatever its type, which is the
 *  direction check rather than a list. */
const UNSTORED_TYPES = new Set(["system_context", ...NON_WIRE_TYPES]);

/** What the pane reads off the open row: the line it names, if it names one,
 *  and enough of the frame to know whether any file holds it. */
export interface PaneRow extends WithSource {
  type: string;
  dir: "in" | "out";
}

/** Whether a stored session would contain this frame at all. */
function fileHolds(row: PaneRow): boolean {
  return row.dir !== "out" && !UNSTORED_TYPES.has(row.type);
}

/** What the source pane has to say about one frame. Every case is a statement
 *  the app can stand behind, and there is no case for "unknown". */
export type SourcePane =
  /** No file was imported, this session was produced here, and this frame is
   *  one of the lines it wrote: it HAS no separate source, which is not the
   *  same as having one we cannot show. */
  | { kind: "none" }
  /** No file holds this frame: the app built it for the screen, or sent it over
   *  the socket. Said whatever the session is, because it is a fact about the
   *  frame and not about where the session came from. */
  | { kind: "unstored" }
  /** The frames were compiled in this browser out of a scenario script: no
   *  file, and no wire line either. */
  | { kind: "scenario" }
  /** The frames were produced by other processes and are only being watched
   *  here, so "produced here" is the one thing they are not. */
  | { kind: "fleet" }
  /** Imported, but the importer built this frame rather than reading it off one
   *  line: the synthetic system_context, the provider_info before the first
   *  record, the run_end after the last. */
  | { kind: "built" }
  /** Imported, the frame names a line, and the file does not have it. A guard,
   *  not an expected state: reporting it as "built" would be a sentence the
   *  reader would believe. */
  | { kind: "missing"; lineNumber: number; total: number }
  | {
      kind: "line";
      /** The line, whole. Capping it for display is the pane's job, see
       *  withinBudget; copying is always this. */
      text: string;
      /** 1 based: the number a reader counts to when opening the file. */
      lineNumber: number;
      total: number;
      /** How many frames this one line produced, this frame included. */
      siblings: number;
      /** Which of them this frame is, 1 based. */
      ordinal: number;
    };

/** Every pane case, for the dictionary's coverage test. */
export const SOURCE_PANE_KINDS = [
  "none",
  "unstored",
  "scenario",
  "fleet",
  "built",
  "missing",
  "line",
] as const;

/**
 * What the source pane says about one row.
 *
 * @param row        the open row
 * @param rows       the rows it stands among, read only to count the frames
 *                   that share its line. A row that is not among them is still
 *                   counted as one of that line's frames and placed last, so
 *                   the count can fall short of the file's truth but never
 *                   below what is on screen
 * @param lines      the imported file's lines, or null when no file is loaded
 * @param provenance where the rows came from, for the three different ways of
 *                   having no file. Required and not defaulted: the default
 *                   would be the byte-for-byte promise, and a caller that
 *                   forgot to answer would make it on their behalf
 */
export function sourcePane(
  row: PaneRow,
  rows: readonly WithSource[],
  lines: readonly string[] | null | undefined,
  provenance: TraceProvenance,
): SourcePane {
  if (!lines) {
    // The frame's own answer first: a system_context inside a scenario was
    // built by this app for this screen, not compiled out of the script.
    if (!fileHolds(row)) return { kind: "unstored" };
    return provenance === "stored" ? { kind: "none" } : { kind: provenance };
  }
  const at = row.sourceLine;
  if (at === undefined) return { kind: "built" };
  if (at < 0 || at >= lines.length) {
    return { kind: "missing", lineNumber: at + 1, total: lines.length };
  }
  let siblings = 0;
  let ordinal = 0;
  for (const other of rows) {
    if (other.sourceLine !== at) continue;
    siblings++;
    if (other === row) ordinal = siblings;
  }
  if (ordinal === 0) ordinal = ++siblings; // the row was not in the set, see @param
  return {
    kind: "line",
    text: lines[at],
    lineNumber: at + 1,
    total: lines.length,
    siblings,
    ordinal,
  };
}

/**
 * Which sentence the pane says, once the screen has its say too.
 *
 * Only the "none" case needs asking. Its second half is a claim about the face
 * NEXT to this one, "The wire line is the stored line, byte for byte", and a
 * translation makes that false: App.tsx swaps every row's payload for the
 * translated event and the wire face renders exactly that. Nothing else here
 * says anything about the wire line, so nothing else changes. A note pinned to
 * all seven cases would be noise on six of them.
 *
 * Kept out of {@link sourcePane} because the two facts have different owners:
 * which bytes a file holds belongs to the file, and whether a translation is on
 * screen belongs to the screen.
 *
 * @param pane       what the pane found
 * @param translated whether the rows are carrying translated payloads
 * @return the dictionary key for the sentence
 */
export function sourceSentence(pane: SourcePane, translated: boolean): string {
  if (pane.kind === "none" && translated) return "trace.source.noneTranslated";
  return `trace.source.${pane.kind}`;
}

/** How much of one line the pane paints before it stops and says so. Single
 *  lines in the corpus reach 769295 characters and a 4.7 MB image block is an
 *  ordinary record, so a pane without a ceiling is a pane that freezes.
 *
 *  Counted in the units JavaScript counts a string in, which is also what the
 *  pane reports. "Bytes" would be a second unit for the same number, and this
 *  card exists to remove exactly that. */
export const SOURCE_DISPLAY_CHARS = 65536;

export interface Budgeted {
  text: string;
  shown: number;
  total: number;
  /** True when the pane is showing less than the whole line, which the pane
   *  then SAYS. Truncation that names itself is a display limit; truncation
   *  that stays quiet is the defect. */
  capped: boolean;
}

export function withinBudget(text: string, budget: number = SOURCE_DISPLAY_CHARS): Budgeted {
  if (text.length <= budget) return { text, shown: text.length, total: text.length, capped: false };
  let cut = budget;
  // Never between the two halves of one character: that would put a broken
  // glyph on screen and call it the file's own bytes.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return { text: text.slice(0, cut), shown: cut, total: text.length, capped: true };
}

/** The source line a frame was read from, and how the pane is reading it. */
export interface DetailSource {
  /** The whole line, verbatim. Absent for a frame with no line behind it. */
  line?: string;
  reading?: Reading;
}

/**
 * What the copy button grabs.
 *
 * The pretty tree for Insight, the exact lines for Compact and Wire (identical
 * text, they differ only in highlighting), the imported line for Source. In
 * every case the WHOLE of it: the display budget caps the paint, never the
 * clipboard, or the reader walks away with a file they believe is complete.
 *
 * @param source the frame's imported line and the pane's reading; absent means
 *               verbatim, and no source line
 * @return the text; empty for a source pane with no line behind it, where the
 *         caller does not offer the button at all
 */
export function detailText(mode: DetailMode, type: string, payload: unknown, source?: DetailSource): string {
  const reading = source?.reading ?? "verbatim";
  if (mode === "source") {
    const line = source?.line;
    if (line === undefined) return "";
    return reading === "readable" ? readableText(line) : line;
  }
  if (mode === "insight") return JSON.stringify(payload, null, 2);
  const lines = detailLines(type, payload);
  // A blank line between opened lines, because a readable rendering already
  // spends single newlines on the text it opened.
  if (reading === "readable") return lines.map(readableText).join("\n\n");
  return lines.join("\n");
}

/** What the copy button is allowed to call itself, interpolated as
 *  `common.${label}`. */
export const COPY_LABELS = ["copy", "copyReadable"] as const;

export type CopyLabel = (typeof COPY_LABELS)[number];

/**
 * Which of the two the button took.
 *
 * Copying prettified text while the reader believes they copied the source is
 * this card's defect in miniature, so the label follows the reading instead of
 * staying one word for both.
 */
export function copyLabel(mode: DetailMode, reading: Reading): CopyLabel {
  // Insight has no reading strip: its text is the payload, pretty printed, and
  // there is no second version of it to be confused with.
  return reading === "readable" && mode !== "insight" ? "copyReadable" : "copy";
}
