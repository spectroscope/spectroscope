import { describe, expect, it } from "vitest";
import { traceHits, traceRowText } from "./traceSearch";
import type { TraceHitRow } from "./traceSearch";

const BOTH_COLUMNS = { host: true, model: true };

const CALL = {
  proto: "SSE",
  host: "api.anthropic.com",
  model: "claude-opus-5",
  agentId: "worker-1",
  type: "tool_call",
  summary: 'read_file {"path":"a.txt"}',
};

describe("traceRowText", () => {
  it("reads the row left to right, words only", () => {
    expect(traceRowText(CALL, BOTH_COLUMNS)).toBe(
      'SSE api.anthropic.com claude-opus-5 worker-1 tool_call read_file {"path":"a.txt"}',
    );
  });

  it("leaves out a column the reader switched off", () => {
    expect(traceRowText(CALL, { host: false, model: true })).toBe(
      'SSE claude-opus-5 worker-1 tool_call read_file {"path":"a.txt"}',
    );
    expect(traceRowText(CALL, { host: true, model: false })).toBe(
      'SSE api.anthropic.com worker-1 tool_call read_file {"path":"a.txt"}',
    );
  });

  it("skips the cells a row leaves blank instead of searching a hole", () => {
    expect(traceRowText({ proto: "—", host: "—", type: "run_end", summary: "{}" }, BOTH_COLUMNS)).toBe(
      "— — run_end {}",
    );
  });
});

const ROWS: TraceHitRow[] = [
  { seq: 1, text: "SSE api.anthropic.com tool_call read_file", shown: true },
  { seq: 2, text: "local — tool_result ok · 12 ms", shown: false },
  { seq: 3, text: "SSE api.anthropic.com text_delta Read the file", shown: true },
];

describe("traceHits", () => {
  it("returns the shown rows that match, in row order", () => {
    expect(traceHits(ROWS, "read")).toEqual({ seqs: [1, 3], hidden: 0 });
  });

  it("matches case-insensitively and literally, like findRanges", () => {
    expect(traceHits(ROWS, "READ_FILE")).toEqual({ seqs: [1], hidden: 0 });
    // ".*" is two characters, not "everything".
    expect(traceHits(ROWS, ".*")).toEqual({ seqs: [], hidden: 0 });
  });

  it("counts the hits a filter is hiding rather than pretending they do not exist", () => {
    expect(traceHits(ROWS, "tool_result")).toEqual({ seqs: [], hidden: 1 });
    expect(traceHits(ROWS, "api.anthropic.com tool_call")).toEqual({ seqs: [1], hidden: 0 });
  });

  it("finds nothing for an empty or whitespace-only query", () => {
    expect(traceHits(ROWS, "")).toEqual({ seqs: [], hidden: 0 });
    expect(traceHits(ROWS, "   ")).toEqual({ seqs: [], hidden: 0 });
  });

  it("trims the query the way the store does, so a trailing space still finds", () => {
    expect(traceHits(ROWS, " read_file ")).toEqual({ seqs: [1], hidden: 0 });
  });
});
