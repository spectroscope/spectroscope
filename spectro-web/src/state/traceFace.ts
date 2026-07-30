// Which face an expanded trace frame OPENS in (owner 2026-07-27) — a face
// store on the shared epoch mechanism in faceStore.ts (extracted from here by
// card 120), persisted to localStorage. It decides the DEFAULT only; a row's
// own click still wins until the master moves again.
//
//   structured — the frame rendered as the thing it is (the pre-master default)
//   insight    — the collapsible tree
//   compact    — one highlighted row per wire line
//   raw        — plain text, the wire lines verbatim
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

/** Structured leads; the other three are exactly the detail panel's modes, read
 *  from there so the two lists cannot drift apart. */
export const TRACE_FACES = ["structured", ...DETAIL_MODES] as const;

export type TraceFace = "structured" | DetailMode;

export const DEFAULT_TRACE_FACE: TraceFace = "structured";

/** The master switch as the frames read it. */
export type TraceFacePref = FacePref<TraceFace>;

/** What one row was switched to by hand, and under which master. */
export type RowFace = FaceOverride<TraceFace>;

const store = createFaceStore<TraceFace>("spectroscope:trace.face", TRACE_FACES, DEFAULT_TRACE_FACE);

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
