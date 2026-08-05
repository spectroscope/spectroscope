// Where in its own history the app currently stands.
//
// The desktop shell has no URL bar, so it has no back button either — the one
// control every other view of this app has had all along, because a browser
// supplies it. Card 179 gave imports an address, which made the absence sharp:
// a reader opens a workflow's agent from the work panel and, in the desktop
// app, has no way at all to return to the session that named it.
//
// `history.back()` works there — Electron keeps the same session history, it
// just draws no chrome for it. What the DOM cannot answer is whether there is
// anywhere to go: `history.length` counts the whole tab's life including entries
// from before this app loaded, and nothing reports forward availability at all.
//
// So the app stamps its own index into each entry's state and reads it back on
// popstate. Two numbers, honest ones: where we are, and the furthest we have
// been. A button that is dark is dark because there is genuinely nothing there.

/** What we put in `history.state` — never read by anything else. */
interface NavStamp {
  spectroNav: number;
}

function stampOf(state: unknown): number | null {
  const n = (state as NavStamp | null)?.spectroNav;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** How far back and forward the app can currently go. */
export interface NavDepth {
  index: number;
  furthest: number;
}

/**
 * The depth after a PUSH: one step deeper, and anything that was ahead is gone.
 *
 * Pushing while standing in the middle of the history truncates the forward
 * entries — the browser's own rule, and the reason `furthest` cannot simply
 * grow. A reader who goes back twice and then opens something new has no
 * forward, and the button has to say so.
 *
 * @param was the depth before the push
 * @return the depth after it
 */
export function afterPush(was: NavDepth): NavDepth {
  return { index: was.index + 1, furthest: was.index + 1 };
}

/**
 * The depth after landing on an entry the browser navigated to.
 *
 * @param was the depth before
 * @param state the entry's `history.state`
 * @return the depth after; unchanged when the entry carries no stamp of ours,
 *         because an entry we did not write is not a position we can count
 */
export function afterPop(was: NavDepth, state: unknown): NavDepth {
  const at = stampOf(state);
  return at === null ? was : { index: at, furthest: Math.max(was.furthest, at) };
}

/** Whether a back step lands somewhere this app wrote. */
export function canGoBack(depth: NavDepth): boolean {
  return depth.index > 0;
}

/** Whether a forward step lands somewhere this app wrote. */
export function canGoForward(depth: NavDepth): boolean {
  return depth.index < depth.furthest;
}

/** The starting point: the entry the app booted on. */
export const NAV_START: NavDepth = { index: 0, furthest: 0 };

/**
 * The state object to write with a push, so the entry can be recognised later.
 *
 * @param depth the depth this push produces
 * @return the state to hand `pushState`
 */
export function stampFor(depth: NavDepth): NavStamp {
  return { spectroNav: depth.index };
}
