// Pure view-mode logic for the trace detail panel. Every entry has "wire
// lines": an ordinary frame is exactly ONE line (JSON as it crossed the
// socket, no artificial breaks); the synthetic session_resume marker carries
// the whole re-uploaded history, one JSONL line per event. The wire face keeps
// one row per wire line and scrolls sideways; its readable reading is the same
// text with the escapes undone. This module hands the clipboard one line per
// wire line, because a copy that pasted the pane's line breaks would paste a
// file nobody wrote.
//
// The source face shows something else entirely: the line of the IMPORTED FILE
// the frame was read from. Wire and source are the same bytes for a file our
// own writer produced and different bytes for a foreign one — which is why,
// since card 326, the two are never both on offer. Which faces a session can
// answer at all is state/traceFace.ts's decision, taken from where the frames
// came from; this module only says what each face then SHOWS. The face that
// used to be called "raw" is called "wire" for the same reason, see there.

import { parseDocument, readableText } from "./readable";
import type { RunEvent } from "../events";
import type { WithSource } from "../state/traceSource";

/**
 * The faces a frame opens in. `compact` was here and is gone (owner, 2026-08-05).
 *
 * It was the wire line, wrapped. What made it a face of its own was that Wire
 * did NOT wrap — one text, two names, distinguished by a stylesheet. Since Wire
 * grew its verbatim/readable reading, the readable one is the same wrapped text
 * with the escapes undone, so `compact` had become the strictly worse of two
 * things one click apart. A face nobody can tell from its neighbour is a face
 * that costs a reader a decision and returns nothing.
 *
 * A stored `compact` maps to `wire`; see LEGACY_TRACE_FACES.
 */
export type DetailMode = "insight" | "wire" | "source";

export const DETAIL_MODES: readonly DetailMode[] = ["insight", "wire", "source"];

/** How a pane renders what it was given. Verbatim is the bytes; readable is
 *  openly an interpretation of them (see readable.ts); `tree` is the same line
 *  parsed and drawn as the collapsible, highlighted JsonTree (owner
 *  2026-08-30). Readable is what the pane shows first (owner call, 2026-08-03):
 *  a source line is escaped JSON inside escaped JSON, and that form is
 *  unreadable at a glance, so opening on it makes the pane look broken rather
 *  than faithful. What keeps the pane honest is not which rendering comes up
 *  first but that the strip above it names the one on screen and verbatim is
 *  one click away.
 *
 *  STILL DELIBERATELY NOT A FACE, now that one of the three draws the shape a
 *  face draws. A FACE answers "which of this frame's several selves am I
 *  looking at"; a READING answers "how is that one being painted". The tree
 *  keeps that line: it paints the SOURCE LINE, where the insight FACE paints
 *  OUR RunEvent, and on a foreign import those are not the same document —
 *  which is the whole of card 326. That is also why `readingsFor` refuses the
 *  tree on the wire pane, where it would be the insight face under a second
 *  name.
 *
 *  It is spelled `tree` and not `insight` for a reason that is not taste:
 *  {@link copyLabel} already asks `mode !== "insight"`, and a reading spelled
 *  the same word as a face would give that one line two meanings.
 *
 *  The choice is session only: never persisted, so it cannot follow a reader
 *  into the next file they look at. How far the tree OPENS is a different
 *  question with a different answer, and it is persisted — state/sourceDepth.ts. */
export type Reading = "verbatim" | "readable" | "tree";

export const READINGS: readonly Reading[] = ["verbatim", "readable", "tree"];

/**
 * Which readings one pane offers, in the strip's own order so the buttons
 * never reshuffle between panes.
 *
 * Only source has three. Wire deliberately does NOT get the tree: a tree of
 * our own wire line IS the insight face, one click to the left, and two
 * controls rendering the same thing under two names is precisely what retired
 * `compact`. Insight gets no strip at all — what it renders is the payload,
 * and there is no second version of it to be confused with.
 *
 * IT TAKES THE PANE and not only the face (re-review of card 326). A `built`
 * or `missing` source pane names no line, so all three readings drew the same
 * one sentence: three buttons that changed nothing, over a pane with no copy
 * button under it. state/traceFace.ts argues "a face with nothing behind it is
 * not offered at all" and this card's own depth strip obeys that; the readings
 * could not, because this function was never told which pane it was answering
 * for.
 *
 * @param mode the face the pane is showing
 * @param pane what the source pane found, or null for a face that is not source
 * @return the readings that face can be painted in; empty for a face with one
 *         rendering and for a pane with no line, where the strip is not drawn
 */
export function readingsFor(mode: DetailMode, pane: SourcePane | null): Reading[] {
  if (mode === "source") return pane?.kind === "line" ? [...READINGS] : [];
  if (mode === "wire") return READINGS.filter((r) => r !== "tree");
  return [];
}

/**
 * The reading a pane shows when the one it was asked for is not on offer.
 *
 * The reader's pick survives a walk from row to row and from session to
 * session, so it will meet panes that cannot answer it — pick Tree on a foreign
 * import, open a spectroscope session, and the pane in front of them offers
 * two. This used to jump to `verbatim`, which is the one reading this module
 * argues the pane must not OPEN on ("unreadable at a glance … makes the pane
 * look broken rather than faithful"). It now lands the way a FACE lands
 * (state/traceFace.ts, availableFace): the nearest neighbour to the left, and
 * forward only when there is nothing to the left at all.
 *
 * @param chosen    the reading the reader picked
 * @param available what this pane offers, from {@link readingsFor}
 * @return a reading that is certainly on offer; `chosen` when the pane offers
 *         nothing at all and no strip is drawn
 */
export function availableReading(chosen: Reading, available: readonly Reading[]): Reading {
  if (available.includes(chosen)) return chosen;
  const at = READINGS.indexOf(chosen);
  for (let i = at - 1; i >= 0; i--) {
    if (available.includes(READINGS[i])) return READINGS[i];
  }
  for (let i = at + 1; i < READINGS.length; i++) {
    if (available.includes(READINGS[i])) return READINGS[i];
  }
  return chosen;
}

export function detailLines(type: string, payload: unknown): string[] {
  if (type === "session_resume" && payload !== null && typeof payload === "object") {
    const history = (payload as { history?: RunEvent[] }).history;
    if (Array.isArray(history)) return history.map((e) => JSON.stringify(e));
  }
  return [JSON.stringify(payload)];
}

/** What the source pane has to say about one frame. Every case is a statement
 *  the app can stand behind, and there is no case for "unknown".
 *
 *  THREE CASES, WHERE THERE WERE SEVEN (card 326). The four that went — `none`,
 *  `unstored`, `scenario`, `fleet` — were all answers to "there is no imported
 *  file behind these frames", and the trace no longer asks: the source face is
 *  offered only where the session read a foreign record, so by the time this
 *  function is called a file is a fact. They were correct sentences that a
 *  reader had to click a button to learn nothing from, and keeping them would
 *  have left four sentences in the dictionary that no screen can reach. */
export type SourcePane =
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
export const SOURCE_PANE_KINDS = ["built", "missing", "line"] as const;

/**
 * What the source pane says about one row.
 *
 * @param row   the open row
 * @param rows  the rows it stands among, read only to count the frames that
 *              share its line. A row that is not among them is still counted as
 *              one of that line's frames and placed last, so the count can fall
 *              short of the file's truth but never below what is on screen
 * @param lines the imported file's lines. Required and not nullable since card
 *              326: the caller has already established that this session reads
 *              a foreign record, and a file is what that means. A frame the
 *              importer BUILT still has no line of its own, and says so
 */
export function sourcePane(
  row: WithSource,
  rows: readonly WithSource[],
  lines: readonly string[],
): SourcePane {
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
 * Which sentence the pane says.
 *
 * One key per case, built here rather than in the markup so the dictionary's
 * coverage test can walk every case this can return and find a sentence for
 * it. It used to take a second argument, `translated`, for the one case that
 * promised the wire line beside it was the stored line byte for byte — a
 * promise a translation broke. That case is gone with the fileless panes (see
 * {@link SourcePane}), and on a foreign import there is no such promise to
 * break: the wire face is not on offer, and the line this pane shows is the
 * file's own either way.
 *
 * @param pane what the pane found
 * @return the dictionary key for the sentence
 */
export function sourceSentence(pane: SourcePane): string {
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

/** Why a line has no tree. TWO reasons and not one, because they are two
 *  different statements about the file and a shared sentence would make one of
 *  them false: `noDocument` says the line is not an object or an array,
 *  `tooLong` says it is one and is bigger than this pane draws. Saying "not a
 *  JSON object" about a 2.7 MB document that is one would be the pane lying
 *  about the file, which is the defect the source face exists to remove.
 *
 *  Walked by i18n.test.ts, which holds a sentence open for each. */
export const NO_TREE_REASONS = ["noDocument", "tooLong"] as const;

export type NoTreeReason = (typeof NO_TREE_REASONS)[number];

/** Whether a source line is a document this pane will draw, and the document
 *  if it is.
 *
 *  THE SHAPE JUDGEMENT belongs to readable.ts and is borrowed, never copied:
 *  the readable reading says the same sentence for exactly this set of lines,
 *  and two readings of one pane disagreeing about the same line would be worse
 *  than either verdict.
 *
 *  A bare value is deliberately not a document. `null`, `12` and `"a"` are all
 *  valid JSON and would each draw a tree of one leaf, which is an empty tree
 *  wearing a caret — the pane looking broken rather than faithful. `{}` and
 *  `[]` DO draw, because an empty document is what the line actually says.
 *
 *  THE SIZE JUDGEMENT is this pane's own {@link SOURCE_DISPLAY_CHARS}, and it
 *  was missing until the re-review of card 326. Verbatim and readable both obey
 *  that ceiling and say they capped; the tree handed its whole value to
 *  JsonTree, which caps neither string leaves nor node counts. Measured over
 *  the owner's real corpus on 2026-08-30 —
 *
 *    node -e '<walk ~/.claude/projects/**.jsonl; count lines over 65536 chars>'
 *    files 7656  lines 963028  over 65536: 10617 (1.102%)  longest 2706596
 *
 *  — so one click in one percent of those rows builds a tree over a 2.7 MB
 *  document. Nothing is lost by refusing: verbatim shows the line, says how
 *  much of it is on screen, and carries the button that lifts the ceiling on
 *  request. */
export type SourceTree = { parsed: true; value: unknown } | { parsed: false; why: NoTreeReason };

/**
 * @param line the source line, verbatim
 * @return the parsed document to draw, or the reason there is no tree in it
 */
export function sourceTree(line: string): SourceTree {
  if (line.length > SOURCE_DISPLAY_CHARS) return { parsed: false, why: "tooLong" };
  const doc = parseDocument(line);
  return doc.ok ? { parsed: true, value: doc.value } : { parsed: false, why: "noDocument" };
}

/**
 * The reading the pane can actually give, as opposed to the one it was asked
 * for.
 *
 * Only the tree can be asked for and not delivered: a line that is not a
 * document has no tree, and the `built` and `missing` panes name no line at
 * all. Resolved HERE, once, before anything downstream names the reading —
 * a copy button saying "Copy tree" while handing over a raw log line would be
 * this card's own defect in miniature.
 *
 * @param reading what the reader picked
 * @param line    the line the pane is showing, or undefined when it shows none
 * @return the reading that will be painted, and named
 */
export function resolvedReading(reading: Reading, line: string | undefined): Reading {
  if (reading !== "tree") return reading;
  return line !== undefined && sourceTree(line).parsed ? "tree" : "verbatim";
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
 * The pretty payload for Insight, the exact lines for Wire, the imported line
 * for Source in whichever of its three readings is on screen. In every case
 * the WHOLE of it: the display budget caps the paint, never the clipboard, or
 * the reader walks away with a file they believe is complete.
 *
 * ONE FILE LINE, ONE DOCUMENT, on the source pane. A frame was read from
 * exactly one line of the file, however many wire lines its payload makes, so
 * the blank-line join the wire readings use never applies here: joining would
 * put a file nobody wrote in somebody's clipboard. The tree reading hands over
 * that one document laid out the way the tree lays it out, which is the same
 * text the insight face's button hands over — and pointedly not the pane's own
 * line breaks, because a tree is not text.
 *
 * @param source the frame's imported line and the pane's reading; absent means
 *               verbatim, and no source line
 * @return the text; empty for a source pane with no line behind it, where the
 *         caller does not offer the button at all
 */
export function detailText(mode: DetailMode, type: string, payload: unknown, source?: DetailSource): string {
  const asked = source?.reading ?? "verbatim";
  if (mode === "source") {
    const line = source?.line;
    if (line === undefined) return "";
    const reading = resolvedReading(asked, line);
    if (reading === "tree") {
      const tree = sourceTree(line);
      // resolvedReading has already established the parse; the guard is what
      // keeps the type honest rather than a second opinion about the line.
      return tree.parsed ? JSON.stringify(tree.value, null, 2) : line;
    }
    return reading === "readable" ? readableText(line) : line;
  }
  if (mode === "insight") return JSON.stringify(payload, null, 2);
  const lines = detailLines(type, payload);
  // A blank line between opened lines, because a readable rendering already
  // spends single newlines on the text it opened.
  if (asked === "readable") return lines.map(readableText).join("\n\n");
  return lines.join("\n");
}

/** What the copy button is allowed to call itself, interpolated as
 *  `common.${label}`. One word per reading, and no two readings sharing one. */
export const COPY_LABELS = ["copy", "copyReadable", "copyTree"] as const;

export type CopyLabel = (typeof COPY_LABELS)[number];

/**
 * Which of the three the button took.
 *
 * Copying prettified text while the reader believes they copied the source is
 * this card's defect in miniature, so the label follows the reading instead of
 * staying one word for all of them.
 *
 * @param mode    the face the pane is showing
 * @param reading the reading the pane is ACTUALLY painting — resolved through
 *                {@link resolvedReading} by the caller, so a tree asked for
 *                over a line that has none says "copy" and hands over bytes
 */
export function copyLabel(mode: DetailMode, reading: Reading): CopyLabel {
  // The insight FACE has no reading strip: its text is the payload, pretty
  // printed, and there is no second version of it to be confused with. The
  // reading called `tree` must not reach in and rename that button, which is
  // the whole reason it is not called `insight`.
  if (mode === "insight") return "copy";
  if (reading === "readable") return "copyReadable";
  return reading === "tree" ? "copyTree" : "copy";
}
