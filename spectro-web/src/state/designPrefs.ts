// Design switcher preferences — a tiny external store (à la useSyncExternalStore)
// with TWO layers: `saved` (persisted to localStorage) and `draft` (in memory).
// The LIVE/applied look is always the draft, so panel changes preview instantly;
// save() commits the draft, revert() throws it away and restores the saved look.
//
// Applying a design = one attribute + two classes on <html>. Because spectro-web
// is 100% var(--token)-based, [data-design="x"] in designs.css reskins the whole
// UI with no reload. The same three lines run in the index.html FOUC guard.

import { useSyncExternalStore } from "react";

export type DesignId = "spectroscope" | "paper" | "still";

export interface DesignPrefs {
  design: DesignId;
  scroll: boolean;
  particles: boolean;
  /** Trace view: the reasoning lens (card 13) — a view mode, persisted like
   *  every other preference so it survives reloads, live and replay alike. */
  reasoningLens: boolean;
}

/** Catalog for the picker: swatch colors + whether the design ships a particle
 *  signature. Exactly three ship (owner 2026-07-20): the two brand themes and
 *  the white minimal light. The retired extra skins (classic, nebula, nocturne,
 *  obsidian, staffwise, neon-riot, prisma) live on in git history only;
 *  parsePrefs folds their stored ids back to the default. */
export const DESIGNS: ReadonlyArray<{
  id: DesignId;
  label: string;
  sub: string;
  particles: boolean;
  bg: string;
  accent: string;
}> = [
  { id: "spectroscope", label: "spectro dark", sub: "espresso · amber line", particles: true, bg: "#17120D", accent: "#CE9440" },
  { id: "paper", label: "spectro bright", sub: "paper · logo blue", particles: true, bg: "#F6F4EE", accent: "#2E7EA6" },
  { id: "still", label: "spectro white", sub: "minimal white · one blue", particles: false, bg: "#fbfbfd", accent: "#0071e3" },
];

const DESIGN_IDS = DESIGNS.map((d) => d.id);
export const STORAGE_KEY = "spectroscope:design";
export const DEFAULT_PREFS: DesignPrefs = { design: "spectroscope", scroll: true, particles: true, reasoningLens: false };

// Side-effect seams — real localStorage + DOM by default, swappable in tests
// (the suite runs in plain Node with no jsdom, so it injects in-memory versions).
let storageGet: () => string | null = () => {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
  } catch {
    return null;
  }
};
let storageSet: (value: string) => void = (value) => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* storage blocked (private mode) */
  }
};
let applyFn: (p: DesignPrefs) => void = applyToDom;

/** Coerce arbitrary parsed JSON into a valid prefs object (pure, never throws). */
export function parsePrefs(raw: string | null): DesignPrefs {
  try {
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<DesignPrefs>;
    return {
      design: DESIGN_IDS.includes(p.design as DesignId) ? (p.design as DesignId) : DEFAULT_PREFS.design,
      scroll: typeof p.scroll === "boolean" ? p.scroll : DEFAULT_PREFS.scroll,
      particles: typeof p.particles === "boolean" ? p.particles : DEFAULT_PREFS.particles,
      reasoningLens: typeof p.reasoningLens === "boolean" ? p.reasoningLens : DEFAULT_PREFS.reasoningLens,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

/** Read + validate the persisted prefs (defaults when absent or blocked). */
export function readSaved(): DesignPrefs {
  return parsePrefs(storageGet());
}

let saved: DesignPrefs = readSaved();
let draft: DesignPrefs = saved;
const listeners = new Set<() => void>();

/** Reflect a prefs object onto <html> — the one place the DOM changes. */
export function applyToDom(p: DesignPrefs): void {
  if (typeof document === "undefined") return;
  const el = document.documentElement;
  el.dataset.design = p.design;
  el.classList.toggle("fx-scroll", p.scroll);
  el.classList.toggle("fx-particles", p.particles);
}

function emit(): void {
  for (const l of listeners) l();
}

export function setDraft(patch: Partial<DesignPrefs>): void {
  draft = { ...draft, ...patch };
  applyFn(draft);
  emit();
}

export function saveDesign(): void {
  saved = draft;
  storageSet(JSON.stringify(saved));
  emit();
}

/**
 * The settings-page path (owner decision): apply AND persist in one step —
 * a design choice must survive a reload without an extra save click. Draft
 * and saved move together, so nothing is ever left dirty.
 */
export function applyAndSaveDesign(patch: Partial<DesignPrefs>): void {
  draft = { ...draft, ...patch };
  saved = draft;
  applyFn(draft);
  storageSet(JSON.stringify(saved));
  emit();
}

export function revertDesign(): void {
  draft = saved;
  applyFn(draft);
  emit();
}

export function isDirty(): boolean {
  return (
    draft.design !== saved.design ||
    draft.scroll !== saved.scroll ||
    draft.particles !== saved.particles ||
    draft.reasoningLens !== saved.reasoningLens
  );
}

/** Apply the current draft on startup (belt-and-suspenders next to the FOUC guard). */
export function initDesign(): void {
  applyFn(draft);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// useSyncExternalStore needs a snapshot that is === across renders when nothing
// changed. Cache it, and only mint a new object when draft or dirtiness moves.
let snapshot: { prefs: DesignPrefs; dirty: boolean } = { prefs: draft, dirty: isDirty() };
function getSnapshot(): { prefs: DesignPrefs; dirty: boolean } {
  const dirty = isDirty();
  if (snapshot.prefs !== draft || snapshot.dirty !== dirty) {
    snapshot = { prefs: draft, dirty };
  }
  return snapshot;
}

/** React hook: the live (draft) prefs + whether there are unsaved changes. */
export function useDesignPrefs(): { prefs: DesignPrefs; dirty: boolean } {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Test-only: inject in-memory storage/apply seams (the suite has no jsdom). */
export function __setTestHooks(hooks: {
  get?: () => string | null;
  set?: (value: string) => void;
  apply?: (p: DesignPrefs) => void;
}): void {
  if (hooks.get) storageGet = hooks.get;
  if (hooks.set) storageSet = hooks.set;
  if (hooks.apply) applyFn = hooks.apply;
}

/** Test-only: reset both layers to the current storage contents. */
export function __resetForTests(): void {
  saved = readSaved();
  draft = saved;
  snapshot = { prefs: draft, dirty: false };
  listeners.clear();
  applyFn(draft);
}
