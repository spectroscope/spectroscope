// Panel layout for the Lab and the sidebar — a tiny external store (à la
// designPrefs/stepper) persisted to localStorage, so collapsed/width choices
// survive tab switches and reloads. Widths are in px; the resizer handles clamp
// against the live container, the store keeps a generous safety clamp.
//
// Pure-logic module: localStorage access is guarded so it also runs in the
// (DOM-less) test environment, where it simply falls back to defaults.

import { useSyncExternalStore } from "react";
import {
  closeInColumns,
  openInColumns,
  parseColumns,
  reconcileColumns,
  serializeColumns,
  setColumnPairShare,
  setColumnSplit,
} from "../panels/columnModel";
// Runtime edge layout → dockModel only: dockModel's own imports from this
// file are type-only and erase, so the order has ONE home and no cycle.
import { DOCK_ORDER } from "../panels/dockModel";

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
  /** Lab context dock width in px (card 300). */
  ctxW: number;
  /** Lab chat pane visible (collapsed by default — the stepper gets the room). */
  chatOpen: boolean;
  /** Lab JSONL pane visible (collapsed by default). */
  traceOpen: boolean;
  /** Lab context dock visible. Collapsed by default, and deliberately NOT a
   *  member of the workspace dock (panels/columnModel): this is a fourth flex
   *  child of the lab row with a resizer of its own, so a dock nobody opened
   *  costs one boolean and no store. */
  ctxOpen: boolean;
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
  /** Card 236: the workspace's column arrangement, serialized
   *  (`"agents,files~1~0.35|terminal~2~0.5"` — see panels/columnModel.ts).
   *  Columns of one or two panels, a width weight and a height split per
   *  column. The WINDOW SIZE never feeds this field — only open/close (the
   *  fill rule) and the two divider drags write it, which is what makes a
   *  resize scale the pixels without re-seating a single panel. */
  dockColumns: string;
  /** Card 242: the dock visibility the USER last chose — what entering a
   *  session returns to (applyDockReturn). A launch never reads
   *  `rightPanelOpen` from storage any more: the greeting starts clean and
   *  panels are asked for, never inherited. Only the explicit gestures write
   *  this (the header toggle, the dock's close, the header panel icons); the
   *  agent's cue (card 241) and the other programmatic opens stay transient. */
  dockReturn: boolean;
}

export const DEFAULT_LAYOUT: LayoutState = {
  sidebarW: 240,
  chatW: 340,
  traceW: 300,
  ctxW: 320,
  chatOpen: false,
  traceOpen: false,
  ctxOpen: false,
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
  // The roster alone in one column — the serialized form of the default face.
  dockColumns: "agents~1~0.5",
  dockReturn: false,
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
 * The column arrangement that agrees with the mode fields (card 236). The
 * modes own MEMBERSHIP (which panels are visible at all); the stored
 * arrangement keeps seats and ratios where it can, and panels it misses
 * hydrate through the fill rule in DOCK_ORDER — the deterministic order the
 * card asks to be named. A non-string `stored` (pre-236 blob, corrupt entry)
 * reads as an empty arrangement and everything hydrates through the fill rule.
 */
function columnsAgreeingWithModes(state: LayoutState, stored: unknown): string {
  const openIds = DOCK_ORDER.filter((id) => state[DOCK_FIELD[id]] !== "closed");
  const parsed = typeof stored === "string" ? parseColumns(stored, DOCK_ORDER) : [];
  return serializeColumns(reconcileColumns(parsed, openIds));
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
 * <p>Card 242 on top of both eras: the dock's VISIBILITY never survives a
 * launch. Measured 2026-08-15 — every pre-0.9 blob carried
 * `rightPanelOpen: true, activeRightTab: "files"`, and a 241-era session left
 * `dockBrowser: "open"` behind, so the greeting opened crowded into a window
 * whose chat was a 442px strip. The membership stays (it is the preference
 * the dock returns to), `dockReturn` remembers whether the user left the dock
 * open, and `rightPanelOpen` starts false: panels are asked for, never
 * inherited. Junk in a stored `dockReturn` heals to what the pre-242 flag
 * said rather than resetting the blob.
 *
 * @param parsed      what JSON.parse returned for the stored blob, or null
 * @param termOpenRaw the legacy terminal-open entry ("1" meant open), or null
 */
export function hydrateLayout(parsed: unknown, termOpenRaw: string | null): LayoutState {
  const blob = typeof parsed === "object" && parsed !== null ? (parsed as Partial<LayoutState>) : {};
  const state: LayoutState = { ...DEFAULT_LAYOUT, ...blob };
  // Card 242: the launch rule, same for every era (see the javadoc above).
  state.dockReturn = typeof blob.dockReturn === "boolean" ? blob.dockReturn : blob.rightPanelOpen === true;
  state.rightPanelOpen = false;
  const postCard = DOCK_FIELDS.some((f) => f in blob);
  if (postCard) {
    for (const f of DOCK_FIELDS) state[f] = normalizeMode(state[f]);
    if (typeof state.dockWeights !== "string") state.dockWeights = "";
    // Card 236: a 228-era blob has modes but no arrangement — its open panels
    // hydrate through the fill rule in DOCK_ORDER, losslessly. A 236 blob is
    // taken at its word, reconciled against the modes it arrived with.
    state.dockColumns = columnsAgreeingWithModes(state, blob.dockColumns);
    return state;
  }
  // Pre-card blob: migrate. Every panel closed, then the one that was showing.
  for (const f of DOCK_FIELDS) state[f] = "closed";
  state.dockWeights = "";
  const tab = blob.activeRightTab;
  state[DOCK_FIELD[tab !== undefined && tab in DOCK_FIELD ? tab : "agents"]] = "open";
  if (termOpenRaw === "1") state.dockTerminal = "open";
  state.dockColumns = columnsAgreeingWithModes(state, null);
  return state;
}

/** The widths a blob must carry as FINITE NUMBERS to be trusted: a stored
 *  `rightPanelW: "abc"` would ride the merge into a CSS custom property and
 *  wedge the layout on every load, with nothing left for a reload to heal. */
const WIDTH_FIELDS = ["sidebarW", "chatW", "traceW", "ctxW", "rightPanelW", "imagesW"] as const;
/** The flags a blob must carry as booleans, same argument. */
const FLAG_FIELDS = ["chatOpen", "traceOpen", "ctxOpen", "rightPanelOpen"] as const;

/**
 * Reads one stored blob, healed or replaced (card 241 recovery).
 *
 * <p>Two failure classes, answered differently. A blob card 219's migration
 * already heals per field — an unknown dock mode, a non-string weights, a
 * corrupt column arrangement — hydrates silently, exactly as shipped. A blob
 * the store cannot TRUST — unparseable JSON, not an object, a width that is
 * not a finite number, a flag that is not a boolean — resets the WHOLE layout
 * to the default and says so once (`recovered`), because merging around a
 * poisoned field would carry the poison into the next persist. Sessions are
 * never touched here: this store owns one localStorage key and nothing else.
 *
 * @param raw         what localStorage held under the layout key, or null
 * @param termOpenRaw the legacy terminal-open entry, or null
 * @return the state to run with, and whether a broken blob was replaced
 */
export function readLayoutBlob(
  raw: string | null,
  termOpenRaw: string | null,
): { state: LayoutState; recovered: boolean } {
  if (raw === null) return { state: { ...DEFAULT_LAYOUT }, recovered: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: { ...DEFAULT_LAYOUT }, recovered: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { state: { ...DEFAULT_LAYOUT }, recovered: true };
  }
  const blob = parsed as Record<string, unknown>;
  for (const field of WIDTH_FIELDS) {
    if (field in blob && !Number.isFinite(blob[field])) {
      return { state: { ...DEFAULT_LAYOUT }, recovered: true };
    }
  }
  for (const field of FLAG_FIELDS) {
    if (field in blob && typeof blob[field] !== "boolean") {
      return { state: { ...DEFAULT_LAYOUT }, recovered: true };
    }
  }
  return { state: hydrateLayout(parsed, termOpenRaw), recovered: false };
}

/** Whether THIS load replaced a broken blob — the one terse sentence's truth. */
let recoveredOnLoad = false;

function readSaved(): LayoutState {
  try {
    const raw = localStorage.getItem(KEY);
    let legacyTermOpen: string | null = null;
    try {
      legacyTermOpen = localStorage.getItem(LEGACY_TERM_OPEN_KEY);
    } catch {
      /* storage blocked mid-read — migrate without the terminal fact */
    }
    const read = readLayoutBlob(raw, legacyTermOpen);
    recoveredOnLoad = read.recovered;
    if (read.recovered) {
      // Heal the stored copy too, or the next load recovers all over again.
      try {
        localStorage.setItem(KEY, JSON.stringify(read.state));
      } catch {
        /* ignore */
      }
    }
    return read.state;
  } catch {
    /* no localStorage (tests) — fall back to defaults */
  }
  return { ...DEFAULT_LAYOUT };
}

let state: LayoutState = readSaved();
const listeners = new Set<() => void>();

/** Whether the load replaced a broken blob. Cleared by the banner's dismiss. */
export function layoutRecovered(): boolean {
  return recoveredOnLoad;
}

/** The banner's dismiss: the sentence was read, the store stays default. */
export function dismissLayoutRecovered(): void {
  if (!recoveredOnLoad) return;
  recoveredOnLoad = false;
  for (const l of listeners) l();
}

const neverRecovered = (): boolean => false;

/** The hook behind the one terse recovery sentence (card 241). */
export function useLayoutRecovered(): boolean {
  return useSyncExternalStore(subscribe, layoutRecovered, neverRecovered);
}

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
    next.ctxW === state.ctxW &&
    next.chatOpen === state.chatOpen &&
    next.traceOpen === state.traceOpen &&
    next.ctxOpen === state.ctxOpen &&
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
    next.dockWeights === state.dockWeights &&
    next.dockColumns === state.dockColumns &&
    next.dockReturn === state.dockReturn
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
/** The lab's context dock: same bounds as the JSONL strip beside it. */
export function setCtxW(w: number): void {
  set({ ctxW: clampW(w, 200, 1200) });
}
export function toggleCtx(): void {
  set({ ctxOpen: !state.ctxOpen });
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
/** The user's own show/hide (header toggle, the dock's ✕) — the ONE gesture
 *  pair that writes the return memory in both directions (card 242). */
export function toggleRightPanel(): void {
  const next = !state.rightPanelOpen;
  set({ rightPanelOpen: next, dockReturn: next });
}
/** Opens the panel if closed (idempotent) — the workspace announcement, the
 *  agent's browser cue and the v2 flip use it TRANSIENTLY: the open serves a
 *  moment, not a standing layout, so it does not return on the next session
 *  (card 242). `remember` is for the explicit asks (the header panel icons):
 *  those also write the return memory. */
export function openRightPanel(remember = false): void {
  const patch: Partial<LayoutState> = {};
  if (!state.rightPanelOpen) patch.rightPanelOpen = true;
  if (remember && !state.dockReturn) patch.dockReturn = true;
  if (patch.rightPanelOpen !== undefined || patch.dockReturn !== undefined) set(patch);
}
/** Entering a session applies the return memory: a dock the user left open in
 *  a session comes back there — never on the greeting (card 242). */
export function applyDockReturn(): void {
  if (state.rightPanelOpen !== state.dockReturn) set({ rightPanelOpen: state.dockReturn });
}
export function setActiveRightTab(tab: RightTab): void {
  set({ activeRightTab: tab });
}

/** The strip's show/hide: closed opens, anything visible closes. The column
 *  arrangement moves WITH the mode (card 236): an open seats the panel by the
 *  fill rule, a close frees its seat and collapses an emptied column. */
export function toggleDockPanel(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  const closing = state[field] !== "closed";
  const cols = parseColumns(state.dockColumns, DOCK_ORDER);
  set({
    [field]: closing ? "closed" : "open",
    dockColumns: serializeColumns(closing ? closeInColumns(cols, id) : openInColumns(cols, id)),
  });
}

/** The header chevron: folds an open panel to its header and back. A closed
 *  panel stays closed — folding is not a way to open. */
export function toggleDockCollapse(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  if (state[field] === "closed") return;
  set({ [field]: state[field] === "open" ? "collapsed" : "open" });
}

/** Opens (and unfolds) a panel, idempotently — the workspace announcement,
 *  the roster's agent pick and the chat's work chip land here. Seating is
 *  idempotent too: unfolding a collapsed panel finds it already seated and
 *  the arrangement string comes back byte-identical. */
export function openDockPanel(id: DockPanelId): void {
  const field = DOCK_FIELD[id];
  if (state[field] === "open") return;
  set({
    [field]: "open",
    dockColumns: serializeColumns(openInColumns(parseColumns(state.dockColumns, DOCK_ORDER), id)),
  });
}

/** Stores the serialized panel weights. Card 228's grid reads no weights any
 *  more — the field and this setter stay for blob compatibility in both
 *  directions: a pre-grid build loading a post-grid blob still finds the
 *  field it expects, and a stored weights string survives a round trip. */
export function setDockWeights(serialized: string): void {
  set({ dockWeights: serialized });
}

/** The in-column divider drag (card 236): one column's height split. Junk
 *  indices and non-finite ratios change nothing — the model returns the same
 *  array and no state is written. */
export function setDockColumnSplit(index: number, split: number): void {
  const cols = parseColumns(state.dockColumns, DOCK_ORDER);
  const next = setColumnSplit(cols, index, split);
  if (next === cols) return;
  set({ dockColumns: serializeColumns(next) });
}

/** The column divider drag (card 236): re-cuts the width weights of columns
 *  `leftIndex` and `leftIndex + 1`, conserving their sum — every other
 *  column keeps its width exactly. */
export function setDockColumnShare(leftIndex: number, leftShare: number): void {
  const cols = parseColumns(state.dockColumns, DOCK_ORDER);
  const next = setColumnPairShare(cols, leftIndex, leftShare);
  if (next === cols) return;
  set({ dockColumns: serializeColumns(next) });
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
