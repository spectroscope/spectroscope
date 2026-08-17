// Card 249: the file viewer's tabs — shellTabs' sibling, keyed by PATH. A
// file's identity is its path, so opening an open file focuses it instead of
// doubling it, and a close is addressed by the same string the tree clicked.
// Each tab carries its own reading (rendered or source); the default is the
// reading the panel always had.

import { previewKind } from "./preview";

/** Which reading of a file a tab shows. */
export type FileView = "rendered" | "source";

/** One open file. */
export interface FileTab {
  path: string;
  view: FileView;
}

export interface FileTabsState {
  tabs: FileTab[];
  /** The path of the tab on screen, or null when the viewer is empty. */
  active: string | null;
}

/** Enough for side-by-side reading, small enough to stay readable as a row. */
export const MAX_FILE_TABS = 8;

/** The empty viewer. */
export function emptyFileTabs(): FileTabsState {
  return { tabs: [], active: null };
}

/**
 * Open a path: an already-open file is focused, a new one appends and takes
 * focus. At the cap the OLDEST inactive tab makes room — refusing the click
 * would read as a broken tree.
 */
export function openFile(state: FileTabsState, path: string): FileTabsState {
  if (state.active === path) return state;
  if (state.tabs.some((tab) => tab.path === path)) return { ...state, active: path };
  let tabs = state.tabs;
  if (tabs.length >= MAX_FILE_TABS) {
    const oldest = tabs.find((tab) => tab.path !== state.active);
    tabs = tabs.filter((tab) => tab !== oldest);
  }
  return { tabs: [...tabs, { path, view: "rendered" }], active: path };
}

/** Focus an open tab; unknown paths are ignored. */
export function selectFile(state: FileTabsState, path: string): FileTabsState {
  if (state.active === path || !state.tabs.some((tab) => tab.path === path)) return state;
  return { ...state, active: path };
}

/**
 * Close a tab. When it was the active one, focus moves right, then left,
 * then to the empty viewer — the shellTabs rule.
 */
export function closeFile(state: FileTabsState, path: string): FileTabsState {
  const at = state.tabs.findIndex((tab) => tab.path === path);
  if (at === -1) return state;
  const tabs = state.tabs.filter((tab) => tab.path !== path);
  const active = state.active === path ? (tabs[at]?.path ?? tabs[at - 1]?.path ?? null) : state.active;
  return { tabs, active };
}

/** The owner's "wieder alle schließen": back to the hint. */
export function closeAllFiles(state: FileTabsState): FileTabsState {
  if (state.tabs.length === 0) return state;
  return emptyFileTabs();
}

/** Choose a tab's reading; the same choice again is a no-op. */
export function setFileView(state: FileTabsState, path: string, view: FileView): FileTabsState {
  const tab = state.tabs.find((candidate) => candidate.path === path);
  if (tab === undefined || tab.view === view) return state;
  return {
    ...state,
    tabs: state.tabs.map((candidate) => (candidate.path === path ? { ...candidate, view } : candidate)),
  };
}

/** A tab is labelled by its basename; the full path rides in the title. */
export function fileTabLabel(tab: FileTab): string {
  const cut = tab.path.lastIndexOf("/");
  return cut === -1 ? tab.path : tab.path.slice(cut + 1);
}

/**
 * Whether a source reading exists that differs from the rendered one: html
 * and markdown render, svg is an image WITH text — only binary images have
 * nothing to show. A plain text file earns the toggle too: its source view
 * is where the line numbers and the folding live.
 */
export function sourceOffered(path: string): boolean {
  const kind = previewKind(path);
  if (kind !== "image") return true;
  return path.toLowerCase().endsWith(".svg");
}
