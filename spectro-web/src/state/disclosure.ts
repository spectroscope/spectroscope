// The chat's disclosure level (card 78 #4) — a tiny external store à la
// lang.ts, persisted to localStorage. It decides how message cards open
// their disclosures BY DEFAULT; a card's own click still wins (the manual
// override lives in the component). Orthogonal to the header "Thinking"
// wire toggle: that one decides whether reasoning STREAMS at all, this one
// only how an existing block presents itself.
//
//   normal    — everything collapsed (the pre-card-78 behavior).
//   extended  — thinking blocks AND tool cards open by default.
//   thinking  — only thinking blocks open (the reasoning-model view).

import { useSyncExternalStore } from "react";

export type DisclosureLevel = "normal" | "extended" | "thinking";

export const DISCLOSURE_LEVELS: DisclosureLevel[] = ["normal", "extended", "thinking"];

const KEY = "spectroscope:chat.disclosure";

function readSaved(): DisclosureLevel {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "normal" || raw === "extended" || raw === "thinking") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "normal";
}

let level: DisclosureLevel = readSaved();
const listeners = new Set<() => void>();

export function setDisclosure(next: DisclosureLevel): void {
  if (next === level) return;
  level = next;
  try {
    localStorage.setItem(KEY, level);
  } catch {
    /* ignore */
  }
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentDisclosure(): DisclosureLevel {
  return level;
}

/** The pure matrix the cards read: is this disclosure kind open by default? */
export function defaultOpen(at: DisclosureLevel, kind: "thinking" | "tool"): boolean {
  if (at === "extended") return true;
  return at === "thinking" && kind === "thinking";
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): DisclosureLevel {
  return level;
}

export function useDisclosure(): DisclosureLevel {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
