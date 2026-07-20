// Trace detail modes: one wire line per frame; session_resume = the whole
// history as JSONL lines; raw/compact text is line-identical.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { detailLines, detailText } from "./traceDetail";

const history = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
  { type: "text_delta", agentId: "main", text: "line1\nline2", ts: 2 },
] as RunEvent[];

describe("detailLines", () => {
  it("renders an ordinary frame as exactly one line", () => {
    const lines = detailLines("tool_call", { name: "read_file", input: { path: "a" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('{"name":"read_file","input":{"path":"a"}}');
  });

  it("renders session_resume as one JSONL line per history event", () => {
    const lines = detailLines("session_resume", { sessionId: "s", history });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"type":"run_start"');
    // real newlines inside a field stay escaped - the line is ONE wire line
    expect(lines[1]).toContain('\\n');
    expect(lines[1].includes("\n")).toBe(false);
  });

  it("falls back to the plain payload when session_resume has no history", () => {
    expect(detailLines("session_resume", { sessionId: "s" })).toHaveLength(1);
  });
});

describe("detailText", () => {
  it("joins compact/raw lines with real newlines and pretty-prints insight", () => {
    const payload = { sessionId: "s", history };
    expect(detailText("raw", "session_resume", payload).split("\n")).toHaveLength(2);
    expect(detailText("compact", "session_resume", payload)).toBe(
      detailText("raw", "session_resume", payload),
    );
    expect(detailText("insight", "session_resume", payload)).toContain("\n  ");
  });
});
