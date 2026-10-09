// Card 430, criterion 4: every way into a surface asks the surface table
// first. In light an address into a closed surface opens the chat of the same
// place and the bar learns the address light can show; a scenario opens in the
// chat; a fleet is refused. Developer (card 481) routes like learn. And when the switch itself closes the surface on
// screen, the window lands on the chat of the same session.
//
// Pure: App runs what these functions return (follow and applyRoute, the
// scenario and fleet openers, the switch's listener).

import { routeOfPlace, type Place } from "./appRouter";
import type { NavSegmentId } from "../components/navRows";
import type { Route, ViewTab } from "./route";
import { isOpen } from "./surfaces";
import type { ViewMode } from "./viewMode";

/**
 * The route a mode can show for an address.
 *
 * In learn and developer the route itself: developer opens every surface learn
 * opens, and no route leads to the playbook. In light: a closed tab falls to the chat of the
 * same place, and the reading its address carried goes with it; an event index
 * (a seek into the trace) is dropped, so `#/session/{id}@{n}` opens that
 * session's chat; a fleet falls to the live default, the landing every refused
 * address gets; and the settings open plain for the fleet section light does
 * not draw.
 */
export function routeInMode(route: Route, mode: ViewMode): Route {
  if (mode !== "light") return route;
  switch (route.kind) {
    case "live":
      return isOpen(route.tab ?? "chat", mode) ? route : { kind: "live", tab: null };
    case "session": {
      const shown: ViewTab = route.tab ?? (route.eventIndex !== null ? "trace" : "chat");
      if (!isOpen(shown, mode))
        return { kind: "session", sessionId: route.sessionId, eventIndex: null, tab: null };
      if (route.eventIndex === null || isOpen("trace", mode)) return route;
      // An index on an open tab still seeks a trace row; without the trace the
      // address is the session's chat.
      return { kind: "session", sessionId: route.sessionId, eventIndex: null, tab: null };
    }
    case "import":
      return isOpen(route.tab ?? "chat", mode) ? route : { kind: "import", path: route.path, tab: null };
    case "fleet":
      return isOpen("fleets", mode) ? route : { kind: "live", tab: null };
    case "settings":
      return route.section === "fleet" && !isOpen("fleetSettings", mode)
        ? { kind: "settings", section: null }
        : route;
  }
}

/** The tab a chat scenario opens on: the lab in learn, the chat where the lab is closed. */
export function scenarioLanding(mode: ViewMode): ViewTab {
  return isOpen("lab", mode) ? "lab" : "chat";
}

/** Whether a fleet, live or a scenario's, may be entered. */
export function fleetEntryAllowed(mode: ViewMode): boolean {
  return isOpen("fleets", mode);
}

/** What the window does when a switch closes the surface on screen. */
export interface Landing {
  /** Leave the entered fleet for the live chat. */
  leaveFleet: boolean;
  /** The segment to show, or null to keep it. */
  nav: NavSegmentId | null;
  /** The tab to show, or null to keep it. */
  tab: ViewTab | null;
  /** The address to write in place of the one in the bar, or null when it still holds. */
  route: Route | null;
}

/**
 * Where the window lands after a switch to `mode`: the chat of the same
 * session, or the live chat when the place was a fleet. A segment the mode
 * closes goes back to the sessions.
 *
 * @param place what is on screen
 * @param nav   the rail's segment
 * @param mode  the mode just switched to
 */
export function planLanding(place: Place, nav: NavSegmentId, mode: ViewMode): Landing {
  const leaveFleet = place.enteredFleet !== null && !fleetEntryAllowed(mode);
  const moveNav = !isOpen(nav, mode);
  const moveTab = !isOpen(place.tab, mode) || (leaveFleet && place.tab !== "chat");
  if (!leaveFleet && !moveNav && !moveTab) return { leaveFleet: false, nav: null, tab: null, route: null };
  const landed: Place = leaveFleet
    ? { replayId: null, importPath: null, enteredFleet: null, tab: "chat", settingsOpen: place.settingsOpen }
    : { ...place, tab: moveTab ? "chat" : place.tab, view: moveTab ? undefined : place.view };
  return {
    leaveFleet,
    nav: moveNav ? "sessions" : null,
    tab: moveTab ? "chat" : null,
    route: moveTab || leaveFleet ? routeOfPlace(landed) : null,
  };
}
