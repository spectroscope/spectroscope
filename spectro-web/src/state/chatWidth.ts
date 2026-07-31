// How wide the chat's text column runs (owner 2026-07-25) — a tiny external
// store à la lang.ts / disclosure.ts, persisted, and offered in the same
// three-dots menu as the disclosure level.
//
//   normal — the reading width the app always had (--content-max, 860px)
//   wide   — 30% more room as the MAXIMUM (--content-max-wide, 1118px)
//
// The setting only raises the CAP; a narrow window still wins, because the
// column is max-width, never a fixed width.

import { useSyncExternalStore } from "react";

export type ChatWidth = "normal" | "wide";

export const CHAT_WIDTHS: ChatWidth[] = ["normal", "wide"];

const KEY = "spectroscope:chat.width";

function readSaved(): ChatWidth {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "normal" || raw === "wide") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "normal";
}

let width: ChatWidth = readSaved();
const listeners = new Set<() => void>();

export function setChatWidth(next: ChatWidth): void {
  if (next === width) return;
  width = next;
  try {
    localStorage.setItem(KEY, width);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentChatWidth(): ChatWidth {
  return width;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): ChatWidth {
  return width;
}

export function useChatWidth(): ChatWidth {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
