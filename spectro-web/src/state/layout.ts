// Panel layout for the Lab and the sidebar — a tiny external store (à la
// designPrefs/stepper) persisted to localStorage, so collapsed/width choices
// survive tab switches and reloads. Widths are in px; the resizer handles clamp
// against the live container, the store keeps a generous safety clamp.
//
// Pure-logic module: localStorage access is guarded so it also runs in the
// (DOM-less) test environment, where it simply falls back to defaults.

import { useSyncExternalStore } from "react";

/** Which tab the Chat tab's right-docked panel shows — the Claude-Code
 *  right-sidebar pattern. "files" is the Phase 5 workspace panel. */
export type RightTab = "agents" | "context" | "plan" | "files";

export interface LayoutState {
  /** Sidebar (chat history) width in px. */
  sidebarW: number;
  /** Lab chat pane width in px. */
  chatW: number;
  /** Lab JSONL pane width in px. */
  traceW: number;
  /** Lab chat pane visible (collapsed by default — the stepper gets the room). */
  chatOpen: boolean;
  /** Lab JSONL pane visible (collapsed by default). */
  traceOpen: boolean;
  /** Chat tab's right-docked panel visible. */
  rightPanelOpen: boolean;
  /** Chat tab's right panel width in px. */
  rightPanelW: number;
  /** Which tab the right panel shows. */
  activeRightTab: RightTab;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarW: 240,
  chatW: 340,
  traceW: 300,
  chatOpen: false,
  traceOpen: false,
  rightPanelOpen: false,
  rightPanelW: 360,
  activeRightTab: "agents",
};

const KEY = "spectroscope:layout";

/** Generous safety bounds; the resizer additionally clamps against the container. */
export function clampW(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(w)));
}

function readSaved(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LayoutState>;
      return { ...DEFAULT_LAYOUT, ...parsed };
    }
  } catch {
    /* no localStorage (tests) or bad JSON — fall back to defaults */
  }
  return { ...DEFAULT_LAYOUT };
}

let state: LayoutState = readSaved();
const listeners = new Set<() => void>();

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

function set(patch: Partial<LayoutState>): void {
  const next = { ...state, ...patch };
  if (
    next.sidebarW === state.sidebarW && next.chatW === state.chatW && next.traceW === state.traceW &&
    next.chatOpen === state.chatOpen && next.traceOpen === state.traceOpen &&
    next.rightPanelOpen === state.rightPanelOpen && next.rightPanelW === state.rightPanelW &&
    next.activeRightTab === state.activeRightTab
  ) {
    return; // no change — no emit
  }
  state = next;
  persist();
  for (const l of listeners) l();
}

export function setSidebarW(w: number): void { set({ sidebarW: clampW(w, 180, 560) }); }
export function setChatW(w: number): void { set({ chatW: clampW(w, 200, 1200) }); }
export function setTraceW(w: number): void { set({ traceW: clampW(w, 200, 1200) }); }
export function toggleChat(): void { set({ chatOpen: !state.chatOpen }); }
export function toggleTrace(): void { set({ traceOpen: !state.traceOpen }); }
export function setRightPanelW(w: number): void { set({ rightPanelW: clampW(w, 260, 720) }); }
export function toggleRightPanel(): void { set({ rightPanelOpen: !state.rightPanelOpen }); }
/** Opens the panel if closed (idempotent) — the workspace announcement uses it. */
export function openRightPanel(): void { if (!state.rightPanelOpen) set({ rightPanelOpen: true }); }
export function setActiveRightTab(tab: RightTab): void { set({ activeRightTab: tab }); }

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): LayoutState {
  return state;
}

export function useLayout(): LayoutState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only. */
export function __getState(): LayoutState {
  return state;
}
export function __resetForTests(): void {
  state = { ...DEFAULT_LAYOUT };
  listeners.clear();
}
