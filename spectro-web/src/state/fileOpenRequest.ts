// Card 586: a request from the run view to open one file in the Files panel.
//
// A path under a dot folder comes with the url of the run's document route
// (/api/run-document), because /api/file refuses those; any other path opens
// through /api/file. The Files panel may mount after the request (App opens
// the dock in the same press), so a request stays until one panel takes it,
// and a panel that mounts again later does not open it a second time. A
// request names the session whose Files panel it was made for: another
// session's panel drops it, so it never opens in the wrong folder.

import { useSyncExternalStore } from "react";

export type FileOpenRequest = { path: string; url?: string; session: string | null; seq: number };

let current: FileOpenRequest | null = null;
let seq = 0;
let claimed = 0;
const listeners = new Set<() => void>();

/**
 * Asks the Files panel to open `path`, read from `url` when given.
 *
 * @param session the session whose Files panel opens it, null without one
 */
export function requestOpenFile(path: string, url?: string, session: string | null = null): void {
  seq += 1;
  current = url === undefined ? { path, session, seq } : { path, url, session, seq };
  for (const listener of listeners) listener();
}

/** The latest request, or null before the first. */
export function currentFileOpenRequest(): FileOpenRequest | null {
  return current;
}

/** Calls `listener` after every request; returns the unsubscribe. */
export function subscribeFileOpenRequest(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True once for each request, for the panel of the request's session: that
 * panel opens the file. A panel of another session drops the request, and it
 * opens nowhere afterwards.
 *
 * @param requestSeq the seq of the request the panel read
 * @param session    the session of the panel, null without one
 */
export function takeFileOpenRequest(requestSeq: number, session: string | null): boolean {
  if (requestSeq <= claimed) return false;
  claimed = requestSeq;
  return current !== null && current.seq === requestSeq && current.session === session;
}

/** The latest request, read again on every new one. */
export function useFileOpenRequest(): FileOpenRequest | null {
  return useSyncExternalStore(subscribeFileOpenRequest, currentFileOpenRequest, () => null);
}

/** Test-only. */
export function __resetFileOpenRequestForTests(): void {
  current = null;
  seq = 0;
  claimed = 0;
}
