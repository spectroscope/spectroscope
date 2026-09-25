// Card 430, criterion 4: every way into a surface asks the table first, and a
// switch that closes the surface on screen lands on the chat of the same
// session with the address following. One test per entry, in light, and a
// learn twin beside each that shows the entry still works there.

import { describe, expect, it } from "vitest";
import { planRoute, type Place } from "./appRouter";
import { fleetEntryAllowed, planLanding, routeInMode, scenarioLanding } from "./modeRoute";
import { formatRoute, parseAppRoute } from "./route";

const onScreen: Place = {
  replayId: null,
  importPath: null,
  enteredFleet: null,
  tab: "chat",
  settingsOpen: false,
};
const guards = { fleetsLocked: false, fleetKnown: true };

/** The address light turns a hash into, as the bar would spell it. */
const inLight = (hash: string): string => formatRoute(routeInMode(parseAppRoute(hash), "light"));
const inLearn = (hash: string): string => formatRoute(routeInMode(parseAppRoute(hash), "learn"));

describe("an address into a closed surface (criterion 4, row 1)", () => {
  it("opens the chat for #/lab and rewrites the address", () => {
    expect(inLight("#/lab")).toBe("#/");
    const plan = planRoute(
      routeInMode(parseAppRoute("#/lab"), "light"),
      { ...onScreen, tab: "chat" },
      guards,
    );
    expect(plan.actions).toEqual([]);
    expect(plan.effective).toEqual({ kind: "live", tab: null });
  });

  it("opens the chat of the session for #/session/{id}/trace, the reading dropped", () => {
    expect(inLight("#/session/s1/trace")).toBe("#/session/s1");
    expect(inLight("#/session/s1/trace?row=12")).toBe("#/session/s1");
    const plan = planRoute(
      routeInMode(parseAppRoute("#/session/s1/trace?row=12"), "light"),
      onScreen,
      guards,
    );
    expect(plan.actions).toEqual([{ kind: "open-session", sessionId: "s1", eventIndex: null, tab: "chat" }]);
  });

  it("rewrites every closed tab, on the live view, a session and an import", () => {
    for (const tab of ["spectrum", "trace", "graph", "text", "lab"]) {
      expect(inLight(`#/${tab}`), tab).toBe("#/");
      expect(inLight(`#/session/s1/${tab}`), tab).toBe("#/session/s1");
      expect(inLight(`#/import/a%2Fb.jsonl/${tab}`), tab).toBe("#/import/a%2Fb.jsonl");
    }
  });

  it("leaves the chat's own addresses and the settings as they are", () => {
    for (const hash of [
      "#/",
      "#/chat",
      "#/session/s1",
      "#/import/a%2Fb.jsonl",
      "#/settings",
      "#/settings/design",
    ]) {
      expect(inLight(hash), hash).toBe(formatRoute(parseAppRoute(hash)));
    }
  });

  it("opens the settings plain for the fleet section light does not draw", () => {
    expect(inLight("#/settings/fleet")).toBe("#/settings");
  });

  it("changes nothing in learn (twin)", () => {
    for (const hash of [
      "#/lab",
      "#/session/s1/trace?row=12",
      "#/session/s1@5",
      "#/fleet/ctx-1",
      "#/settings/fleet",
    ]) {
      expect(inLearn(hash), hash).toBe(formatRoute(parseAppRoute(hash)));
    }
    const route = parseAppRoute("#/lab");
    expect(routeInMode(route, "learn")).toBe(route);
  });
});

describe("an address with an event index (criterion 4, row 2)", () => {
  it("opens the chat at that session in light, with no seek", () => {
    expect(inLight("#/session/s1@5")).toBe("#/session/s1");
    expect(inLight("#/session/s1@5/chat")).toBe("#/session/s1");
    const plan = planRoute(routeInMode(parseAppRoute("#/session/s1@5"), "light"), onScreen, guards);
    expect(plan.actions).toEqual([{ kind: "open-session", sessionId: "s1", eventIndex: null, tab: "chat" }]);
  });

  it("seeks nothing on the session already on screen", () => {
    const plan = planRoute(
      routeInMode(parseAppRoute("#/session/s1@5"), "light"),
      { ...onScreen, replayId: "s1" },
      guards,
    );
    expect(plan.actions).toEqual([]);
  });

  it("lands on the trace at that event in learn (twin)", () => {
    const plan = planRoute(routeInMode(parseAppRoute("#/session/s1@5"), "learn"), onScreen, guards);
    expect(plan.actions).toEqual([{ kind: "open-session", sessionId: "s1", eventIndex: 5, tab: "trace" }]);
  });
});

describe("a fleet address", () => {
  it("falls to the live chat in light", () => {
    expect(inLight("#/fleet/ctx-1")).toBe("#/");
  });

  it("enters the fleet in learn (twin)", () => {
    const plan = planRoute(routeInMode(parseAppRoute("#/fleet/ctx-1"), "learn"), onScreen, guards);
    expect(plan.actions).toEqual([{ kind: "enter-fleet", contextId: "ctx-1" }]);
  });
});

describe("opening a scenario (criterion 4, row 3)", () => {
  it("opens the chat in light and the lab in learn", () => {
    expect(scenarioLanding("light")).toBe("chat");
    expect(scenarioLanding("learn")).toBe("lab");
  });
});

describe("entering a fleet (criterion 4, row 4)", () => {
  it("is refused in light and allowed in learn", () => {
    expect(fleetEntryAllowed("light")).toBe(false);
    expect(fleetEntryAllowed("learn")).toBe(true);
  });
});

describe("the switch lands on the chat of the same session", () => {
  it("moves a closed tab to the chat and rewrites the address, the session kept", () => {
    const landing = planLanding(
      { ...onScreen, replayId: "s1", tab: "trace", view: { row: 12 } },
      "sessions",
      "light",
    );
    expect(landing).toEqual({
      leaveFleet: false,
      nav: null,
      tab: "chat",
      route: { kind: "session", sessionId: "s1", eventIndex: null, tab: null },
    });
  });

  it("moves a closed segment back to the sessions, where the chat is", () => {
    expect(planLanding(onScreen, "stategraph", "light")).toEqual({
      leaveFleet: false,
      nav: "sessions",
      tab: null,
      route: null,
    });
    expect(planLanding({ ...onScreen, tab: "lab" }, "fleets", "light")).toEqual({
      leaveFleet: false,
      nav: "sessions",
      tab: "chat",
      route: { kind: "live", tab: null },
    });
  });

  it("leaves an entered fleet for the live chat", () => {
    expect(planLanding({ ...onScreen, enteredFleet: "ctx-1", tab: "spectrum" }, "fleets", "light")).toEqual({
      leaveFleet: true,
      nav: "sessions",
      tab: "chat",
      route: { kind: "live", tab: null },
    });
  });

  it("keeps an import's address", () => {
    const landing = planLanding(
      { ...onScreen, replayId: "import:claude-code:a.jsonl", importPath: "a/b.jsonl", tab: "text" },
      "sessions",
      "light",
    );
    expect(landing.route).toEqual({ kind: "import", path: "a/b.jsonl", tab: null });
  });

  it("moves nothing when the chat of the sessions is on screen, and nothing in learn", () => {
    const still = { leaveFleet: false, nav: null, tab: null, route: null };
    expect(planLanding(onScreen, "sessions", "light")).toEqual(still);
    expect(planLanding({ ...onScreen, tab: "trace", enteredFleet: "ctx-1" }, "fleets", "learn")).toEqual(
      still,
    );
  });
});
