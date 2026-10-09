// Card 472: what the header, the menus and the sheet know about the code
// graph. One store, because three places read it (the header line and chip,
// the ⋮ menu row and the folder chip row, the sheet) and one place writes it
// (CodeGraphHost, which polls the server). House store pattern: a
// module-level value, a listener set, useSyncExternalStore.

import { useSyncExternalStore } from "react";
import type { CodeGraphStatus } from "./codeGraphModel";

export interface CodeGraphState {
  /** The session the status belongs to, or null for the installation alone. */
  sessionId: string | null;
  status: CodeGraphStatus | null;
  /** Which sheet is open: the build sheet, the failure lines, or none. */
  sheet: "build" | "failure" | null;
  /** Moves when someone asks for a fresh status (after a start). */
  refresh: number;
}

const INITIAL: CodeGraphState = { sessionId: null, status: null, sheet: null, refresh: 0 };

let state: CodeGraphState = INITIAL;
const listeners = new Set<() => void>();

function set(next: CodeGraphState): void {
  state = next;
  for (const listener of listeners) listener();
}

/** @returns the current state */
export function codeGraphState(): CodeGraphState {
  return state;
}

/** Records the server's latest answer for a session (or for none). */
export function setCodeGraphStatus(sessionId: string | null, status: CodeGraphStatus | null): void {
  set({ ...state, sessionId, status });
}

/** Opens the build sheet ("Build code graph") or the failure lines. */
export function openCodeGraphSheet(sheet: "build" | "failure" = "build"): void {
  set({ ...state, sheet, refresh: state.refresh + 1 });
}

/** Closes whichever sheet is open. */
export function closeCodeGraphSheet(): void {
  set({ ...state, sheet: null });
}

/** Asks the host for a fresh status now, rather than at the next poll. */
export function refreshCodeGraph(): void {
  set({ ...state, refresh: state.refresh + 1 });
}

/** Back to nothing known. Tests only. */
export function resetCodeGraphForTest(): void {
  set(INITIAL);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The hook every reader uses. */
export function useCodeGraph(): CodeGraphState {
  return useSyncExternalStore(subscribe, codeGraphState, codeGraphState);
}
