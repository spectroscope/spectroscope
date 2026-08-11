// The state graph's view state — orientation, cursor, picked node — as one
// App-owned object, lifted for the same reason the run was: the pane's arm
// unmounts whenever `nav` leaves "stategraph", and state living inside it
// resets on every segment switch (StateGraphPane.tsx documented exactly that).
//
// Only the ORIENTATION persists across reloads. It is a view preference, like
// a theme: true of every run this reader will ever load. The cursor and the
// pick are facts about ONE loaded run, and the run itself cannot survive a
// reload (a file picker's file cannot be re-read without a user gesture — see
// App.tsx), so persisting them would restore an answer to a question that is
// no longer on screen.

import type { Orientation } from "./layout";

export interface StateGraphViewState {
  orientation: Orientation;
  /** Record index the transport stands on; null = the whole, finished run. */
  cursor: number | null;
  /** The picked node's id, or null while nothing is picked. */
  picked: string | null;
}

export const DEFAULT_VIEW: StateGraphViewState = {
  orientation: "horizontal",
  cursor: null,
  picked: null,
};

const STORAGE_KEY = "spectroscope:sg-orientation";

// Side-effect seams — real localStorage by default, swappable in tests (the
// suite runs in plain Node with no jsdom; designPrefs.ts's pattern).
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

export function __setViewStateHooks(hooks: {
  get?: () => string | null;
  set?: (value: string) => void;
}): void {
  if (hooks.get) storageGet = hooks.get;
  if (hooks.set) storageSet = hooks.set;
  lastWritten = null;
}

/** Coerce whatever the store held into a valid orientation (pure, total). */
export function parseOrientation(raw: string | null): Orientation {
  return raw === "vertical" ? "vertical" : DEFAULT_VIEW.orientation;
}

/** The view as it opens: defaults, plus the one remembered preference. */
export function initialViewState(): StateGraphViewState {
  return { ...DEFAULT_VIEW, orientation: parseOrientation(storageGet()) };
}

// The view calls through on EVERY state change (a cursor step included), so
// the write is skipped while the orientation stood still.
let lastWritten: Orientation | null = null;

export function rememberOrientation(orientation: Orientation): void {
  if (orientation === lastWritten) return;
  lastWritten = orientation;
  storageSet(orientation);
}
