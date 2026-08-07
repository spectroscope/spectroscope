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
import type { ViewState } from "./viewState";
import type { ReportingTab } from "./viewReport";

/** What is on screen right now, as the route planner needs to know it. */
export interface Place {
  /** The shown archive/scenario/import id, or null in the live view. */
  replayId: string | null;
  /**
   * The store path an IMPORT was opened from, when it has one.
   *
   * `replayId` cannot answer this: an import's id is `import:<kind>:<label>`,
   * which formatRoute refuses as a session address and answers "#/" for. So a
   * tab flip on an imported transcript wrote the empty address and the deep
   * link was gone — and gone for good, because the entry it overwrote is the
   * one `back` returns to. That is card 181's first line, and it is a bug
   * rather than a missing feature.
   *
   * Null for a live session, a scenario, a paste and a picked file: those
   * genuinely have no address.
   */
  importPath: string | null;
  enteredFleet: string | null;
  tab: ViewTab;
  settingsOpen: boolean;
  /**
   * How the visible view is being read, as that view last reported it (card
   * 181): the selected trace row, the filters that are off, the spectrum
   * window. Absent for a tab that has no reading worth addressing, which is
   * most of them.
   */
  view?: ViewState;
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
  | { kind: "open-import"; path: string }
  /** Hand a view the reading its address named, for it to take once. */
  | { kind: "offer-view"; tab: ReportingTab; view: ViewState };

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
  offerView(effective, actions);
  return { actions, effective };
}

/** The tabs that can take a reading. Anything else is handed nothing. */
const READING_TABS: readonly string[] = ["trace", "spectrum"];

/**
 * Adds the offer that hands a view the reading its address named.
 *
 * The tab is the one the address RESOLVED to, not the one on screen: a cold
 * deep link opens the session and the tab together, and the reading has to
 * arrive with them or the link lands on the right view showing the wrong thing.
 */
function offerView(route: Route, actions: RouteAction[]): void {
  if (route.kind === "fleet" || route.kind === "settings") return;
  const view = route.view;
  if (view === undefined || (view.row === undefined && view.only === undefined && view.win === undefined)) {
    return;
  }
  const tab = route.tab ?? (route.kind === "session" && route.eventIndex !== null ? "trace" : "chat");
  if (!READING_TABS.includes(tab)) return; // a row clause is not the chat's business
  actions.push({ kind: "offer-view", tab: tab as ReportingTab, view });
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
    // A fleet landing has no view whose reading would mean anything, so it
    // never carries one; the formatter drops the clause in any case.
    return { kind: "fleet", contextId: place.enteredFleet };
  }
  // An empty reading is left OFF rather than written as an empty query: the
  // short spelling is the common address and has to stay reachable.
  const view =
    place.view !== undefined &&
    (place.view.row !== undefined || place.view.only !== undefined || place.view.win !== undefined)
      ? { view: place.view }
      : {};
  // BEFORE the replayId branch: an import has both, and only this one formats.
  if (place.importPath !== null) {
    return { kind: "import", path: place.importPath, tab, ...view };
  }
  if (place.replayId !== null) {
    return { kind: "session", sessionId: place.replayId, eventIndex: null, tab, ...view };
  }
  return { kind: "live", tab, ...view };
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
