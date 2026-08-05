// The wiring decisions behind the deep links (card 131), pure and testable:
// the App executes the plans made here, it does not think about routes itself.
//
// planRoute is a FACET DIFF between an address and what is on screen, never a
// handler per route kind. The distinction carries the whole design: pressing
// back from #/session/x/trace to #/session/x/chat is a tab flip, and closing
// settings over a session is a panel close — neither may refetch the session,
// rebuild the fold, or re-fire the session beacon. Only an address naming a
// session that is NOT on screen opens one, and the tab suffix rides INTO that
// open so it can be applied after the fetch lands, where the leveling beacons
// read the right session.
//
// A fleet address walks through two guards before it is believed: the ladder's
// fleets lock (a deep link must not walk around it — and entry-by-address is
// not a gesture, so the plan's enter-fleet carries no beacon), and the
// hydrated roster (an unknown fleet is not a place). Either failing falls
// through to the live default, the same landing every unknown address gets.

import type { Route, SettingsSection, ViewTab } from "./route";

/** What is on screen right now, as the route planner needs to know it. */
export interface Place {
  /** The shown archive/scenario/import id, or null in the live view. */
  replayId: string | null;
  enteredFleet: string | null;
  tab: ViewTab;
  settingsOpen: boolean;
}

/** One step of applying an address. The App maps each to its own handler. */
export type RouteAction =
  | { kind: "open-session"; sessionId: string; eventIndex: number | null; tab: ViewTab | null }
  | { kind: "seek"; eventIndex: number }
  | { kind: "set-tab"; tab: ViewTab }
  | { kind: "enter-fleet"; contextId: string }
  | { kind: "return-to-live" }
  | { kind: "open-settings"; section: SettingsSection | null }
  | { kind: "close-settings" }
  /** Fetch a store transcript by path and import it. */
  | { kind: "open-import"; path: string };

export interface RoutePlan {
  actions: RouteAction[];
  /** What the bar should say afterwards — the normalization target. A route
   *  a guard refused comes back as the live default here. */
  effective: Route;
}

export interface RouteGuards {
  /** The ladder's fleets lock, at application time. */
  fleetsLocked: boolean;
  /** Whether the hydrated roster knows the addressed fleet (true for any
   *  non-fleet route — the guard simply does not apply). */
  fleetKnown: boolean;
}

/**
 * Diffs an address against the screen and plans the smallest application.
 *
 * Pure and total: any route on any place yields a plan, and a plan of zero
 * actions is the idempotence that lets hashchange and popstate both fire for
 * one traversal without applying it twice.
 */
export function planRoute(route: Route, place: Place, guards: RouteGuards): RoutePlan {
  if (route.kind === "settings") {
    // Settings lay OVER the view; the facets beneath stay untouched, so back
    // from here is a panel close, never a view rebuild.
    return { actions: [{ kind: "open-settings", section: route.section }], effective: route };
  }
  const actions: RouteAction[] = [];
  if (place.settingsOpen) {
    actions.push({ kind: "close-settings" });
  }
  if (route.kind === "import") {
    // A store transcript is fetched and imported, which is a different verb
    // from opening a stored SESSION: nothing here is in the session store, and
    // the file may be an agent's own transcript rather than a session's. It is
    // still an address, which is the whole point — an import a reader can go
    // BACK from (card 179).
    actions.push({ kind: "open-import", path: route.path });
    return { actions, effective: route };
  }
  const effective: Route =
    route.kind === "fleet" && (guards.fleetsLocked || !guards.fleetKnown)
      ? { kind: "live", tab: null }
      : route;
  switch (effective.kind) {
    case "live": {
      if (place.replayId !== null || place.enteredFleet !== null) {
        actions.push({ kind: "return-to-live" });
      }
      // An address without a tab means the default one: "#/" entries are
      // written where the chat is showing, so applying one lands there.
      const wantTab = effective.tab ?? "chat";
      if (wantTab !== place.tab) {
        actions.push({ kind: "set-tab", tab: wantTab });
      }
      break;
    }
    case "session": {
      // A bare session address means the chat; behind a seek it means the
      // trace — the frame an @n addresses is a trace row (card 81, kept).
      const wantTab = effective.tab ?? (effective.eventIndex !== null ? "trace" : "chat");
      if (place.replayId === effective.sessionId) {
        // The session is on screen: a seek and/or a tab flip, never a refetch.
        if (effective.eventIndex !== null) {
          actions.push({ kind: "seek", eventIndex: effective.eventIndex });
        }
        if (wantTab !== place.tab) {
          actions.push({ kind: "set-tab", tab: wantTab });
        }
      } else {
        actions.push({
          kind: "open-session",
          sessionId: effective.sessionId,
          eventIndex: effective.eventIndex,
          tab: wantTab,
        });
      }
      break;
    }
    case "fleet": {
      if (place.enteredFleet !== effective.contextId) {
        actions.push({ kind: "enter-fleet", contextId: effective.contextId });
      }
      break;
    }
  }
  return { actions, effective };
}

/**
 * The address of what is on screen — what the bar should say about the place
 * itself. The writer uses it when the app leaves a place without navigating TO
 * one (a deleted session, a removed fleet, a deep-linked settings page closing
 * onto the view beneath). The default chat tab stays unwritten, so the common
 * addresses keep their short spelling.
 */
export function routeOfPlace(place: Place): Route {
  const tab = place.tab === "chat" ? null : place.tab;
  if (place.enteredFleet !== null) {
    return { kind: "fleet", contextId: place.enteredFleet };
  }
  if (place.replayId !== null) {
    return { kind: "session", sessionId: place.replayId, eventIndex: null, tab };
  }
  return { kind: "live", tab };
}

/** Last-wins ordering for async navigations: a ticket is current only until
 *  the next one is issued, so a slow session fetch a later navigation overtook
 *  drops its result instead of committing a stale view. */
export interface NavNonce {
  issue(): number;
  isCurrent(ticket: number): boolean;
}

export function createNavNonce(): NavNonce {
  let current = 0;
  return {
    issue: () => ++current,
    isCurrent: (ticket) => ticket === current,
  };
}

/** How closing the settings page treats history. */
export type SettingsClose = { verb: "back" } | { verb: "close"; rewrite: boolean };

/**
 * Close via history.back() ONLY for the settings entry this app pushed — that
 * is tracked, never guessed. A deep-linked settings page (boot, a pasted
 * address) has no app entry behind it, so back would leave the site: it closes
 * in place and rewrites the bar to the view beneath. A bar that already moved
 * on is left alone.
 */
export function settingsCloseDecision(hashIsSettings: boolean, pushedByUs: boolean): SettingsClose {
  if (hashIsSettings && pushedByUs) {
    return { verb: "back" };
  }
  return { verb: "close", rewrite: hashIsSettings };
}

/**
 * The identity of what the screen is showing, for state that must not outlive
 * it. The view key alone is not enough: a new or resumed chat keeps the key
 * "live" while every event on screen belongs to a different session — the
 * connection nonce catches that.
 */
export function viewIdentity(connNonce: number, viewKey: string): string {
  return `${connNonce}·${viewKey}`;
}

/**
 * Card 147: the trace's agent pin belongs to the view it was taken in. A pin
 * that rides into the next session filters rows nobody can see a control for
 * (the one-agent guard hides the chip row), so a changed identity clears it.
 */
export function pinAfterNavigation(
  previousIdentity: string,
  nextIdentity: string,
  pin: string | null,
): string | null {
  return previousIdentity === nextIdentity ? pin : null;
}
