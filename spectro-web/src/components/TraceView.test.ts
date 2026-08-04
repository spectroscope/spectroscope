// Pins the class the trace table wears for its optional columns. The modifier
// names are the contract with panels.css: each one drops exactly one track from
// the grid that header and rows share, so the two never fall out of step.

import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import {
  CATEGORIES,
  categoryOf,
  inCategories,
  summarize,
  traceLinkState,
  traceTableClass,
} from "./TraceView";

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

// The collapsed row for a todo list (card 141).
//
// A row whose summary is compactJson(payload) shows `{"items":[{"id":"1",...`
// and then ellipsizes, which is the json blob the card refused. The counts are
// what a reader scanning the trace can use, and they are the same three words
// the plan panel already says in both languages.
describe("the todo row's summary", () => {
  const row = (payload: unknown): TraceEntry => ({
    seq: 1,
    dir: "in",
    ts: 0,
    type: "task_reminder",
    payload,
  });
  const it3 = [
    { id: "1", subject: "a", description: "a1", status: "completed", blocks: [], blockedBy: [] },
    { id: "2", subject: "b", description: "b1", status: "in_progress", blocks: [], blockedBy: [] },
    { id: "3", subject: "c", description: "c1", status: "pending", blocks: [], blockedBy: [] },
  ];

  it("counts the list instead of printing it", () => {
    expect(summarize(row({ items: it3, itemCount: 3 }), "en")).toBe("1 open · 1 running · 1 done");
    expect(summarize(row({ items: it3, itemCount: 3 }), "de")).toBe("1 offen · 1 in Arbeit · 1 fertig");
  });

  it("shows the raw frame when the list is not one it can read", () => {
    const broken = { items: [{ id: "1", status: "pending" }] };
    expect(summarize(row(broken), "en")).toBe('{"items":[{"id":"1","status":"pending"}]}');
  });

  it("leaves the other three import-only kinds as they were", () => {
    const q: TraceEntry = {
      seq: 2,
      dir: "in",
      ts: 0,
      type: "queue_operation",
      payload: { operation: "enqueue" },
    };
    expect(summarize(q, "en")).toBe('{"operation":"enqueue"}');
  });
});

// Where the run stood, and when it moved (card 167, finding 8). The frame is
// import-only and it belongs beside the other four: the busiest transcript in
// the corpus stood in 16 different directories and carries 273 of these rows
// (measured 2026-08-04, `3e010de0…`), and a reader who
// wants the conversation must be able to put them away in one click.
describe("the ground row", () => {
  const ground = (payload: unknown): TraceEntry => ({
    seq: 1,
    dir: "in",
    ts: 0,
    type: "ground_info",
    payload,
  });

  it("sits in the client chip with the rest of what the file recorded", () => {
    expect(categoryOf("ground_info")).toBe("client");
  });

  it("reads the opening announcement as the ground itself", () => {
    expect(summarize(ground({ cwd: "/Users/x/repo", gitBranch: "main", version: "2.1.181" }), "en")).toBe(
      "cwd /Users/x/repo · gitBranch main · version 2.1.181",
    );
  });

  it("reads a move as what it left and what it landed on", () => {
    expect(summarize(ground({ cwd: "/Users/x/repo/wt", from: { cwd: "/Users/x/repo" } }), "en")).toBe(
      "cwd /Users/x/repo → /Users/x/repo/wt",
    );
  });

  it("names only the fields the frame carries", () => {
    expect(summarize(ground({ gitBranch: "feature", from: { gitBranch: "main" } }), "en")).toBe(
      "gitBranch main → feature",
    );
  });

  // The field names are the file's own words, so they are not translated: the
  // same rule recordMeta.ts labels its groups by.
  it("spells the fields the way the file spells them, in either language", () => {
    expect(summarize(ground({ cwd: "/a" }), "de")).toBe("cwd /a");
  });

  it("falls back to the raw frame when the payload says none of it", () => {
    expect(summarize(ground({ note: "x" }), "en")).toBe('{"note":"x"}');
  });
});
