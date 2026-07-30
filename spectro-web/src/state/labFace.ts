// Which face the lab's tool-call panel shows (card 120) — the lab twin of
// traceFace.ts, built on the shared mechanism in faceStore.ts but with its OWN
// two-value vocabulary, default and key: the lab teaches the JSONL first, so
// the insight tree leads and the structured face stays one click away.
//
//   insight    — the collapsible tree (what the panel always showed)
//   structured — the tool rendered as the thing it is
//
// Trace parity by owner decision (2026-07-30): the master ALSO re-faces
// already-open panels; a per-panel choice made afterwards wins until the next
// master change retires it (the epoch mechanism, see faceStore.ts). The value
// spaces stay separate on purpose — "raw"/"compact" are the trace's words,
// "json" the chat's, and none of them may leak in here through storage.

import { createFaceStore, overrideFace, useFaceStore, type FaceOverride, type FacePref } from "./faceStore";

/** Insight leads — the JSONL-first default; see the header. */
export const LAB_FACES = ["insight", "structured"] as const;

export type LabFace = (typeof LAB_FACES)[number];

export const DEFAULT_LAB_FACE: LabFace = "insight";

/** The master switch as the panels read it. */
export type LabFacePref = FacePref<LabFace>;

/** What one panel was switched to by hand, and under which master. */
export type PanelFace = FaceOverride<LabFace>;

const store = createFaceStore<LabFace>("spectroscope:lab.toolFace", LAB_FACES, DEFAULT_LAB_FACE);

/** Visible for tests: the stored master, or the default for anything else. */
export function parseLabFace(raw: string | null): LabFace {
  return store.parse(raw);
}

export function setLabFace(next: LabFace): void {
  store.set(next);
}

/** Visible for tests. */
export function currentLabFace(): LabFacePref {
  return store.current();
}

/**
 * Which face one panel shows.
 *
 * @param master the master switch, epoch included
 * @param override what this panel was switched to by hand, or null
 * @return the panel's own face while its stamp is current, else the master's
 */
export function panelFace(master: LabFacePref, override: PanelFace | null): LabFace {
  return overrideFace(master, override);
}

export function useLabFace(): LabFacePref {
  return useFaceStore(store);
}
