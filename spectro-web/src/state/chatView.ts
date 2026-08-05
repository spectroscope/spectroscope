// Which reading of the transcript the chat shows (branch chat-v2) — a tiny
// external store à la toolView.ts / disclosure.ts, persisted to localStorage.
//
//   v1 — the transcript as recorded: subagent turns nested inline, in stream
//        order.
//   v2 — the main agent's own line of thought on the left, concurrent work in
//        a panel on the right. The default since 2026-08-03.
//
// It is a reading MODE, not a tab: the tab bar's entries are different FOLDS of
// the stream, and v2 is a different reading of one of them.
//
// This comment used to say the default stays v1 until the owner says otherwise.
// They said otherwise, and gave the reason: the Work panel only exists in v2
// (App.tsx folds work there, RightPanel offers the tab only when it is present),
// so a session driving twelve agents through a workflow looked, in v1, like one
// agent making a long list of tool calls. Neither reading is merged into the
// other and v1 is one click away, because the two answer different questions.

import { useSyncExternalStore } from "react";

export type ChatViewMode = "v1" | "v2";

/**
 * Whether a render is the FLIP into v2 rather than a mount that merely finds v2
 * already chosen.
 *
 * <p>App opens the right panel on Work when a reader chooses v2, because a v2
 * reading whose right column is collapsed is v1 with the children missing. That
 * effect was keyed on the mode itself, so it also ran on mount — and v2 is the
 * default, so it ran on every start for everyone, reopening the panel on a Work
 * tab that a session with no run in it fills with "Nothing yet.". A reader who
 * closed the panel, or left it on another tab, was overruled at the next
 * launch. The previous value is the whole difference, and only the caller has
 * it, so it is passed in.</p>
 *
 * @param previous the mode the last render saw, null on the first one
 * @param next the mode this render sees
 * @return true only for a real v1 to v2 transition
 */
export function isFlipIntoV2(previous: ChatViewMode | null, next: ChatViewMode): boolean {
  return next === "v2" && previous !== null && previous !== "v2";
}

export const CHAT_VIEW_MODES: ChatViewMode[] = ["v1", "v2"];

const KEY = "spectroscope:chat.view";

function readSaved(): ChatViewMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "v1" || raw === "v2") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "v2";
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
  mode = readSaved();
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
