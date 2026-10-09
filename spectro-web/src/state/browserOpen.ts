// Card 472: the "Graph ready" chip asking the internal browser of a session
// to open that session's code graph.
//
// The browser segment owns the view socket that carries the open_code_graph
// frame, and it may not be mounted at the moment someone asks (the panel opens
// with the ask). So the ask waits here, keyed by the session whose browser it
// is for, and the segment of that session takes it once: when its socket
// opens, or at once when the socket is already open and the sequence below
// moves.
//
// The ask carries no address. The server mints a one-shot ticket for the
// press, builds the address on its own port and navigates like an operator's
// typed address, so the fence judges it; no agent verb can mint that ticket.
//
// Store shape is the house pattern (browserCue.ts): a module-level value, a
// listener set, useSyncExternalStore with the same snapshot for server rendering.

import { useSyncExternalStore } from "react";

let pending: string | null = null;
let seq = 0;
const listeners = new Set<() => void>();

/**
 * Asks the internal browser of a session to open its code graph. A later ask
 * replaces an earlier one that nobody took.
 */
export function requestCodeGraphOpen(sessionId: string): void {
  pending = sessionId;
  seq += 1;
  for (const listener of listeners) listener();
}

/**
 * Takes the waiting ask of a session, once.
 *
 * @returns whether an ask waited for this session
 */
export function takeCodeGraphOpen(sessionId: string): boolean {
  if (pending === null || pending !== sessionId) return false;
  pending = null;
  return true;
}

/** @returns how many asks this page has made; a moving number is the signal */
export function browserOpenSeq(): number {
  return seq;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The hook the segment watches. */
export function useBrowserOpenRequest(): number {
  return useSyncExternalStore(subscribe, browserOpenSeq, browserOpenSeq);
}
