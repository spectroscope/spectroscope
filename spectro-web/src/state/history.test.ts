// Whether a navigation pushes, replaces, or leaves history alone (card 131).
// The rules under test: a real gesture pushes; applying a route from the URL
// never pushes (follow is a reader, not an author); a seek or scrub inside the
// same session replaces (never an entry per tick); the same address twice is
// nothing at all — that silence is what breaks the write/apply echo loop.
import { beforeEach, describe, expect, it } from "vitest";
import { __setHistoryTestHooks, navigationIntent, writeRoute } from "./history";
import type { Route, ViewTab } from "./route";

const LIVE: Route = { kind: "live", tab: null };
const session = (sessionId: string, eventIndex: number | null = null, tab: ViewTab | null = null): Route => ({
  kind: "session",
  sessionId,
  eventIndex,
  tab,
});

describe("navigationIntent on a gesture", () => {
  it("is none for the same address, whatever the kind", () => {
    expect(navigationIntent(LIVE, { kind: "live", tab: null }, "gesture")).toBe("none");
    expect(navigationIntent(session("x", 3, "trace"), session("x", 3, "trace"), "gesture")).toBe("none");
    expect(
      navigationIntent({ kind: "fleet", contextId: "c" }, { kind: "fleet", contextId: "c" }, "gesture"),
    ).toBe("none");
    expect(
      navigationIntent(
        { kind: "settings", section: "design" },
        { kind: "settings", section: "design" },
        "gesture",
      ),
    ).toBe("none");
  });

  it("replaces for a seek or scrub inside the same session", () => {
    expect(navigationIntent(session("x", 3), session("x", 5), "gesture")).toBe("replace");
    expect(navigationIntent(session("x", null), session("x", 7), "gesture")).toBe("replace");
    expect(navigationIntent(session("x", 7), session("x", null), "gesture")).toBe("replace");
  });

  it("pushes for every real move", () => {
    // Sidebar session click, fleet enter, tab click, settings, new chat,
    // return-to-live: each earns a history entry.
    expect(navigationIntent(LIVE, session("x"), "gesture")).toBe("push");
    expect(navigationIntent(session("x"), LIVE, "gesture")).toBe("push");
    expect(navigationIntent(session("x"), session("y"), "gesture")).toBe("push");
    expect(navigationIntent(session("x", 3, "chat"), session("x", 3, "trace"), "gesture")).toBe("push");
    expect(navigationIntent(LIVE, { kind: "live", tab: "lab" }, "gesture")).toBe("push");
    expect(navigationIntent(LIVE, { kind: "fleet", contextId: "c" }, "gesture")).toBe("push");
    expect(navigationIntent(LIVE, { kind: "settings", section: null }, "gesture")).toBe("push");
    expect(
      navigationIntent(
        { kind: "settings", section: null },
        { kind: "settings", section: "machine" },
        "gesture",
      ),
    ).toBe("push");
  });

  it("pushes when a scrub-sized change rides a different session or tab", () => {
    expect(navigationIntent(session("x", 3), session("y", 5), "gesture")).toBe("push");
    expect(navigationIntent(session("x", 3, "chat"), session("x", 5, "trace"), "gesture")).toBe("push");
  });
});

describe("navigationIntent when applying or booting", () => {
  it("never pushes: follow is a reader", () => {
    expect(navigationIntent(LIVE, session("x"), "apply")).toBe("replace");
    expect(navigationIntent(session("x"), LIVE, "apply")).toBe("replace");
    expect(navigationIntent(LIVE, { kind: "settings", section: null }, "boot")).toBe("replace");
  });

  it("is still none for the same address", () => {
    expect(navigationIntent(session("x", 5), session("x", 5), "apply")).toBe("none");
    expect(navigationIntent(LIVE, { kind: "live", tab: null }, "boot")).toBe("none");
  });
});

describe("writeRoute through the seam", () => {
  let hash: string;
  let calls: Array<{ op: "push" | "replace"; hash: string }>;

  beforeEach(() => {
    hash = "#/";
    calls = [];
    __setHistoryTestHooks({
      hash: () => hash,
      push: (h) => {
        calls.push({ op: "push", hash: h });
        hash = h;
      },
      replace: (h) => {
        calls.push({ op: "replace", hash: h });
        hash = h;
      },
    });
  });

  it("is silent when the bar already reads the same address", () => {
    hash = "#/session/x@5";
    expect(writeRoute(session("x", 5), "gesture")).toBe("none");
    expect(calls).toEqual([]);
  });

  it("pushes a gesture and the bar follows", () => {
    expect(writeRoute(session("x"), "gesture")).toBe("push");
    expect(calls).toEqual([{ op: "push", hash: "#/session/x" }]);
  });

  it("replaces per scrub tick, never an entry each", () => {
    hash = "#/session/x@3";
    expect(writeRoute(session("x", 4), "gesture")).toBe("replace");
    expect(writeRoute(session("x", 5), "gesture")).toBe("replace");
    expect(calls).toEqual([
      { op: "replace", hash: "#/session/x@4" },
      { op: "replace", hash: "#/session/x@5" },
    ]);
  });

  it("normalizes an unknown address at boot by replacing it", () => {
    hash = "#/bogus";
    expect(writeRoute(LIVE, "boot")).toBe("replace");
    expect(calls).toEqual([{ op: "replace", hash: "#/" }]);
  });

  it("normalizes a spelling difference without minting an entry", () => {
    // "#" and "#/" address the same place; a gesture must not stack them.
    hash = "#";
    expect(writeRoute(LIVE, "gesture")).toBe("replace");
    expect(calls).toEqual([{ op: "replace", hash: "#/" }]);
  });

  it("replaces, never pushes, when applying a route from the URL", () => {
    hash = "#/session/x";
    expect(writeRoute(session("y"), "apply")).toBe("replace");
    expect(calls).toEqual([{ op: "replace", hash: "#/session/y" }]);
  });

  it("writes the live default for a replay-only id instead of the id", () => {
    hash = "#/session/x";
    expect(writeRoute(session("scenario:demo"), "gesture")).toBe("push");
    expect(calls).toEqual([{ op: "push", hash: "#/" }]);
  });

  it("is silent when the replay-only fallback is already the address", () => {
    hash = "#/";
    expect(writeRoute(session("import:2026"), "gesture")).toBe("none");
    expect(calls).toEqual([]);
  });
});

describe("writeRoute with no browser at all", () => {
  it("does not throw in plain Node: the default seam is guarded", () => {
    __setHistoryTestHooks({ reset: true });
    expect(() => writeRoute(LIVE, "boot")).not.toThrow();
  });
});
