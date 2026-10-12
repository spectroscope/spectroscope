// Card 472: what the header, the menus and the sheet know about the code
// graph. One store, because three places read it (the header line and chip,
// the ⋮ menu row and the folder chip row, the sheet) and one place writes it
// (CodeGraphHost, which polls the server). House store pattern: a
// module-level value, a listener set, useSyncExternalStore.

import { useSyncExternalStore } from "react";
import { fetchCodeGraphStatus, type CodeGraphStatus } from "./codeGraphModel";

export interface CodeGraphState {
  /** The session the status belongs to, or null for the installation alone. */
  sessionId: string | null;
  status: CodeGraphStatus | null;
  /** Which sheet is open: the build sheet, the failure lines, or none. */
  sheet: "build" | "failure" | null;
  /** The mode a menu row asked the build sheet to start on, or null to follow the status. */
  sheetMode: "full" | "update" | null;
  /** Moves when someone asks for a fresh status (after a start). */
  refresh: number;
}

const INITIAL: CodeGraphState = { sessionId: null, status: null, sheet: null, sheetMode: null, refresh: 0 };

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

/**
 * The host's session changed: the previous session's status goes at once, so
 * until the new answer lands the rows read Build and Show cannot open the
 * previous session's graph (card 546). The same session keeps its status.
 */
export function followCodeGraphSession(sessionId: string | null): void {
  if (state.sessionId === sessionId) return;
  set({ ...state, sessionId, status: null });
}

/**
 * What the host does when its session changes or a refresh is asked for:
 * follow the session at once, then ask the server and record the answer
 * while the effect that asked is still alive (card 546).
 *
 * @param alive false once the effect that asked has been cleaned up
 */
export async function loadCodeGraphSession(
  sessionId: string | null,
  alive: () => boolean,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  followCodeGraphSession(sessionId);
  const next = await fetchCodeGraphStatus(sessionId, fetchFn);
  if (alive()) setCodeGraphStatus(sessionId, next);
}

/**
 * Opens the build sheet or the failure lines.
 *
 * @param mode the mode the build sheet starts on (card 546: the Update row asks
 *   for update, the Build row for full); left out, the sheet follows the status
 */
export function openCodeGraphSheet(sheet: "build" | "failure" = "build", mode?: "full" | "update"): void {
  set({ ...state, sheet, sheetMode: mode ?? null, refresh: state.refresh + 1 });
}

/**
 * Closes whichever sheet is open. The mode stays: it is read only while a
 * sheet is open, and every opening sets it.
 */
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
