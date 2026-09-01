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
  /**
   * True while this tab is a SEAT the layout brought back and not a terminal
   * anybody has used yet (card 339).
   *
   * <p>Closing the terminal panel unmounts it, the socket closes, and the
   * server reaps the PTY — so nothing survives except the fact that a tab was
   * there. A strip that came back looking exactly like the one that left would
   * be a surface claiming more than the code, which is card 303's defect; this
   * flag is what lets the strip say the shell is new and the scrollback gone.
   * It clears on the first keystroke into the tab, because at that point the
   * operator is driving a live shell and the distinction has served.</p>
   */
  restored?: boolean;
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

/**
 * Mark a tab as USED: the operator has typed into it, so it is a live shell
 * like any other and stops being announced as a seat that came back.
 *
 * <p>Identity-stable on a no-op, like {@link retitleTab} beside it — this runs
 * on every keystroke, and a new object per key would re-render the strip
 * forever.</p>
 *
 * @param state the strip
 * @param id    the tab that was typed into
 * @return the strip, or the SAME object when nothing changed
 */
export function touchTab(state: ShellTabsState, id: number): ShellTabsState {
  const at = state.tabs.findIndex((tab) => tab.id === id);
  if (at < 0 || state.tabs[at].restored !== true) return state;
  const tabs = state.tabs.slice();
  const { restored: _dropped, ...rest } = tabs[at];
  tabs[at] = rest;
  return { ...state, tabs };
}

// ---- the strip as a stored layout field (card 339) --------------------------

/**
 * The strip as one string: open ids, then the focused one — `"1,2,3~2"`.
 *
 * <p>A string because that is the road every other dock field takes, and the
 * layout store's hand-written equality check stays one line (state/layout.ts
 * says why). Empty strip, empty string.</p>
 *
 * <p>TITLES ARE DELIBERATELY NOT STORED, and card 339 asked for them. A tab
 * label that still reads `npm run dev` over a shell that is a fresh login
 * prompt is precisely the surface-claims-more defect the card's own second
 * criterion exists to stop, and {@link tabLabel} already falls back to the
 * tab's position, which is honest. So the restore brings back the COUNT, the
 * ids and the focus, and the labels start over.</p>
 *
 * @param state the strip
 * @return the serialized form
 */
export function serializeTabs(state: ShellTabsState): string {
  if (state.tabs.length === 0) return "";
  return `${state.tabs.map((tab) => tab.id).join(",")}~${state.active ?? ""}`;
}

/**
 * The stored strip, made whole — or a single fresh terminal when there is
 * nothing trustworthy to bring back.
 *
 * <p>Junk never seats anything: ids must be positive integers, duplicates go,
 * the cap wins, and a focused id that is not among them falls back to the
 * first. A blob from a build that never wrote this field parses to nothing and
 * lands on exactly the strip this pane opened with before card 339 — one tab,
 * not marked, because it is not a restoration.</p>
 *
 * @param raw whatever the layout store held, possibly from an older build
 * @return the strip to mount with
 */
export function restoreTabs(raw: unknown): ShellTabsState {
  if (typeof raw !== "string" || raw === "") return openTab(emptyTabs());
  const [idsCsv, activeRaw] = raw.split("~");
  const tabs: ShellTab[] = [];
  const seen = new Set<number>();
  for (const part of (idsCsv ?? "").split(",")) {
    if (tabs.length >= SHELL_MAX_TABS) break;
    const id = Number(part);
    if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
    seen.add(id);
    tabs.push({ id, restored: true });
  }
  if (tabs.length === 0) return openTab(emptyTabs());
  const asked = Number(activeRaw);
  const active = seen.has(asked) ? asked : tabs[0].id;
  return { tabs, active, nextId: Math.max(...seen) + 1 };
}

/** What the strip shows: the shell's own title, else the tab's position. */
export function tabLabel(tab: ShellTab, index: number): string {
  const title = (tab.title ?? "").trim();
  if (title === "") return String(index + 1);
  return title.length <= MAX_LABEL ? title : `${title.slice(0, MAX_LABEL - 1)}…`;
}
