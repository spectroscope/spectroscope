// Panel layout for the Lab and the sidebar — a tiny external store (à la
// designPrefs/stepper) persisted to localStorage, so collapsed/width choices
// survive tab switches and reloads. Widths are in px; the resizer handles clamp
// against the live container, the store keeps a generous safety clamp.
//
// Pure-logic module: localStorage access is guarded so it also runs in the
// (DOM-less) test environment, where it simply falls back to defaults.

import { useSyncExternalStore } from "react";

/** Which tab the Chat tab's right-docked panel shows — the Claude-Code
 *  right-sidebar pattern. "files" is the Phase 5 workspace panel; "work" is the
 *  chat-v2 prototype's concurrent-work panel, and is additive: DEFAULT_LAYOUT
 *  still opens on "agents", so a v1 reader never lands on it.
 *
 *  Since card 219 the right panel is a DOCK of independent panels and this
 *  type only survives for two reasons: a pre-card blob carries it (the
 *  migration in hydrateLayout reads it), and a post-card blob loaded by an
 *  older build still finds the field it expects. */
export type RightTab = "agents" | "context" | "plan" | "files" | "work";

/** The dock's panels (card 219, first cut): every former right-panel tab as a
 *  panel of its own, plus the terminal (promoted out of the Files surface) and
 *  the browser (the owner's ask: in the same workspace as the others). */
export type DockPanelId = "work" | "agents" | "plan" | "context" | "files" | "terminal" | "browser";

/** One panel's state. `collapsed` means folded to its header but MOUNTED —
 *  that is the display:none idiom of card 175, and for the terminal it is the
 *  difference between a folded shell and a killed one. */
export type DockPanelMode = "open" | "collapsed" | "closed";

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
  /** Image gallery panel width in px (resizable like the workspace panes). */
  imagesW: number;
  /** Which tab the right panel shows. Unwritten since card 219 (see RightTab). */
  activeRightTab: RightTab;
  /** Card 219: one mode per dock panel. Scalar fields rather than one object,
   *  because set() below compares field by field — an object would need a
   *  deep-equal there, and the store's whole idiom is "compare by hand". */
  dockWork: DockPanelMode;
  dockAgents: DockPanelMode;
  dockPlan: DockPanelMode;
  dockContext: DockPanelMode;
  dockFiles: DockPanelMode;
  dockTerminal: DockPanelMode;
  dockBrowser: DockPanelMode;
  /** The panels' height weights, serialized (`"files:2,terminal:0.5"`) — one
   *  string field keeps the equality check one line. Parsing and clamping live
   *  in panels/dockModel.ts. */
  dockWeights: string;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarW: 240,
  chatW: 340,
  traceW: 300,
  chatOpen: false,
  traceOpen: false,
  rightPanelOpen: false,
  // Card 228: the workspace is a grid of cards, and 620px is what opens it on
  // two columns (the grid's column minimum is 240px). The stylesheet caps the
  // width against the row (min(…, 60%)), so a narrow window is never overrun.
  rightPanelW: 620,
  imagesW: 300,
  activeRightTab: "agents",
  // The dock opens on the roster alone — byte for byte the face the tabbed
  // panel showed a reader who never touched it.
  dockWork: "closed",
  dockAgents: "open",
  dockPlan: "closed",
  dockContext: "closed",
  dockFiles: "closed",
  dockTerminal: "closed",
  dockBrowser: "closed",
  dockWeights: "",
};

const KEY = "spectroscope:layout";

/** The pre-card-219 terminal toggle's own storage key (card 93; its module,
 *  workspace/shellPrefs.ts, left with the toggle). Read once by the migration
 *  below so a reader who had the terminal open keeps it. */
const LEGACY_TERM_OPEN_KEY = "spectroscope:wsTerminalOpen";

/** Generous safety bounds; the resizer additionally clamps against the container. */
export function clampW(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(w)));
}

const DOCK_FIELDS = [
  "dockWork",
  "dockAgents",
  "dockPlan",
  "dockContext",
  "dockFiles",
  "dockTerminal",
  "dockBrowser",
] as const;

/** The store key for one dock panel's mode. Every RightTab is also a
 *  DockPanelId, which is what lets the migration reuse this map. */
const DOCK_FIELD: Record<DockPanelId, (typeof DOCK_FIELDS)[number]> = {
  work: "dockWork",
  agents: "dockAgents",
  plan: "dockPlan",
  context: "dockContext",
  files: "dockFiles",
  terminal: "dockTerminal",
  browser: "dockBrowser",
};

function normalizeMode(v: unknown): DockPanelMode {
  return v === "open" || v === "collapsed" || v === "closed" ? v : "closed";
}

/**
 * A stored blob, made whole. Pure so the migration is testable without
 * touching the module's storage read.
 *
 * <p>Two eras meet here. A blob with any dock field is post-card-219 and is
 * taken at its word (junk modes read as closed — a corrupt entry opens
 * nothing). A blob without one is pre-card: the reader had ONE visible tab, so
 * exactly that tab's panel opens, and the old terminal toggle (its own
 * localStorage key, card 93) reopens the terminal panel. That reproduces the
 * face they had rather than defaulting them onto the roster.
 *
 * @param parsed      what JSON.parse returned for the stored blob, or null
 * @param termOpenRaw the legacy terminal-open entry ("1" meant open), or null
 */
export function hydrateLayout(parsed: unknown, termOpenRaw: string | null): LayoutState {
  const blob = typeof parsed === "object" && parsed !== null ? (parsed as Partial<LayoutState>) : {};
  const state: LayoutState = { ...DEFAULT_LAYOUT, ...blob };
  const postCard = DOCK_FIELDS.some((f) => f in blob);
  if (postCard) {
    for (const f of DOCK_FIELDS) state[f] = normalizeMode(state[f]);
    if (typeof state.dockWeights !== "string") state.dockWeights = "";
    return state;
  }
  // Pre-card blob: migrate. Every panel closed, then the one that was showing.
  for (const f of DOCK_FIELDS) state[f] = "closed";
  state.dockWeights = "";
  const tab = blob.activeRightTab;
  state[DOCK_FIELD[tab !== undefined && tab in DOCK_FIELD ? tab : "agents"]] = "open";
  if (termOpenRaw === "1") state.dockTerminal = "open";
  return state;
}

function readSaved(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    let legacyTermOpen: string | null = null;
    try {
      legacyTermOpen = localStorage.getItem(LEGACY_TERM_OPEN_KEY);
    } catch {
      /* storage blocked mid-read — migrate without the terminal fact */
    }
    if (raw) return hydrateLayout(JSON.parse(raw), legacyTermOpen);
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
    next.sidebarW === state.sidebarW &&
    next.chatW === state.chatW &&
    next.traceW === state.traceW &&
    next.chatOpen === state.chatOpen &&
    next.traceOpen === state.traceOpen &&
    next.rightPanelOpen === state.rightPanelOpen &&
    next.rightPanelW === state.rightPanelW &&
    next.imagesW === state.imagesW &&
    next.activeRightTab === state.activeRightTab &&
    // Card 219: a field added to LayoutState and NOT to this list is stored
    // and never notifies anybody — the trap the card's spec names out loud.
    next.dockWork === state.dockWork &&
    next.dockAgents === state.dockAgents &&
    next.dockPlan === state.dockPlan &&
    next.dockContext === state.dockContext &&
    next.dockFiles === state.dockFiles &&
    next.dockTerminal === state.dockTerminal &&
    next.dockBrowser === state.dockBrowser &&
    next.dockWeights === state.dockWeights
  ) {
    return; // no change — no emit
  }
  state = next;
  persist();
  for (const l of listeners) l();
}

export function setSidebarW(w: number): void {
  set({ sidebarW: clampW(w, 180, 560) });
}
export function setChatW(w: number): void {
  set({ chatW: clampW(w, 200, 1200) });
}
export function setTraceW(w: number): void {
  set({ traceW: clampW(w, 200, 1200) });
}
export function toggleChat(): void {
  set({ chatOpen: !state.chatOpen });
}
export function toggleTrace(): void {
  set({ traceOpen: !state.traceOpen });
}
export function setRightPanelW(w: number): void {
  // The ceiling went 720 → 1200 with the grid (card 228): three 240px columns
  // plus gaps never fit under the old cap, so the third column was
  // unreachable by construction. The live clamp against the chat's reserve
  // stays in App's resize handler.
  set({ rightPanelW: clampW(w, 260, 1200) });
}
// The image gallery holds generated images the user wants to actually SEE, so
// its width goes as wide as the chat can spare (the resize handler already
// reserves CHAT_RESERVED_MIN_WIDTH_PX for the chat) — a 1200px ceiling like the
// chat pane, not the old 720 that capped image viewing well below the viewport.
export function setImagesW(w: number): void {
  set({ imagesW: clampW(w, 240, 1200) });
}
export function toggleRightPanel(): void {
  set({ rightPanelOpen: !state.rightPanelOpen });
}
/** Opens the panel if closed (idempotent) — the workspace announcement uses it. */
export function openRightPanel(): void {
  if (!state.rightPanelOpen) set({ rightPanelOpen: true });
}
export function setActiveRightTab(tab: RightTab): void {
  set({ activeRightTab: tab });
}

/** The strip's show/hide: closed opens, anything visible closes. */
export function toggleDockPanel(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  set({ [field]: state[field] === "closed" ? "open" : "closed" });
}

/** The header chevron: folds an open panel to its header and back. A closed
 *  panel stays closed — folding is not a way to open. */
export function toggleDockCollapse(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  if (state[field] === "closed") return;
  set({ [field]: state[field] === "open" ? "collapsed" : "open" });
}

/** Opens (and unfolds) a panel, idempotently — the workspace announcement,
 *  the roster's agent pick and the chat's work chip land here. */
export function openDockPanel(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  if (state[field] !== "open") set({ [field]: "open" });
}

/** Stores the serialized panel weights. Card 228's grid reads no weights any
 *  more — the field and this setter stay for blob compatibility in both
 *  directions: a pre-grid build loading a post-grid blob still finds the
 *  field it expects, and a stored weights string survives a round trip. */
export function setDockWeights(serialized: string): void {
  set({ dockWeights: serialized });
}

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
