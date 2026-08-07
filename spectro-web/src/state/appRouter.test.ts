// The wiring decisions behind the deep links (card 131) and the trace pin
// (card 147), as pure functions — the App executes plans, it does not think.
//
// The rules under test:
//   - Applying a route is a FACET DIFF, never handler-per-route: the same
//     session already on screen gets a tab flip or a seek, not a refetch.
//   - A fleet address walks through the fleets lock and the hydrated roster;
//     locked or unknown falls through to the live default.
//   - Rapid back/forward over async session opens is last-wins via a nonce.
//   - Closing settings goes history.back() only for the entry we pushed.
//   - The trace's agent pin belongs to the view it was taken in (card 147):
//     a new shown identity clears it, a re-render does not.
import { describe, expect, it } from "vitest";
import {
  createNavNonce,
  pinAfterNavigation,
  planRoute,
  routeOfPlace,
  settingsCloseDecision,
  viewIdentity,
  type Place,
} from "./appRouter";
import { formatRoute, type Route } from "./route";

const openGuards = { fleetsLocked: false, fleetKnown: true };

const at = (over: Partial<Place> = {}): Place => ({
  replayId: null,
  importPath: null,
  enteredFleet: null,
  tab: "chat",
  settingsOpen: false,
  ...over,
});

type SessionRouteShape = Extract<Route, { kind: "session" }>;
const session = (
  sessionId: string,
  eventIndex: number | null = null,
  tab: "chat" | "spectrum" | "graph" | "trace" | "text" | "lab" | null = null,
): SessionRouteShape => ({ kind: "session", sessionId, eventIndex, tab });

describe("planRoute for a session address", () => {
  it("opens a session that is not on screen, with the tab riding IN the open", () => {
    // Amendment 3: the tab suffix must not be a sibling setTab call — it rides
    // into the open and is applied in the resolved branch, after the fetch.
    const plan = planRoute(session("x", null, "trace"), at(), openGuards);
    expect(plan.actions).toEqual([{ kind: "open-session", sessionId: "x", eventIndex: null, tab: "trace" }]);
    expect(plan.effective).toEqual(session("x", null, "trace"));
  });

  it("flips only the tab when the session is already shown — never a refetch", () => {
    // Amendment 2: back from #/session/x/trace to #/session/x/chat is a tab
    // flip, not a reload of the whole JSONL.
    const plan = planRoute(session("x", null, "chat"), at({ replayId: "x", tab: "trace" }), openGuards);
    expect(plan.actions).toEqual([{ kind: "set-tab", tab: "chat" }]);
  });

  it("plans nothing at all when the address already describes the screen", () => {
    const plan = planRoute(session("x", null, "trace"), at({ replayId: "x", tab: "trace" }), openGuards);
    expect(plan.actions).toEqual([]);
  });

  it("seeks within the shown session and lands on the trace by default", () => {
    const plan = planRoute(session("x", 5), at({ replayId: "x", tab: "chat" }), openGuards);
    expect(plan.actions).toEqual([
      { kind: "seek", eventIndex: 5 },
      { kind: "set-tab", tab: "trace" },
    ]);
  });

  it("lets an explicit tab suffix outrank the seek's trace default", () => {
    const plan = planRoute(session("x", 5, "lab"), at({ replayId: "x", tab: "chat" }), openGuards);
    expect(plan.actions).toEqual([
      { kind: "seek", eventIndex: 5 },
      { kind: "set-tab", tab: "lab" },
    ]);
  });

  it("refetches when the same id is shown as a fleet, not as a session", () => {
    const plan = planRoute(session("x"), at({ enteredFleet: "x" }), openGuards);
    expect(plan.actions).toEqual([{ kind: "open-session", sessionId: "x", eventIndex: null, tab: "chat" }]);
  });

  it("resolves what a bare address means: chat, or trace behind a seek", () => {
    // The plan hands openSession a CONCRETE tab, so applying an entry always
    // restores the tab that entry showed — a gesture open passes none and
    // keeps the current tab, which is the pre-131 behavior.
    expect(planRoute(session("y"), at({ tab: "trace" }), openGuards).actions).toEqual([
      { kind: "open-session", sessionId: "y", eventIndex: null, tab: "chat" },
    ]);
    expect(planRoute(session("y", 5), at(), openGuards).actions).toEqual([
      { kind: "open-session", sessionId: "y", eventIndex: 5, tab: "trace" },
    ]);
  });

  it("walks a shown session back to chat when the address drops the suffix", () => {
    // Back from #/session/x/trace to #/session/x: that entry showed the chat.
    const plan = planRoute(session("x"), at({ replayId: "x", tab: "trace" }), openGuards);
    expect(plan.actions).toEqual([{ kind: "set-tab", tab: "chat" }]);
  });
});

describe("planRoute for the live address", () => {
  it("returns to live from a replay and applies the named tab", () => {
    const plan = planRoute({ kind: "live", tab: "lab" }, at({ replayId: "x" }), openGuards);
    expect(plan.actions).toEqual([{ kind: "return-to-live" }, { kind: "set-tab", tab: "lab" }]);
  });

  it("restores the default chat tab when the address names none", () => {
    // "#/" is the live default, and the default tab is the chat: an entry
    // written as "#/" was created there, so back onto it lands there.
    const plan = planRoute({ kind: "live", tab: null }, at({ replayId: "x", tab: "trace" }), openGuards);
    expect(plan.actions).toEqual([{ kind: "return-to-live" }, { kind: "set-tab", tab: "chat" }]);
  });

  it("plans nothing on the live view it describes", () => {
    expect(planRoute({ kind: "live", tab: null }, at(), openGuards).actions).toEqual([]);
    expect(planRoute({ kind: "live", tab: "chat" }, at({ tab: "chat" }), openGuards).actions).toEqual([]);
  });
});

describe("planRoute for a fleet address", () => {
  it("enters a known fleet without a beacon action — entry is not a gesture", () => {
    const plan = planRoute({ kind: "fleet", contextId: "c" }, at(), openGuards);
    expect(plan.actions).toEqual([{ kind: "enter-fleet", contextId: "c" }]);
    expect(plan.effective).toEqual({ kind: "fleet", contextId: "c" });
  });

  it("plans nothing when the fleet is already entered", () => {
    const plan = planRoute({ kind: "fleet", contextId: "c" }, at({ enteredFleet: "c" }), openGuards);
    expect(plan.actions).toEqual([]);
  });

  it("falls through to the live default while fleets are locked", () => {
    // Amendment 4: a deep link must not walk around the ladder's fleets lock.
    const plan = planRoute({ kind: "fleet", contextId: "c" }, at(), { fleetsLocked: true, fleetKnown: true });
    expect(plan.actions).toEqual([]);
    expect(plan.effective).toEqual({ kind: "live", tab: null });
  });

  it("kicks a locked deep link out of an already-shown replay too", () => {
    const plan = planRoute({ kind: "fleet", contextId: "c" }, at({ replayId: "x" }), {
      fleetsLocked: true,
      fleetKnown: true,
    });
    expect(plan.actions).toEqual([{ kind: "return-to-live" }]);
  });

  it("falls through to the live default for a fleet the roster does not know", () => {
    const plan = planRoute({ kind: "fleet", contextId: "ghost" }, at(), {
      fleetsLocked: false,
      fleetKnown: false,
    });
    expect(plan.actions).toEqual([]);
    expect(plan.effective).toEqual({ kind: "live", tab: null });
  });
});

describe("planRoute for the settings address", () => {
  it("opens settings with its section and leaves the view beneath untouched", () => {
    const plan = planRoute(
      { kind: "settings", section: "observability" },
      at({ replayId: "x", tab: "trace" }),
      openGuards,
    );
    expect(plan.actions).toEqual([{ kind: "open-settings", section: "observability" }]);
    expect(plan.effective).toEqual({ kind: "settings", section: "observability" });
  });

  it("closes an open settings page before applying any other address", () => {
    // Back from #/settings to #/session/x: the panel closes, the session
    // beneath it is already on screen — no refetch (amendment 2).
    const plan = planRoute(session("x"), at({ replayId: "x", settingsOpen: true }), openGuards);
    expect(plan.actions).toEqual([{ kind: "close-settings" }]);
  });
});

describe("routeOfPlace: the address of what is on screen", () => {
  it("names the fleet, the session with its non-default tab, or the live view", () => {
    expect(routeOfPlace(at({ enteredFleet: "c", tab: "lab" }))).toEqual({ kind: "fleet", contextId: "c" });
    expect(routeOfPlace(at({ replayId: "x", tab: "trace" }))).toEqual(session("x", null, "trace"));
    expect(routeOfPlace(at({ replayId: "x" }))).toEqual(session("x", null, null));
    expect(routeOfPlace(at({ tab: "lab" }))).toEqual({ kind: "live", tab: "lab" });
    expect(routeOfPlace(at())).toEqual({ kind: "live", tab: null });
  });
});

describe("routeOfPlace carries the reading the view reported (card 181)", () => {
  it("writes it for a session, an import and the live view", () => {
    const view = { row: 12 };
    expect(routeOfPlace(at({ replayId: "x", tab: "trace", view }))).toEqual({
      ...session("x", null, "trace"),
      view,
    });
    expect(routeOfPlace(at({ importPath: "p/s.jsonl", tab: "trace", view }))).toEqual({
      kind: "import",
      path: "p/s.jsonl",
      tab: "trace",
      view,
    });
    expect(routeOfPlace(at({ tab: "spectrum", view: { win: { a: 0.2, b: 0.5 } } }))).toEqual({
      kind: "live",
      tab: "spectrum",
      view: { win: { a: 0.2, b: 0.5 } },
    });
  });

  it("leaves the address alone when the view reported nothing", () => {
    // The short spelling is the common one and must stay reachable: a reader
    // who has touched nothing gets "#/session/x/trace", not a query saying so.
    expect(routeOfPlace(at({ replayId: "x", tab: "trace", view: {} }))).toEqual(session("x", null, "trace"));
    expect(routeOfPlace(at({ replayId: "x", tab: "trace" }))).toEqual(session("x", null, "trace"));
  });

  it("never hangs a reading on a fleet", () => {
    // A fleet landing has no view whose state would mean anything, and the
    // formatter drops the clause anyway; planting one here would be an address
    // that promises something nothing reads.
    expect(routeOfPlace(at({ enteredFleet: "c", tab: "trace", view: { row: 3 } }))).toEqual({
      kind: "fleet",
      contextId: "c",
    });
  });
});

describe("planRoute hands a view the reading its address named", () => {
  it("offers it to the tab the address resolved to", () => {
    const plan = planRoute(
      { ...session("x", null, "trace"), view: { row: 12 } },
      at({ replayId: "x" }),
      openGuards,
    );

    expect(plan.actions).toContainEqual({ kind: "offer-view", tab: "trace", view: { row: 12 } });
  });

  it("offers it on an open too, so a cold deep link lands read", () => {
    // The commonest way anybody meets one of these links: pasted into a fresh
    // tab, with the session not on screen yet.
    const plan = planRoute(
      { ...session("x", null, "spectrum"), view: { win: { a: 0.2, b: 0.5 } } },
      at(),
      openGuards,
    );

    expect(plan.actions).toContainEqual({
      kind: "offer-view",
      tab: "spectrum",
      view: { win: { a: 0.2, b: 0.5 } },
    });
  });

  it("offers nothing when the address carries no reading", () => {
    const plan = planRoute(session("x", null, "trace"), at({ replayId: "x" }), openGuards);

    expect(plan.actions.some((a) => a.kind === "offer-view")).toBe(false);
  });

  it("offers nothing to a tab that has no reading to take", () => {
    // A row clause on a chat address is not the chat's business, and the chat
    // has nothing to do with it.
    const plan = planRoute(
      { ...session("x", null, "chat"), view: { row: 12 } },
      at({ replayId: "x" }),
      openGuards,
    );

    expect(plan.actions.some((a) => a.kind === "offer-view")).toBe(false);
  });
});

describe("createNavNonce: rapid navigations are last-wins", () => {
  it("outdates every earlier ticket the moment a new one is issued", () => {
    const nonce = createNavNonce();
    const first = nonce.issue();
    expect(nonce.isCurrent(first)).toBe(true);
    const second = nonce.issue();
    // The slow first fetch resolves after the second navigation: it must drop.
    expect(nonce.isCurrent(first)).toBe(false);
    expect(nonce.isCurrent(second)).toBe(true);
  });
});

describe("settingsCloseDecision", () => {
  it("goes back through history only for the settings entry we pushed", () => {
    expect(settingsCloseDecision(true, true)).toEqual({ verb: "back" });
  });

  it("closes in place and rewrites the bar for a deep-linked settings entry", () => {
    // A fresh tab opened at #/settings has no app entry behind it: back would
    // leave the site, so the close stays put and corrects the address.
    expect(settingsCloseDecision(true, false)).toEqual({ verb: "close", rewrite: true });
  });

  it("just closes when the bar has already moved on", () => {
    expect(settingsCloseDecision(false, true)).toEqual({ verb: "close", rewrite: false });
    expect(settingsCloseDecision(false, false)).toEqual({ verb: "close", rewrite: false });
  });
});

describe("the trace pin across navigations (card 147)", () => {
  it("carries within the same shown identity", () => {
    const id = viewIdentity(1, "live");
    expect(pinAfterNavigation(id, viewIdentity(1, "live"), "worker-2")).toBe("worker-2");
  });

  it("clears when another session, fleet, scenario or import takes the screen", () => {
    const live = viewIdentity(1, "live");
    expect(pinAfterNavigation(live, viewIdentity(1, "20260725-175159"), "worker-2")).toBe(null);
    expect(pinAfterNavigation(live, viewIdentity(1, "fleet-c"), "worker-2")).toBe(null);
    expect(pinAfterNavigation(viewIdentity(1, "scenario:demo"), viewIdentity(1, "live"), "worker-2")).toBe(
      null,
    );
  });

  it("clears on a new or resumed chat: same view key, new connection", () => {
    expect(pinAfterNavigation(viewIdentity(1, "live"), viewIdentity(2, "live"), "worker-2")).toBe(null);
  });
});

// Card 181's first line, and it is a BUG rather than a missing feature: the
// owner, "die trace view verliert die deep links und zwar auch für immer wenn
// man zurück geht."
//
// An imported transcript has an address. Its replayId does not: `import:<kind>:
// <label>` is refused by formatRoute, which answers "#/". So every place that
// derived an address from the replayId alone wrote the empty one — and since
// that write REPLACED the entry `back` returns to, the link was gone for good.
describe("the address of an imported transcript", () => {
  const path = "-Users-me-Repo/abc-123.jsonl";
  const imported = { replayId: "import:claude-code:abc-123.jsonl", importPath: path };

  it("is the import address, not the empty one", () => {
    expect(routeOfPlace(at({ ...imported }))).toEqual({ kind: "import", path, tab: null });
  });

  it("survives a tab flip, which is where it used to die", () => {
    expect(routeOfPlace(at({ ...imported, tab: "trace" }))).toEqual({
      kind: "import",
      path,
      tab: "trace",
    });
  });

  it("formats to something a reader can paste", () => {
    expect(formatRoute(routeOfPlace(at({ ...imported, tab: "spectrum" })))).toBe(
      `#/import/${encodeURIComponent(path)}/spectrum`,
    );
  });

  // The distinction that makes it safe: a paste and a picked file have no path,
  // and must keep saying so rather than inventing one.
  it("stays empty for an import with no address behind it", () => {
    expect(formatRoute(routeOfPlace(at({ replayId: "import:claude-code:pasted", importPath: null })))).toBe(
      "#/",
    );
  });

  it("does not shadow a fleet, which is a different place entirely", () => {
    expect(routeOfPlace(at({ ...imported, enteredFleet: "ctx-1" }))).toEqual({
      kind: "fleet",
      contextId: "ctx-1",
    });
  });

  it("leaves an ordinary stored session alone", () => {
    expect(routeOfPlace(at({ replayId: "20260805-1200", tab: "trace" }))).toEqual({
      kind: "session",
      sessionId: "20260805-1200",
      eventIndex: null,
      tab: "trace",
    });
  });
});
