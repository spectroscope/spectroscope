// Which face a tool card shows (card 94) — a tiny external store à la lang.ts /
// disclosure.ts, persisted to localStorage. One choice for every card: switching
// it on one card switches all of them, because it is a reading MODE, not a
// per-card state (the per-card state is open/closed).
//
//   structured — the tool rendered AS ITSELF (default)
//   json       — input/output as collapsible trees
//   raw        — the untouched JSON + text pair

import { useSyncExternalStore } from "react";

export type ToolViewMode = "structured" | "json" | "raw";

export const TOOL_VIEW_MODES: ToolViewMode[] = ["structured", "json", "raw"];

const KEY = "spectroscope:chat.toolView";

function readSaved(): ToolViewMode {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === "structured" || raw === "json" || raw === "raw") return raw;
  } catch {
    /* no localStorage (tests) — default */
  }
  return "structured";
}

let mode: ToolViewMode = readSaved();
const listeners = new Set<() => void>();

export function setToolView(next: ToolViewMode): void {
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
export function currentToolView(): ToolViewMode {
  return mode;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): ToolViewMode {
  return mode;
}

export function useToolView(): ToolViewMode {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
