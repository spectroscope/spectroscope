// Session resume: the pure history sizing + the UI-only trace marker.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, recordResumeMarker, reduceAll } from "./reducer";
import { summarizeHistory } from "./resume";

const history: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "say test", ts: 1 },
  { type: "text_delta", agentId: "main", text: "OK then", ts: 2 },
  { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "a.txt" }, ts: 3 },
  { type: "tool_result", agentId: "main", callId: "c1", output: "hello", isError: false, durationMs: 5, ts: 4 },
  // never re-enters the provider history -> must not count towards the re-upload
  { type: "thinking_delta", agentId: "main", text: "xxxxxxxxxxxxxxxxxxxx", ts: 5 },
  { type: "usage", agentId: "main", inputTokens: 10, outputTokens: 5, ts: 6 },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 7 },
] as RunEvent[];

describe("summarizeHistory", () => {
  it("counts events, prompts and provider-visible chars (thinking excluded)", () => {
    const s = summarizeHistory(history);
    expect(s.events).toBe(7);
    expect(s.prompts).toBe(1);
    // "say test"(8) + "OK then"(7) + "read_file"(9) + {"path":"a.txt"}(17) + "hello"(5)
    expect(s.approxChars).toBe(8 + 7 + 9 + JSON.stringify({ path: "a.txt" }).length + 5);
    expect(s.estTokens).toBe(Math.round(s.approxChars / 4));
  });

  it("ignores subagent run_starts when counting prompts", () => {
    const withChild: RunEvent[] = [
      ...history,
      { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "scout", ts: 8 } as RunEvent,
    ];
    expect(summarizeHistory(withChild).prompts).toBe(1);
  });

  it("excludes a subagent's deltas and tool i/o — only main re-enters the history", () => {
    // Mirrors loadSession: the child's inner steps never ride back up; the
    // parent sees the child only through its own tool_result (counted above).
    const withChildWork: RunEvent[] = [
      ...history,
      { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "scout", ts: 8 },
      { type: "text_delta", agentId: "explore-1", text: "a very long child answer", ts: 9 },
      { type: "tool_call", agentId: "explore-1", callId: "c9", name: "grep", input: { pattern: "x" }, ts: 10 },
      { type: "tool_result", agentId: "explore-1", callId: "c9", output: "many child hits", isError: false, durationMs: 2, ts: 11 },
    ] as RunEvent[];
    expect(summarizeHistory(withChildWork).approxChars).toBe(summarizeHistory(history).approxChars);
  });
});

describe("recordResumeMarker", () => {
  it("appends a dir-out session_resume trace row AFTER the folded history", () => {
    const seeded = reduceAll(initialState, history);
    const marked = recordResumeMarker(seeded, { sessionId: "s1", events: 7 });
    const last = marked.trace[marked.trace.length - 1];
    expect(last.type).toBe("session_resume");
    expect(last.dir).toBe("out");
    expect(last.payload).toEqual({ sessionId: "s1", events: 7 });
    expect(marked.trace.length).toBe(seeded.trace.length + 1);
  });
});
