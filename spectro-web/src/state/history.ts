// Deciding what a navigation does to browser history (card 131).
//
// Three verbs, one rule each:
//   push    — a real gesture: session click, fleet enter, tab click, settings,
//             new chat, return-to-live. The user went somewhere; back returns.
//   replace — a spelling correction, not a move: applying a route from the URL
//             (follow reads, it never authors), boot normalization, a route
//             falling through to the default, and every seek/scrub tick inside
//             the session already showing (a scrub is one gesture, not fifty).
//   none    — the bar already reads this address. The silence matters: the
//             writer staying quiet on its own echo is what breaks the
//             write/apply loop between the app and the hashchange listener.
//
// navigationIntent is the pure decision; writeRoute executes it against an
// injectable history/location seam (designPrefs.ts style — the suite runs in
// plain Node with no jsdom and swaps in an in-memory bar).

import { formatRoute, parseAppRoute, type Route } from "./route";
import { afterPop, afterPush, NAV_START, stampFor, type NavDepth } from "./navDepth";

/** What a navigation does to history. */
export type NavIntent = "push" | "replace" | "none";

/** Why the navigation happens: a user gesture, a route read from the URL
 *  (hashchange/popstate follow), or boot-time normalization. */
export type NavCause = "gesture" | "apply" | "boot";

/**
 * The pure decision: what should moving from `current` to `next` do?
 *
 * Total and side-effect free — equality is canonical (formatted), so two
 * spellings of one address count as the same place.
 */
export function navigationIntent(current: Route, next: Route, cause: NavCause): NavIntent {
  if (formatRoute(current) === formatRoute(next)) {
    return "none";
  }
  if (cause !== "gesture") {
    // Follow and boot are readers; they may correct the bar, never grow it.
    return "replace";
  }
  if (isSameSessionSeek(current, next)) {
    return "replace";
  }
  return "push";
}

/** A move that only changes WHERE in the session we are, not what is shown. */
function isSameSessionSeek(current: Route, next: Route): boolean {
  return (
    current.kind === "session" &&
    next.kind === "session" &&
    current.sessionId === next.sessionId &&
    current.tab === next.tab
  );
}

// Side-effect seams — the real bar by default, swappable in tests. Guarded so
// the module loads (and no-ops) where no browser exists at all.
let hashGet: () => string = () => {
  try {
    return typeof location !== "undefined" ? location.hash : "";
  } catch {
    return "";
  }
};
/**
 * Where the app stands in its own history, so the bar's back and forward can be
 * dark when there is genuinely nothing there (card 179). The desktop shell draws
 * no chrome for history and the DOM reports no forward availability, so the app
 * stamps each entry it writes and counts.
 */
let depth: NavDepth = NAV_START;

/** The current depth — read by the bar's two buttons. */
export function navDepth(): NavDepth {
  return depth;
}

/** Told by the app when the browser landed on another entry. */
export function navLanded(state: unknown): NavDepth {
  depth = afterPop(depth, state);
  return depth;
}

let hashPush: (hash: string) => void = (hash) => {
  if (typeof history !== "undefined") {
    depth = afterPush(depth);
    history.pushState(stampFor(depth), "", hash);
  }
};
let hashReplace: (hash: string) => void = (hash) => {
  if (typeof history !== "undefined") {
    history.replaceState(null, "", hash);
  }
};

/**
 * Writes a route to the bar, deciding push/replace/none against what the bar
 * reads right now. Returns the intent it executed.
 *
 * Two details carry the design:
 *   - The no-op check is on the RAW hash, so an already-correct bar is left
 *     alone (echo suppression) while a differently-spelled one still gets
 *     normalized.
 *   - A canonical "none" on a raw difference means same place, new spelling —
 *     that is a replace, never a push (boot lands here for `#/bogus` → `#/`).
 *
 * pushState/replaceState fire no hashchange, so writing never re-enters follow.
 */
export function writeRoute(next: Route, cause: NavCause): NavIntent {
  const raw = hashGet();
  const target = formatRoute(next);
  if (raw === target) {
    return "none";
  }
  const decided = navigationIntent(parseAppRoute(raw), next, cause);
  const intent: NavIntent = decided === "none" ? "replace" : decided;
  if (intent === "push") {
    hashPush(target);
  } else {
    hashReplace(target);
  }
  return intent;
}

const defaults = { hash: hashGet, push: hashPush, replace: hashReplace };

/** Test-only: inject an in-memory bar (the suite has no jsdom), or reset it. */
export function __setHistoryTestHooks(hooks: {
  hash?: () => string;
  push?: (hash: string) => void;
  replace?: (hash: string) => void;
  reset?: boolean;
}): void {
  if (hooks.reset) {
    hashGet = defaults.hash;
    hashPush = defaults.push;
    hashReplace = defaults.replace;
    return;
  }
  if (hooks.hash) hashGet = hooks.hash;
  if (hooks.push) hashPush = hooks.push;
  if (hooks.replace) hashReplace = hooks.replace;
}
