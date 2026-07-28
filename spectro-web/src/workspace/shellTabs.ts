// The terminal tab strip as pure state (card 93). One tab is one PTY is one
// socket, so the identity of a tab has to outlive nothing: ids are never reused,
// because a reused id would let a closing socket's late callbacks land in the
// pane that took its place.

/** Terminals per session, mirrored from ShellRegistry.MAX_PER_SESSION — the
 *  strip stops offering a new tab before the server has to refuse one. */
export const SHELL_MAX_TABS = 8;

/** Longest tab label before it is cut; a title can be a whole command line. */
const MAX_LABEL = 18;

export interface ShellTab {
  id: number;
  /** What the shell called itself (OSC 0/2), when it said anything. */
  title?: string;
}

export interface ShellTabsState {
  tabs: ShellTab[];
  active: number | null;
  /** Monotonic; never rewound by a close. */
  nextId: number;
}

export function emptyTabs(): ShellTabsState {
  return { tabs: [], active: null, nextId: 1 };
}

/** Open a terminal and focus it. At the cap, the state is returned unchanged. */
export function openTab(state: ShellTabsState): ShellTabsState {
  if (state.tabs.length >= SHELL_MAX_TABS) return state;
  const tab: ShellTab = { id: state.nextId };
  return { tabs: [...state.tabs, tab], active: tab.id, nextId: state.nextId + 1 };
}

/**
 * Close one terminal. When the closing tab was the focused one the selection
 * moves right, then left — the same direction an editor moves — so closing a
 * run of tabs never dumps the operator on an empty pane early.
 */
export function closeTab(state: ShellTabsState, id: number): ShellTabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.active !== id) return { ...state, tabs };
  const next = tabs[at] ?? tabs[at - 1] ?? null;
  return { ...state, tabs, active: next === null ? null : next.id };
}

/** Focus an open tab; an unknown id changes nothing. */
export function selectTab(state: ShellTabsState, id: number): ShellTabsState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return { ...state, active: id };
}

/** Record the title a shell announced. Unchanged input returns the same object
 *  so a title repeated on every prompt does not re-render the strip. */
export function retitleTab(state: ShellTabsState, id: number, title: string): ShellTabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0 || state.tabs[at].title === title) return state;
  const tabs = state.tabs.slice();
  tabs[at] = { ...tabs[at], title };
  return { ...state, tabs };
}

/** What the strip shows: the shell's own title, else the tab's position. */
export function tabLabel(tab: ShellTab, index: number): string {
  const title = (tab.title ?? "").trim();
  if (title === "") return String(index + 1);
  return title.length <= MAX_LABEL ? title : `${title.slice(0, MAX_LABEL - 1)}…`;
}
