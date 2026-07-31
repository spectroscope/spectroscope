// Which reading of the transcript the chat shows (branch chat-v2) — a tiny
// external store à la toolView.ts / disclosure.ts, persisted to localStorage.
//
//   v1 — the transcript as recorded: subagent turns nested inline, in stream
//        order. The daily driver, and the default.
//   v2 — the main agent's own line of thought on the left, concurrent work in
//        a panel on the right.
//
// It is a reading MODE, not a tab: the tab bar's entries are different FOLDS of
// the stream, and v2 is a different reading of one of them. Default stays v1 —
// a mode that changes what the daily driver looks like is not a default until
// the owner says it is.

import { useSyncExternalStore } from "react";

export type ChatViewMode = "v1" | "v2";

export const CHAT_VIEW_MODES: ChatViewMode[] = ["v1", "v2"];

const KEY = "spectroscope:chat.view";

function readSaved(): ChatViewMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "v1" || raw === "v2") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "v1";
}

let mode: ChatViewMode = readSaved();
const listeners = new Set<() => void>();

export function setChatView(next: ChatViewMode): void {
  if (next === mode) return;
  mode = next;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentChatView(): ChatViewMode {
  return mode;
}

/** Test-only: forget the saved choice. */
export function __resetForTests(): void {
  mode = "v1";
  listeners.clear();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): ChatViewMode {
  return mode;
}

export function useChatView(): ChatViewMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
