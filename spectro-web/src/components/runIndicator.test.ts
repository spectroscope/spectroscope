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
import { RUN_STATES, runDotClass, runLabelKey, runState } from "./runIndicator";

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
