// Card 246: whether the LIVE stream keeps its trace rows in memory. The owner
// asked for the off position by name ("das spart speicher"): every live frame
// otherwise folds into state.trace with its whole payload retained, and a long
// code-producing run pays for a pane nobody is reading. OFF stops the client
// retention only — the JSONL session file and the OTLP export are written
// server-side from the same events and never pass through here. Replays and
// imports are finite and stay complete; the switch governs the live seam alone.
//
// Same injectable-storage idiom as density.ts, because this suite runs in
// plain Node and a store that cannot be tested is a store that drifts.

import { useSyncExternalStore } from "react";

export const LIVE_TRACE_KEY = "spectroscope:trace.live";
/** The one stored value with a meaning; anything else (or nothing) means ON. */
const OFF = "off";

interface Hooks {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

const browserHooks: Hooks = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private mode etc. — the session keeps the choice, the next one won't */
    }
  },
};

let hooks: Hooks = browserHooks;

/** Test seam: swap the storage. */
export function __setTestHooks(next: Hooks): void {
  hooks = next;
}

/** Test seam: re-read storage the way a page load does. */
export function __resetForTests(): void {
  wanted = readLiveTraceWanted();
}

/** True unless the stored value says "off" — absent means today's behaviour. */
export function readLiveTraceWanted(): boolean {
  return hooks.get(LIVE_TRACE_KEY) !== OFF;
}

let wanted = readLiveTraceWanted();
const listeners = new Set<() => void>();

export function setLiveTraceWanted(next: boolean): void {
  if (next === wanted) return;
  wanted = next;
  hooks.set(LIVE_TRACE_KEY, next ? "on" : OFF);
  for (const l of listeners) l();
}

/** Visible for tests and for the imperative seams in App.tsx. */
export function currentLiveTraceWanted(): boolean {
  return wanted;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): boolean {
  return wanted;
}

export function useLiveTraceWanted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
