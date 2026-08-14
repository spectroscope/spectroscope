// The browser action cue (card 226): how the live browser view learns that an
// AGENT drove the browser.
//
// The web face's screencast follows the page the viewer subscribed to; an
// agent-driven navigation mid-watch does not restart the cast by itself — a
// core-half disclosure, written in docs/BROWSER.md ("re-issuing watch restarts
// the cast on the new page"). The announcement the UI already receives is the
// session's own browser_action RunEvents on the main socket, so this store
// counts them and BrowserSegment re-issues `watch` when the count moves.
//
// The count carries NO payload on purpose. The state frame the re-watch
// answers with is the truth about the page; a cue that carried a URL would be
// a second copy of that truth, and second copies drift. The main socket is the
// live session's own stream, so a count here is by construction about the
// session the segment shows when it is live.
//
// Store shape is the house pattern (liveSessions.ts, browserLog.ts): a
// module-level value, a listener set, useSyncExternalStore with the same
// snapshot for server rendering.

import { useSyncExternalStore } from "react";
import type { RunEvent } from "../events";

let count = 0;
const listeners = new Set<() => void>();

/**
 * Counts the browser_action events of one live batch. Called from the app's
 * one event funnel, beside the other live stores.
 *
 * @param batch the animation-frame batch the socket delivered
 */
export function browserCuePushLive(batch: RunEvent[]): void {
  const moved = batch.filter((e) => (e as { type?: string }).type === "browser_action").length;
  if (moved === 0) return;
  count += moved;
  for (const listener of listeners) listener();
}

/** @return how many browser_action events this page has seen — the cue value */
export function browserCueCount(): number {
  return count;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The hook the segment watches; a moving number is the whole message. */
export function useBrowserActionCue(): number {
  return useSyncExternalStore(subscribe, browserCueCount, browserCueCount);
}
