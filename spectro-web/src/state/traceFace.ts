// Which face an expanded trace frame OPENS in (owner 2026-07-27) — a face
// store on the shared epoch mechanism in faceStore.ts (extracted from here by
// card 120), persisted to localStorage. It decides the DEFAULT only; a row's
// own click still wins until the master moves again.
//
//   structured  the frame rendered as the thing it is (the pre-master default)
//   insight     the collapsible tree
//   compact     the wire line highlighted and wrapped, all of it on screen
//   wire        plain text, one row per wire line, scrolling sideways
//   source      the line of the imported file this frame was read from
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
// this is not an inconsistency to iron out.
//
// How the reset works without keeping a list of rows: faceStore.ts.

import { DETAIL_MODES, type DetailMode } from "../components/traceDetail";
import { createFaceStore, overrideFace, useFaceStore, type FaceOverride, type FacePref } from "./faceStore";

/** Structured leads; the other four are exactly the detail panel's modes, read
 *  from there so the two lists cannot drift apart. */
export const TRACE_FACES = ["structured", ...DETAIL_MODES] as const;

/** The one word this store used to write, and what it is called now. */
const LEGACY_TRACE_FACES: Readonly<Record<string, TraceFace>> = { raw: "wire" };

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
