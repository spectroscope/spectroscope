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
import type { RunEvent } from "../events";
import type { WithSource } from "../state/traceSource";

export type DetailMode = "insight" | "compact" | "wire" | "source";

export const DETAIL_MODES: readonly DetailMode[] = ["insight", "compact", "wire", "source"];

/** How a pane renders what it was given. Verbatim is the bytes; readable is
 *  openly an interpretation of them (see readable.ts). Deliberately NOT a face
 *  and deliberately not persisted: a saved default of readable would make every
 *  reader's source view an interpretation, and the pane's whole selling point
 *  is that its default cannot be talked out of showing the bytes. */
export type Reading = "verbatim" | "readable";

export const READINGS: readonly Reading[] = ["verbatim", "readable"];

export function detailLines(type: string, payload: unknown): string[] {
  if (type === "session_resume" && payload !== null && typeof payload === "object") {
    const history = (payload as { history?: RunEvent[] }).history;
    if (Array.isArray(history)) return history.map((e) => JSON.stringify(e));
  }
  return [JSON.stringify(payload)];
}

/** What the source pane has to say about one frame. Four cases, each a
 *  statement the app can stand behind, and no fifth one for "unknown". */
export type SourcePane =
  /** No file was imported: this session was produced here and HAS no separate
   *  source, which is not the same as having one we cannot show. */
  | { kind: "none" }
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
export const SOURCE_PANE_KINDS = ["none", "built", "missing", "line"] as const;

/**
 * What the source pane says about one row.
 *
 * @param row   the open row
 * @param rows  the rows it stands among, read only to count the frames that
 *              share its line. A row that is not among them is still counted as
 *              one of that line's frames and placed last, so the count can fall
 *              short of the file's truth but never below what is on screen
 * @param lines the imported file's lines, or null for a session produced here
 */
export function sourcePane(
  row: WithSource,
  rows: readonly WithSource[],
  lines: readonly string[] | null | undefined,
): SourcePane {
  if (!lines) return { kind: "none" };
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
