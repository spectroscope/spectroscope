// Addressing a moment: #/session/{id}@{n} names a session and an event in it.
// Built for the ladder's receipts, but the useful part is general — a link into
// a bug report that opens the exact frame someone is talking about.
import { describe, expect, it } from "vitest";
import { formatSessionRoute, parseRoute } from "./route";

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
