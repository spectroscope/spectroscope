// Card 586: the run the operator picked, one pick for the compact run panel and
// the wide view, so going wide or small keeps the run on screen.
//
// A pick holds the index, the number of runs at the time and the id of the
// session's first run. It applies while the runs it was made on are shown: a
// new run makes the count differ, and the view follows the new run; another
// session's runs start with another first run, and show their newest.

import { useSyncExternalStore } from "react";
import type { RunTrack } from "./runView";

export interface RunPick {
  first: string;
  index: number;
  count: number;
}

let current: RunPick | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const snapshot = (): RunPick | null => current;

/**
 * The shown run of `runs`: the picked one while the pick applies, else the newest.
 *
 * @param pick the pick, or null without one
 * @param runs the runs of the session, oldest first
 */
export function pickedIndex(pick: RunPick | null, runs: RunTrack[]): number {
  if (pick !== null && runs.length > 0 && pick.first === runs[0].runId && pick.count === runs.length) {
    if (pick.index < runs.length) return pick.index;
  }
  return runs.length - 1;
}

/** The pick, or null without one. */
export function currentRunPick(): RunPick | null {
  return current;
}

/**
 * Picks the run at `index` of `runs`.
 *
 * @param runs the runs of the session, oldest first
 * @param index the run to show
 */
export function pickRun(runs: RunTrack[], index: number): void {
  if (runs.length === 0) return;
  current = { first: runs[0].runId, index, count: runs.length };
  for (const listener of listeners) listener();
}

/**
 * Picks the run with `runId`; a run id the session does not hold picks nothing.
 *
 * @param runs the runs of the session, oldest first
 * @param runId the run to show
 */
export function pickRunById(runs: RunTrack[], runId: string): void {
  const index = runs.findIndex((r) => r.runId === runId);
  if (index >= 0) pickRun(runs, index);
}

/**
 * The shown run as an index, and the pick. Shared by every view that calls it.
 *
 * @param runs the runs of the session, oldest first
 */
export function useRunPick(runs: RunTrack[]): [number, (index: number) => void] {
  const pick = useSyncExternalStore(subscribe, snapshot, snapshot);
  return [pickedIndex(pick, runs), (index: number) => pickRun(runs, index)];
}

/** Test-only. */
export function __resetRunPickForTests(): void {
  current = null;
}
