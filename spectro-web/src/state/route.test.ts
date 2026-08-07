// Addressing a moment: #/session/{id}@{n} names a session and an event in it.
// Built for the ladder's receipts, but the useful part is general — a link into
// a bug report that opens the exact frame someone is talking about.
import { describe, expect, it } from "vitest";
import { formatRoute, formatSessionRoute, parseAppRoute, parseRoute } from "./route";

describe("parsing a route", () => {
  it("reads a session and an event", () => {
    expect(parseRoute("#/session/20260726-aaa@42")).toEqual({
      sessionId: "20260726-aaa",
      eventIndex: 42,
    });
  });

  it("reads a session without an event", () => {
    expect(parseRoute("#/session/20260726-aaa")).toEqual({
      sessionId: "20260726-aaa",
      eventIndex: null,
    });
  });

  it("tolerates the leading hash being absent", () => {
    expect(parseRoute("/session/s-7@3")).toEqual({ sessionId: "s-7", eventIndex: 3 });
  });

  it("decodes an escaped id", () => {
    expect(parseRoute("#/session/a%20b@1")?.sessionId).toBe("a b");
  });

  it("is nothing for an empty or unrelated hash", () => {
    expect(parseRoute("")).toBeNull();
    expect(parseRoute("#")).toBeNull();
    expect(parseRoute("#/settings")).toBeNull();
    expect(parseRoute("#/session/")).toBeNull();
  });

  it("ignores an event that is not a whole non-negative number", () => {
    // A malformed index opens the session unseeked rather than guessing a frame.
    expect(parseRoute("#/session/s-7@abc")).toEqual({ sessionId: "s-7", eventIndex: null });
    expect(parseRoute("#/session/s-7@-1")).toEqual({ sessionId: "s-7", eventIndex: null });
    expect(parseRoute("#/session/s-7@1.5")).toEqual({ sessionId: "s-7", eventIndex: null });
  });

  it("takes the last @ so an id containing one still parses", () => {
    expect(parseRoute("#/session/we@ird@9")).toEqual({ sessionId: "we@ird", eventIndex: 9 });
  });

  it("reads event zero, which is a real event", () => {
    expect(parseRoute("#/session/s-7@0")).toEqual({ sessionId: "s-7", eventIndex: 0 });
  });
});

describe("formatting a route", () => {
  it("round-trips through the parser", () => {
    const hash = formatSessionRoute("20260726-aaa", 42);
    expect(hash).toBe("#/session/20260726-aaa@42");
    expect(parseRoute(hash)).toEqual({ sessionId: "20260726-aaa", eventIndex: 42 });
  });

  it("leaves the event off when there is none", () => {
    expect(formatSessionRoute("s-7", null)).toBe("#/session/s-7");
  });

  it("escapes an id that would otherwise break the shape", () => {
    const hash = formatSessionRoute("a b", 1);
    expect(parseRoute(hash)).toEqual({ sessionId: "a b", eventIndex: 1 });
  });
});

// Card 179: a transcript from the store is an address.
//
// An import used to be a view and nothing else — true for a pasted body and a
// picked file, which genuinely have none. It stopped being true the moment a
// session's agents became openable: a reader opened a workflow's agent, landed
// in it, and had no way back, because what he came FROM had never been an
// address either.
describe("the import address", () => {
  it("carries the store-relative path, encoded", () => {
    expect(formatRoute({ kind: "import", path: "-Users-x-repo/abc.jsonl", tab: null })).toBe(
      "#/import/-Users-x-repo%2Fabc.jsonl",
    );
  });

  it("reads its own hash back", () => {
    expect(parseAppRoute("#/import/-Users-x-repo%2Fabc.jsonl")).toEqual({
      kind: "import",
      path: "-Users-x-repo/abc.jsonl",
      tab: null,
    });
  });

  it("round-trips a sidecar agent's path, which is the case that needed it", () => {
    const path = "-Users-x-repo/s/subagents/workflows/wf_a50345ce-eb8/agent-a058779dfdfa033ff.jsonl";
    expect(parseAppRoute(formatRoute({ kind: "import", path, tab: null }))).toEqual({
      kind: "import",
      path,
      tab: null,
    });
  });

  it("falls back to live for an address that names nothing", () => {
    expect(parseAppRoute("#/import/")).toEqual({ kind: "live", tab: null });
    // A hand-typed hash with a stray % is a typo, not an address.
    expect(parseAppRoute("#/import/%zz")).toEqual({ kind: "live", tab: null });
    expect(formatRoute({ kind: "import", path: "", tab: null })).toBe("#/");
  });
});

// Card 181, the BUG before the feature. The owner: "die trace view verliert die
// deep links und zwar auch für immer wenn man zurück geht."
//
// An imported transcript HAS an address — `#/import/<path>` — but switching to
// another tab wrote a `session` route carrying the replay id
// `import:claude-code:<name>`, which isReplayOnlyId refuses, so formatRoute
// answered "#/" and the address was gone. Going back then landed on the entry
// that had already been overwritten, so it was gone for good.
describe("an imported transcript keeps its address across tabs", () => {
  const path = "-Users-me-Repo/abc-123.jsonl";

  it("carries a tab, the way a session route does", () => {
    expect(formatRoute({ kind: "import", path, tab: "trace" })).toBe(
      `#/import/${encodeURIComponent(path)}/trace`,
    );
  });

  it("reads that address back whole", () => {
    expect(parseAppRoute(`#/import/${encodeURIComponent(path)}/trace`)).toEqual({
      kind: "import",
      path,
      tab: "trace",
    });
  });

  it("writes no tab segment for chat, which is the default", () => {
    expect(formatRoute({ kind: "import", path, tab: null })).toBe(`#/import/${encodeURIComponent(path)}`);
  });

  it("still reads the tab-less form", () => {
    expect(parseAppRoute(`#/import/${encodeURIComponent(path)}`)).toEqual({
      kind: "import",
      path,
      tab: null,
    });
  });

  // A store path contains slashes. The tab suffix must not eat the last segment
  // of a path that happens to end in something tab-shaped.
  it("does not mistake part of the path for a tab", () => {
    const odd = "-Users-me-Repo/trace";
    expect(parseAppRoute(`#/import/${encodeURIComponent(odd)}`)).toEqual({
      kind: "import",
      path: odd,
      tab: null,
    });
  });
});

// The second half of card 181: the state INSIDE the view, on the same address.
describe("a view's own state rides on the address", () => {
  const path = "-Users-me-Repo/abc-123.jsonl";

  it("hangs a selected row on an imported trace", () => {
    const hash = formatRoute({ kind: "import", path, tab: "trace", view: { row: 412 } });
    expect(hash).toBe(`#/import/${encodeURIComponent(path)}/trace?row=412`);
    expect(parseAppRoute(hash)).toEqual({ kind: "import", path, tab: "trace", view: { row: 412 } });
  });

  it("hangs a window on a session's spectrum", () => {
    const hash = formatRoute({
      kind: "session",
      sessionId: "20260805-1200",
      eventIndex: null,
      tab: "spectrum",
      view: { win: { a: 0.25, b: 0.5 } },
    });
    expect(hash).toBe("#/session/20260805-1200/spectrum?win=0.25,0.5");
    expect(parseAppRoute(hash)).toEqual({
      kind: "session",
      sessionId: "20260805-1200",
      eventIndex: null,
      tab: "spectrum",
      view: { win: { a: 0.25, b: 0.5 } },
    });
  });

  it("works on the live view too", () => {
    expect(formatRoute({ kind: "live", tab: "trace", view: { row: 3 } })).toBe("#/trace?row=3");
  });

  it("writes nothing when the view state is empty, so short links stay short", () => {
    expect(formatRoute({ kind: "import", path, tab: "trace", view: {} })).toBe(
      `#/import/${encodeURIComponent(path)}/trace`,
    );
  });

  // A fleet landing has no view whose state would mean anything, and a query on
  // it would be an address promising something nothing reads.
  it("does not stick to a fleet", () => {
    expect(parseAppRoute("#/fleet/ctx-1?row=9")).toEqual({ kind: "fleet", contextId: "ctx-1" });
  });

  it("does not stick to settings", () => {
    expect(parseAppRoute("#/settings/design?row=9")).toEqual({ kind: "settings", section: "design" });
  });

  // The path is percent-encoded, so a `?` inside it is %3F and cannot be
  // mistaken for the start of the query.
  it("does not cut a path that contains a question mark", () => {
    const odd = "-Users-me-Repo/what?.jsonl";
    expect(parseAppRoute(formatRoute({ kind: "import", path: odd, tab: null }))).toEqual({
      kind: "import",
      path: odd,
      tab: null,
    });
  });
});
