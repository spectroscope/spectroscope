// Card 586: a request from the run view to show one place in the chat.
//
// A press on a run's card asks for the prompt a chat step sent (its user turn
// carries data-run-entry) or for a child step's helper (its thread head in v1,
// its chip in v2, carry data-agent-thread). The Chat reads the request, scrolls
// the place into view and marks it. Every request has its own seq, so the same
// place pressed twice jumps twice. The request stays after it was shown, so a
// chat claims it once (claimChatFocus): a chat that mounts again later, when
// the operator comes back to the chat tab, does not jump to it again.

import { useSyncExternalStore } from "react";

export type ChatFocusTarget = { kind: "entry"; key: string } | { kind: "agent"; agentId: string };
export type ChatFocusRequest = { target: ChatFocusTarget; seq: number };

let current: ChatFocusRequest | null = null;
let seq = 0;
let claimed = 0;
const listeners = new Set<() => void>();

/** Asks the chat to show `target`. */
export function requestChatFocus(target: ChatFocusTarget): void {
  seq += 1;
  current = { target, seq };
  for (const listener of listeners) listener();
}

/** The latest request, or null before the first. */
export function currentChatFocus(): ChatFocusRequest | null {
  return current;
}

/** Calls `listener` after every request; returns the unsubscribe. */
export function subscribeChatFocus(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * True once for each request: the chat that claims it shows the place.
 *
 * @param requestSeq the seq of the request the chat read
 */
export function claimChatFocus(requestSeq: number): boolean {
  if (requestSeq <= claimed) return false;
  claimed = requestSeq;
  return true;
}

/** The latest request, read again on every new one. */
export function useChatFocus(): ChatFocusRequest | null {
  return useSyncExternalStore(subscribeChatFocus, currentChatFocus, () => null);
}

/** Test-only. */
export function __resetChatFocusForTests(): void {
  current = null;
  seq = 0;
  claimed = 0;
}
