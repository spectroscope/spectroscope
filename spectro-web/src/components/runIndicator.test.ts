// The circle in front of a sidebar row, and the one lie it must never tell.
//
// The list the rail draws comes from GET /api/sessions, which reads stored
// JSONL and nothing else — no endpoint reports which sessions are live. So a
// stored row can only ever be "unfinished" or "finished", and "unfinished"
// means "no run_end closed this file", not "running". A three-day-old file
// with no run_end is not running, and a pulsing dot claiming otherwise is
// exactly the class of defect this house has paid for before.
import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { RUN_STATES, runDotClass, runLabelKey, runState, storedRunState } from "./runIndicator";

describe("runState", () => {
  it("pulses only while a run is actually streaming", () => {
    expect(runState({ live: true, running: true, stopReason: null })).toBe("running");
    expect(runDotClass("running")).toContain("pulse");
  });

  it("calls a connected but quiet session live, not running", () => {
    expect(runState({ live: true, running: false, stopReason: null })).toBe("live");
    expect(runDotClass("live")).not.toContain("pulse");
  });

  it("says unfinished for a file no run_end closed, and never says running", () => {
    expect(runState({ live: false, running: false, stopReason: null })).toBe("open");
    expect(runState({ live: false, running: false, stopReason: undefined })).toBe("open");
    expect(runState({ live: false, running: false, stopReason: "" })).toBe("open");
    // Not connected means not observable, whatever a caller passes for running.
    expect(runState({ live: false, running: true, stopReason: null })).toBe("open");
    expect(runState({ live: false, running: true, stopReason: "end_turn" })).toBe("idle");
  });

  it("calls a finished stored session idle", () => {
    expect(runState({ live: false, running: false, stopReason: "end_turn" })).toBe("idle");
    expect(runState({ live: false, running: false, stopReason: "aborted" })).toBe("idle");
  });

  it("gives the unfinished state its own colour and never the pulsing one", () => {
    // An unfinished file is a fact about the file, so it wears the warn token
    // rather than the accent every live thing in this UI wears.
    expect(runDotClass("open")).toBe("dot warn");
    expect(runDotClass("idle")).toBe("dot faint");
    expect(RUN_STATES.filter((s) => runDotClass(s).includes("pulse"))).toEqual(["running"]);
  });

  it("has a word in both languages for every state it can return", () => {
    for (const state of RUN_STATES) {
      const key = runLabelKey(state);
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de, `${key}.de`).toBeTruthy();
      expect(dict[key].en, `${key}.en`).toBeTruthy();
    }
  });
});

// Card 212: a stored row is no longer limited to what its file says. The server
// reports which sessions are live, so a row that another window is driving
// wears the same dot the driving window shows — and a session that ends while
// another keeps running loses its dot alone.
describe("storedRunState", () => {
  const closed = { id: "s-1", stopReason: "end_turn" };
  const openFile = { id: "s-1", stopReason: null };

  it("draws a session another window is running as running", () => {
    expect(
      storedRunState({
        row: closed,
        live: [{ id: "s-1", running: true, since: 1 }],
        resumeId: null,
        liveRunning: false,
      }),
    ).toBe("running");
  });

  it("draws a session another window merely holds as live", () => {
    expect(
      storedRunState({
        row: closed,
        live: [{ id: "s-1", running: false, since: 1 }],
        resumeId: null,
        liveRunning: false,
      }),
    ).toBe("live");
  });

  it("leaves the OTHER live session alone when one of them ends", () => {
    const live = [{ id: "s-2", running: true, since: 1 }];
    expect(storedRunState({ row: closed, live, resumeId: null, liveRunning: false })).toBe("idle");
    expect(
      storedRunState({ row: { id: "s-2", stopReason: null }, live, resumeId: null, liveRunning: false }),
    ).toBe("running");
  });

  it("never calls a stored file live just because THIS page is busy", () => {
    // The old lie in reverse: liveRunning belongs to this page's socket, and a
    // row nothing reports as live must not borrow it.
    expect(storedRunState({ row: openFile, live: [], resumeId: null, liveRunning: true })).toBe("open");
    expect(storedRunState({ row: closed, live: [], resumeId: null, liveRunning: true })).toBe("idle");
  });

  it("still trusts this page's own resume when nothing reports a live set", () => {
    // A server from before this card sends no live_sessions frame at all. The
    // row this page is resuming stays live, exactly as it did before — the
    // feature is additive all the way down.
    expect(storedRunState({ row: openFile, live: [], resumeId: "s-1", liveRunning: true })).toBe("running");
    expect(storedRunState({ row: openFile, live: [], resumeId: "s-1", liveRunning: false })).toBe("live");
  });

  it("prefers the server's word over this page's guess for the resumed row", () => {
    // Same session, two facts. The server sees every run on the machine; the
    // page sees only its own socket, and the socket may be reconnecting.
    expect(
      storedRunState({
        row: openFile,
        live: [{ id: "s-1", running: true, since: 1 }],
        resumeId: "s-1",
        liveRunning: false,
      }),
    ).toBe("running");
  });
});
