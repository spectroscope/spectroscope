// Which face an expanded trace frame OPENS in (owner 2026-07-27) — a tiny
// external store à la traceColumns.ts / disclosure.ts, persisted to
// localStorage. It decides the DEFAULT only; a row's own click still wins until
// the master moves again.
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
// The reset keeps no list of rows: an override is stamped with the epoch it was
// made under, and every real master change bumps the epoch, so all stamps go
// stale at once. The epoch is monotonic rather than the face's own value,
// because structured → compact → structured must not resurrect an override made
// under the first structured. It is never persisted: overrides do not outlive a
// reload either.

import { useSyncExternalStore } from "react";
import { DETAIL_MODES, type DetailMode } from "../components/traceDetail";

/** Structured leads; the other three are exactly the detail panel's modes, read
 *  from there so the two lists cannot drift apart. */
export const TRACE_FACES = ["structured", ...DETAIL_MODES] as const;

export type TraceFace = "structured" | DetailMode;

export const DEFAULT_TRACE_FACE: TraceFace = "structured";

/** The master switch as the frames read it. */
export interface TraceFacePref {
  face: TraceFace;
  /** Bumped on every real master change — see the header. */
  epoch: number;
}

/** What one row was switched to by hand, and under which master. */
export interface RowFace {
  face: TraceFace;
  epoch: number;
}

const KEY = "spectroscope:trace.face";

function isFace(raw: string | null): raw is TraceFace {
  return raw !== null && (TRACE_FACES as readonly string[]).includes(raw);
}

/** Visible for tests: the stored master, or the default for anything else. */
export function parseTraceFace(raw: string | null): TraceFace {
  return isFace(raw) ? raw : DEFAULT_TRACE_FACE;
}

function readSaved(): TraceFacePref {
  try {
    return { face: parseTraceFace(localStorage.getItem(KEY)), epoch: 0 };
  } catch {
    /* no localStorage (tests) — default */
  }
  return { face: DEFAULT_TRACE_FACE, epoch: 0 };
}

let pref: TraceFacePref = readSaved();
const listeners = new Set<() => void>();

export function setTraceFace(next: TraceFace): void {
  if (next === pref.face) return;
  // A fresh object per change, the same one between changes — the snapshot
  // identity is what useSyncExternalStore compares.
  pref = { face: next, epoch: pref.epoch + 1 };
  try {
    localStorage.setItem(KEY, pref.face);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentTraceFace(): TraceFacePref {
  return pref;
}

/**
 * Which face one row shows.
 *
 * @param master the master switch, epoch included
 * @param override what this row was switched to by hand, or null
 * @return the row's own face while its stamp is current, else the master's
 */
export function rowFace(master: TraceFacePref, override: RowFace | null): TraceFace {
  return override !== null && override.epoch === master.epoch ? override.face : master.face;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): TraceFacePref {
  return pref;
}

export function useTraceFace(): TraceFacePref {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
