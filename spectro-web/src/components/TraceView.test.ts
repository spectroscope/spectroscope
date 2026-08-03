// Pins the class the trace table wears for its optional columns. The modifier
// names are the contract with panels.css: each one drops exactly one track from
// the grid that header and rows share, so the two never fall out of step.

import { describe, expect, it } from "vitest";
import { CATEGORIES, categoryOf, inCategories, traceLinkState, traceTableClass } from "./TraceView";

describe("traceTableClass", () => {
  it("is the plain table while both optional columns show", () => {
    expect(traceTableClass({ host: true, model: true })).toBe("trace-table");
  });

  it("marks a hidden host column", () => {
    expect(traceTableClass({ host: false, model: true })).toBe("trace-table trace-table--no-host");
  });

  it("marks a hidden model column", () => {
    expect(traceTableClass({ host: true, model: false })).toBe("trace-table trace-table--no-model");
  });

  it("composes both modifiers when both columns are off", () => {
    expect(traceTableClass({ host: false, model: false })).toBe(
      "trace-table trace-table--no-host trace-table--no-model",
    );
  });
});

// The session to trace deep link (card 137). Three states, and one of them is
// silence: the trace toolbar is not where anyone learns what Langfuse is.
describe("traceLinkState", () => {
  it("shows nothing before the first export", () => {
    expect(traceLinkState(null, null)).toBe("none");
  });

  it("shows the failure line when nothing has landed", () => {
    expect(traceLinkState(null, "HTTP 401")).toBe("failed");
  });

  it("shows the link once an export landed", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", null)).toBe("link");
  });

  it("a later failure does not remove a working link", () => {
    expect(traceLinkState("http://localhost:3000/trace/abc", "HTTP 500")).toBe("link");
  });

  it("stays silent for an export that landed on a non-langfuse backend", () => {
    // A successful Jaeger export yields no url, and that is not a failure.
    expect(traceLinkState(null, null)).toBe("none");
  });
});

// The chip that brings in what the client recorded (card 141).
//
// The trace groups frames by category and gives each group a chip. The four
// import-only kinds are not run, turn, text, thinking, tool, permission,
// usage, image or context, and dropping them into `other` would scatter them
// among agent_spawn, compaction and error, where a reader cannot put them away
// or bring them back in one click. They get their own.
describe("the client category", () => {
  it("groups the four import-only kinds, and takes nothing that was already placed", () => {
    for (const type of ["task_reminder", "queue_operation", "queued_command", "edited_text_file"]) {
      expect(categoryOf(type), type).toBe("client");
    }
    // The neighbours it must not have swallowed: `other` is still the home of
    // everything unclassified, and every named category still answers.
    expect(categoryOf("agent_spawn")).toBe("other");
    expect(categoryOf("compaction")).toBe("other");
    expect(categoryOf("run_start")).toBe("run");
    expect(categoryOf("tool_call")).toBe("tool");
  });

  it("is one of the chips, so it can be switched off", () => {
    expect(CATEGORIES).toContain("client");
  });

  it("drops exactly those four rows when the chip is off", () => {
    const rows = [
      "run_start",
      "turn_start",
      "task_reminder",
      "text_delta",
      "queue_operation",
      "tool_call",
      "queued_command",
      "agent_spawn",
      "edited_text_file",
      "run_end",
    ];
    const off = new Set(CATEGORIES.filter((c) => c !== "client"));
    expect(rows.filter((t) => inCategories(t, off))).toEqual([
      "run_start",
      "turn_start",
      "text_delta",
      "tool_call",
      "agent_spawn",
      "run_end",
    ]);
    // And with every chip on, nothing is dropped: the filter is the only thing
    // that decides, and an unknown type must not fall out of the trace.
    expect(rows.filter((t) => inCategories(t, new Set(CATEGORIES)))).toEqual(rows);
  });
});
