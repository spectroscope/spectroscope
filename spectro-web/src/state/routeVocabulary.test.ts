// The full address book (card 131): #/ · #/{tab} · #/session/{id}[@{n}][/{tab}]
// · #/fleet/{contextId} · #/settings[/{section}]. The session@event pins from
// card 81 live untouched in route.test.ts; this file covers the grammar that
// grew around them. Parsing stays forgiving in the same direction: an address
// that names nothing real falls to the live default, it never throws.
import { describe, expect, it } from "vitest";
import {
  formatRoute,
  formatSessionRoute,
  parseAppRoute,
  parseRoute,
  SETTINGS_SECTIONS,
  VIEW_TABS,
  type Route,
} from "./route";

describe("parsing the live default", () => {
  it("is the live view for an empty, bare, or absent hash", () => {
    expect(parseAppRoute("")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute(null)).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute(undefined)).toEqual({ kind: "live", tab: null });
  });

  it("is the live view for an address it does not know", () => {
    expect(parseAppRoute("#/bogus")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/chat/")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/Chat")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/session")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/fleet")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("no-leading-slash")).toEqual({ kind: "live", tab: null });
  });
});

describe("parsing a live tab", () => {
  it("reads each of the six tab literals", () => {
    for (const tab of VIEW_TABS) {
      expect(parseAppRoute(`#/${tab}`)).toEqual({ kind: "live", tab });
    }
  });
});

describe("parsing a session address", () => {
  it("reads the plain and the @-seeked shapes as full routes", () => {
    expect(parseAppRoute("#/session/20260726-aaa")).toEqual({
      kind: "session",
      sessionId: "20260726-aaa",
      eventIndex: null,
      tab: null,
    });
    expect(parseAppRoute("#/session/s-7@42")).toEqual({
      kind: "session",
      sessionId: "s-7",
      eventIndex: 42,
      tab: null,
    });
  });

  it("reads a tab suffix only when it is one of the six literals", () => {
    expect(parseAppRoute("#/session/s-7/trace")).toEqual({
      kind: "session",
      sessionId: "s-7",
      eventIndex: null,
      tab: "trace",
    });
    // "bar" names no tab, so the slash belongs to the id.
    expect(parseAppRoute("#/session/foo/bar")).toEqual({
      kind: "session",
      sessionId: "foo/bar",
      eventIndex: null,
      tab: null,
    });
  });

  it("reads a seek and a tab together", () => {
    expect(parseAppRoute("#/session/s-7@3/lab")).toEqual({
      kind: "session",
      sessionId: "s-7",
      eventIndex: 3,
      tab: "lab",
    });
  });

  it("keeps an id that IS a tab literal as the id", () => {
    expect(parseAppRoute("#/session/chat")).toEqual({
      kind: "session",
      sessionId: "chat",
      eventIndex: null,
      tab: null,
    });
  });

  it("leaves an encoded slash inside the id alone", () => {
    expect(parseAppRoute("#/session/foo%2Fchat")).toEqual({
      kind: "session",
      sessionId: "foo/chat",
      eventIndex: null,
      tab: null,
    });
  });

  it("does not strip a tab suffix when nothing would remain as the id", () => {
    expect(parseAppRoute("#/session//chat")).toEqual({
      kind: "session",
      sessionId: "/chat",
      eventIndex: null,
      tab: null,
    });
  });

  it("keeps the card-81 grammar: last @ wins, malformed index means unseeked", () => {
    expect(parseAppRoute("#/session/we@ird@9")).toEqual({
      kind: "session",
      sessionId: "we@ird",
      eventIndex: 9,
      tab: null,
    });
    expect(parseAppRoute("#/session/s-7@abc/trace")).toEqual({
      kind: "session",
      sessionId: "s-7",
      eventIndex: null,
      tab: "trace",
    });
  });

  it("refuses replay-only ids, which are never addresses", () => {
    // scenario:* and import:* views write #/ — a pasted one names nothing.
    expect(parseAppRoute("#/session/scenario:demo")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/session/import:2026")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/session/scenario%3Ademo")).toEqual({ kind: "live", tab: null });
  });

  it("is the live default when the id is missing", () => {
    expect(parseAppRoute("#/session/")).toEqual({ kind: "live", tab: null });
  });
});

describe("parsing a fleet address", () => {
  it("reads the context id, decoded", () => {
    expect(parseAppRoute("#/fleet/ctx-1")).toEqual({ kind: "fleet", contextId: "ctx-1" });
    expect(parseAppRoute("#/fleet/a%20b")).toEqual({ kind: "fleet", contextId: "a b" });
  });

  it("has no tab segment: the whole rest is the id", () => {
    expect(parseAppRoute("#/fleet/a/chat")).toEqual({ kind: "fleet", contextId: "a/chat" });
  });

  it("refuses replay-only context ids", () => {
    expect(parseAppRoute("#/fleet/scenario:demo")).toEqual({ kind: "live", tab: null });
    expect(parseAppRoute("#/fleet/import:2026")).toEqual({ kind: "live", tab: null });
  });

  it("is the live default when the id is missing", () => {
    expect(parseAppRoute("#/fleet/")).toEqual({ kind: "live", tab: null });
  });
});

describe("parsing a settings address", () => {
  it("reads the plain form", () => {
    expect(parseAppRoute("#/settings")).toEqual({ kind: "settings", section: null });
    expect(parseAppRoute("#/settings/")).toEqual({ kind: "settings", section: null });
  });

  it("reads each known section", () => {
    for (const section of SETTINGS_SECTIONS) {
      expect(parseAppRoute(`#/settings/${section}`)).toEqual({ kind: "settings", section });
    }
  });

  it("opens settings plain for a section it does not know", () => {
    // Forgiving in the card-81 direction: land on the page, not on a guess.
    expect(parseAppRoute("#/settings/bogus")).toEqual({ kind: "settings", section: null });
    expect(parseAppRoute("#/settings/design/extra")).toEqual({ kind: "settings", section: null });
  });
});

describe("formatting the vocabulary", () => {
  it("writes the live default and the live tabs", () => {
    expect(formatRoute({ kind: "live", tab: null })).toBe("#/");
    expect(formatRoute({ kind: "live", tab: "spectrum" })).toBe("#/spectrum");
  });

  it("writes every session shape", () => {
    expect(formatRoute({ kind: "session", sessionId: "s-7", eventIndex: null, tab: null })).toBe(
      "#/session/s-7",
    );
    expect(formatRoute({ kind: "session", sessionId: "s-7", eventIndex: 0, tab: null })).toBe(
      "#/session/s-7@0",
    );
    expect(formatRoute({ kind: "session", sessionId: "s-7", eventIndex: null, tab: "text" })).toBe(
      "#/session/s-7/text",
    );
    expect(formatRoute({ kind: "session", sessionId: "s-7", eventIndex: 3, tab: "lab" })).toBe(
      "#/session/s-7@3/lab",
    );
  });

  it("encodes an id so the shape survives it", () => {
    expect(formatRoute({ kind: "session", sessionId: "foo/chat", eventIndex: null, tab: null })).toBe(
      "#/session/foo%2Fchat",
    );
    expect(formatRoute({ kind: "session", sessionId: "we@ird", eventIndex: null, tab: null })).toBe(
      "#/session/we%40ird",
    );
  });

  it("writes fleet and settings addresses", () => {
    expect(formatRoute({ kind: "fleet", contextId: "ctx-1" })).toBe("#/fleet/ctx-1");
    expect(formatRoute({ kind: "settings", section: null })).toBe("#/settings");
    expect(formatRoute({ kind: "settings", section: "leveling" })).toBe("#/settings/leveling");
  });

  it("refuses replay-only ids and writes the live default instead", () => {
    expect(formatRoute({ kind: "session", sessionId: "scenario:demo", eventIndex: 4, tab: "trace" })).toBe(
      "#/",
    );
    expect(formatRoute({ kind: "session", sessionId: "import:2026", eventIndex: null, tab: null })).toBe(
      "#/",
    );
    expect(formatRoute({ kind: "fleet", contextId: "scenario:demo" })).toBe("#/");
    expect(formatRoute({ kind: "fleet", contextId: "import:2026" })).toBe("#/");
  });
});

describe("round-tripping", () => {
  const shapes: Route[] = [
    { kind: "live", tab: null },
    ...VIEW_TABS.map((tab): Route => ({ kind: "live", tab })),
    { kind: "session", sessionId: "20260726-aaa", eventIndex: null, tab: null },
    { kind: "session", sessionId: "s-7", eventIndex: 0, tab: null },
    { kind: "session", sessionId: "s-7", eventIndex: 42, tab: "trace" },
    { kind: "session", sessionId: "a b", eventIndex: 1, tab: null },
    { kind: "session", sessionId: "foo/chat", eventIndex: null, tab: "chat" },
    { kind: "session", sessionId: "we@ird", eventIndex: 9, tab: null },
    { kind: "session", sessionId: "100%", eventIndex: null, tab: null },
    { kind: "session", sessionId: "scenario", eventIndex: null, tab: null },
    { kind: "session", sessionId: "chat", eventIndex: null, tab: "lab" },
    { kind: "fleet", contextId: "ctx-1" },
    { kind: "fleet", contextId: "a b" },
    { kind: "fleet", contextId: "fleet/inner" },
    { kind: "settings", section: null },
    ...SETTINGS_SECTIONS.map((section): Route => ({ kind: "settings", section })),
  ];

  it("parse(format(r)) gives r back for every shape", () => {
    for (const shape of shapes) {
      expect(parseAppRoute(formatRoute(shape))).toEqual(shape);
    }
  });
});

describe("the legacy card-81 surface", () => {
  it("parseRoute still answers only for sessions, in the old shape", () => {
    expect(parseRoute("#/session/s-7@3")).toEqual({ sessionId: "s-7", eventIndex: 3 });
    expect(parseRoute("#/chat")).toBeNull();
    expect(parseRoute("#/fleet/ctx-1")).toBeNull();
    expect(parseRoute("#/settings/design")).toBeNull();
  });

  it("parseRoute reads through a tab suffix, dropping it", () => {
    expect(parseRoute("#/session/s-7/trace")).toEqual({ sessionId: "s-7", eventIndex: null });
  });

  it("formatSessionRoute stays byte-identical to the full formatter", () => {
    expect(formatSessionRoute("s-7", 3)).toBe(
      formatRoute({ kind: "session", sessionId: "s-7", eventIndex: 3, tab: null }),
    );
  });
});
