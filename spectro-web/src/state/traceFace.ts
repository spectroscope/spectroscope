// Which face an expanded trace frame OPENS in (owner 2026-07-27) — a face
// store on the shared epoch mechanism in faceStore.ts (extracted from here by
// card 120), persisted to localStorage. It decides the DEFAULT only; a row's
// own click still wins until the master moves again.
//
//   structured  the frame rendered as the thing it is (the pre-master default)
//   insight     the collapsible tree
//   wire        plain text, one row per wire line, scrolling sideways
//   source      the line of the imported file this frame was read from
//
// WHICH OF THE FOUR ARE ON OFFER DEPENDS ON WHERE THE SESSION CAME FROM (card
// 326). Two objects share names here and that is the whole confusion: the FILE
// LINE is what the recorder wrote, and it exists only when a file was
// imported; OUR RunEvent is what the importer made of that line, and insight
// is its tree while wire is its text. So:
//
//   native            no file at all. Source can answer nothing, and the pane
//                     used to answer it with a correct sentence the reader had
//                     to click to learn nothing from.
//   spectroscope      an imported file our own writer produced. The file line
//                     and the wire line are byte-identical, so source is a
//                     second copy of wire. Re-measured 2026-08-30 — the number
//                     carries the command that made it, because a remembered
//                     one drifts:
//
//                       node -e '<walk ~/.spectro/sessions and
//                         sessions-archive-20260812; count
//                         JSON.stringify(JSON.parse(line)) === line>'
//                       files 727  lines 73335  identical 73331  different 0
//                         unparsable 4
//
//                     Zero divergences. The four unparsable lines cannot reach
//                     a trace at all: detect.ts parses every line up front and
//                     throws "invalid JSONL" for the whole file.
//   claude-code       a foreign record; our RunEvent is a reconstruction of
//                     it, so source and wire are two different documents and
//                     source is the one that is the record.
//   vscode-agent      the same, measured on a real 893-line export: all 849
//                     frames that name a line differ between the two.
//
// See {@link readsForeignRecord} for the one sentence all four answers turn on.
//
// WHY "wire" AND NOT "raw". Until an imported file could show its own line,
// "raw" was the only unrendered thing in the app and the word was unambiguous.
// It is not any more: "the raw line" of an imported session means the file's
// line to a reader and our wire line to us, and a face whose meaning depends on
// where the session came from is exactly the defect the source face exists to
// remove. The content did not change, only the word, and the word is one the
// app already used for it: TraceEntry's own doc says "one frame in the wire
// view" and the German tooltip already said "über den Draht gingen". A stored
// "raw" therefore maps to "wire" rather than falling back (see faceStore).
//
// DELIBERATE DIVERGENCE from disclosure.ts: there a hand-made choice SURVIVES a
// level change (`manual ?? defaultOpen(level)`), because a chat reader opens one
// specific block and means it. Here the master WINS over every hand-made choice.
// The request that produced this switch was "otherwise I have to switch every
// row" — a master that left already-touched rows alone would look broken in
// exactly the case it exists for. The two controls answer different complaints;
// this is not an inconsistency to iron out. The source pane's depth master
// (state/sourceDepth.ts) takes THIS doctrine, for the same complaint.
//
// How the reset works without keeping a list of rows: faceStore.ts.

import { DETAIL_MODES, type DetailMode } from "../components/traceDetail";
import { IMPORT_KINDS, type ImportKind } from "../import/detect";
import { createFaceStore, overrideFace, useFaceStore, type FaceOverride, type FacePref } from "./faceStore";

/** Structured leads; the other four are exactly the detail panel's modes, read
 *  from there so the two lists cannot drift apart. */
export const TRACE_FACES = ["structured", ...DETAIL_MODES] as const;

/** The one word this store used to write, and what it is called now. */
/** Faces that used to exist, and where a reader who saved one now lands.
 *  `compact` was the wire line wrapped; Wire's readable reading is that same
 *  text with the escapes undone, so wire is where it belongs. */
const LEGACY_TRACE_FACES: Readonly<Record<string, TraceFace>> = { raw: "wire", compact: "wire" };

export type TraceFace = "structured" | DetailMode;

export const DEFAULT_TRACE_FACE: TraceFace = "structured";

/** The master switch as the frames read it. */
export type TraceFacePref = FacePref<TraceFace>;

/** What one row was switched to by hand, and under which master. */
export type RowFace = FaceOverride<TraceFace>;

const store = createFaceStore<TraceFace>(
  "spectroscope:trace.face",
  TRACE_FACES,
  DEFAULT_TRACE_FACE,
  LEGACY_TRACE_FACES,
);

/** Visible for tests: the stored master, or the default for anything else. */
export function parseTraceFace(raw: string | null): TraceFace {
  return store.parse(raw);
}

export function setTraceFace(next: TraceFace): void {
  store.set(next);
}

/** Visible for tests. */
export function currentTraceFace(): TraceFacePref {
  return store.current();
}

/**
 * Which face one row shows.
 *
 * @param master the master switch, epoch included
 * @param override what this row was switched to by hand, or null
 * @return the row's own face while its stamp is current, else the master's
 */
export function rowFace(master: TraceFacePref, override: RowFace | null): TraceFace {
  return overrideFace(master, override);
}

export function useTraceFace(): TraceFacePref {
  return useFaceStore(store);
}

/** Where the frames on screen came from. `native` is everything this app
 *  produced or is only watching — a live socket, a stored session re-opened, a
 *  compiled scenario, an entered fleet — and the three others are the formats
 *  the importer reads, taken from {@link IMPORT_KINDS} rather than typed out
 *  again. */
export type TraceOrigin = "native" | ImportKind;

/** Every origin, for the walks that must not miss one. Derived: a fourth
 *  import format widens this list on the day it lands, instead of on the day
 *  somebody remembers this file. */
export const TRACE_ORIGINS = ["native", ...IMPORT_KINDS] as const;

/** Is the file behind these frames somebody ELSE'S record?
 *
 *  The one sentence the whole offer turns on, answered per origin rather than
 *  inferred. A Record and not a condition, so a format added to
 *  {@link IMPORT_KINDS} is a compile error here until somebody answers for it:
 *  an origin that quietly inherited `false` would ship a face list nobody
 *  decided.
 *
 *  import/contextRecording.ts asks a question of the same shape and does NOT
 *  do this — `recordsSystemPrompt` is `kind === "spectroscope"`, a condition,
 *  and a fourth format inherits `false` from it in silence. That file was cited
 *  here as the precedent for the Record until the re-review of card 326
 *  measured the opposite; it is named now as the hole it is, not as the model.
 *
 *  `native`: there is no file, so there is no record of anybody's.
 *  `spectroscope`: our own writer wrote it, and the file line IS the wire line
 *  — byte-identical over 73,331 frames; the command is in this file's header.
 *  `claude-code`, `vscode-agent`: a foreign recorder wrote it and our RunEvent
 *  is a reconstruction; measured different on every frame of a real export. */
const FOREIGN_RECORD: Readonly<Record<TraceOrigin, boolean>> = {
  native: false,
  spectroscope: false,
  "claude-code": true,
  "vscode-agent": true,
};

export function readsForeignRecord(origin: TraceOrigin): boolean {
  return FOREIGN_RECORD[origin];
}

/**
 * Which faces a SESSION from this origin can answer at all.
 *
 * Source shows the recorder's own line and only a foreign record has one worth
 * a button; insight and wire show OUR RunEvent, which is the document itself
 * when the record is ours and a reconstruction beside the record when it is
 * not. Structured survives every withdrawal, which is what keeps the pane from
 * ever going blank: `describeEvent` returned something for all 69,002 frames
 * of the 364 measured Claude Code transcripts.
 *
 * Filtered out of {@link TRACE_FACES}, never re-ordered, so the toolbar reads
 * the same way in every session. It IS the toolbar's list since the re-review
 * of card 326 — for a release the sentence above was true of the open row's
 * strip and false of the master switch above it, which went on mapping
 * TRACE_FACES and offered Source on sessions with no file.
 *
 * @param origin where the frames came from
 * @return the faces this session can fill, in the toolbar's own order
 */
export function facesOf(origin: TraceOrigin): TraceFace[] {
  const foreign = readsForeignRecord(origin);
  return TRACE_FACES.filter((f) => {
    if (f === "source") return foreign;
    if (f === "insight" || f === "wire") return !foreign;
    return true;
  });
}

/** The frame types that have no source line to show, and never will.
 *
 *  A recorded LLM exchange (card 184) keeps its bytes in the sidecar, and the
 *  endpoint that serves them re-serializes parsed nodes, so "the line this
 *  frame was read from, byte for byte" is not a thing that exists for it. The
 *  pane used to answer that with a riddle, "the stored session does not contain
 *  this frame", while the frame's own file lay right beside the session. A face
 *  with nothing behind it is not offered. */
const WITHOUT_SOURCE: ReadonlySet<string> = new Set(["llm_exchange", "llm_request", "llm_response"]);

/**
 * Which faces one row offers, in the toolbar's own order so the buttons never
 * reshuffle between rows.
 *
 * Two withdrawals, composed rather than competing: the session says which
 * faces it can answer at all, and the frame type can only take further ones
 * off that list. A recorded exchange inside a Claude Code import therefore
 * offers `structured` alone — its session withdrew our two readings and the
 * frame has no file line.
 *
 * @param type   the frame's type
 * @param origin where the session's frames came from
 * @return the faces this row can actually fill
 */
export function facesFor(type: string, origin: TraceOrigin): TraceFace[] {
  const session = facesOf(origin);
  return WITHOUT_SOURCE.has(type) ? session.filter((f) => f !== "source") : session;
}

/**
 * The origin the trace on screen is reading.
 *
 * Read off the two facts the app already carries rather than off the replay's
 * id: that id is a display label with a filename in it, and deriving a
 * behavioural switch from a formatted string is the defect this file's header
 * argues against.
 *
 * @param kind    the format an imported session was read from, or undefined
 *                when the session on screen was not imported
 * @param fleetId the entered fleet's context id, or null when none is entered.
 *                An entered fleet shows OTHER processes' frames, so whatever
 *                file the session behind it came from says nothing about them
 * @return the origin whose faces this trace may offer
 */
export function traceOriginOf(kind: ImportKind | undefined, fleetId: string | null): TraceOrigin {
  if (fleetId !== null) return "native";
  return kind ?? "native";
}

/**
 * The face a row shows when the one it was asked for is not on offer.
 *
 * The master switch is a default for EVERY row at once, so a reader whose
 * master is `source` will land on rows that have none. The landing has to be
 * somewhere real and the same every time: the nearest neighbour to the left,
 * which puts `source` on `wire` — the two faces that both mean "the bytes".
 * Forward only when there is nothing to the left at all.
 *
 * Since card 326 a whole SESSION can withdraw a face, not only a frame type,
 * so this is also where a reader who saved `wire` lands when they open a
 * foreign transcript: on `structured`, the one face every origin answers. What
 * it does NOT do is write that landing back — the stored master says what the
 * reader wants, not what this file can show, so the next native session gives
 * them their own face again.
 *
 * @param chosen    the face the master or the row's own click asked for
 * @param available what this row offers, from {@link facesFor}
 * @return a face that is certainly on offer
 */
export function availableFace(chosen: TraceFace, available: readonly TraceFace[]): TraceFace {
  if (available.includes(chosen)) return chosen;
  const at = TRACE_FACES.indexOf(chosen);
  for (let i = at - 1; i >= 0; i--) {
    if (available.includes(TRACE_FACES[i])) return TRACE_FACES[i];
  }
  for (let i = at + 1; i < TRACE_FACES.length; i++) {
    if (available.includes(TRACE_FACES[i])) return TRACE_FACES[i];
  }
  return chosen;
}
