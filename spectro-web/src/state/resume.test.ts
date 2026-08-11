// Session resume: the pure history sizing + the UI-only trace marker.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { LIVE_TRACE_WINDOW, initialState, recordResumeMarker, reduceAll } from "./reducer";
import { seedResumedLive, summarizeHistory } from "./resume";

const history: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "say test", ts: 1 },
  { type: "text_delta", agentId: "main", text: "OK then", ts: 2 },
  { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: { path: "a.txt" }, ts: 3 },
  {
    type: "tool_result",
    agentId: "main",
    callId: "c1",
    output: "hello",
    isError: false,
    durationMs: 5,
    ts: 4,
  },
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
      {
        type: "run_start",
        runId: "r2",
        agentId: "explore-1",
        parentId: "main",
        prompt: "scout",
        ts: 8,
      } as RunEvent,
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
      {
        type: "tool_call",
        agentId: "explore-1",
        callId: "c9",
        name: "grep",
        input: { pattern: "x" },
        ts: 10,
      },
      {
        type: "tool_result",
        agentId: "explore-1",
        callId: "c9",
        output: "many child hits",
        isError: false,
        durationMs: 2,
        ts: 11,
      },
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

describe("seedResumedLive — where a finished archive becomes an endless stream", () => {
  const deltas = (n: number): RunEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      type: "text_delta",
      agentId: "main",
      text: "x",
      ts: i,
    })) as RunEvent[];

  /** A resume as App builds it: the whole archive, then the marker on top. */
  const resumed = (n: number) =>
    recordResumeMarker(reduceAll(initialState, deltas(n)), { sessionId: "s1", events: n });

  it("bounds a history the live socket would otherwise append to forever", () => {
    const folded = resumed(6000);
    expect(folded.trace.length).toBe(6001); // the fold itself still keeps every row
    expect(folded.traceDropped).toBe(0);

    const seeded = seedResumedLive(folded);
    expect(seeded.trace.length).toBe(LIVE_TRACE_WINDOW);
    expect(seeded.traceDropped).toBe(6001 - LIVE_TRACE_WINDOW);
  });

  it("keeps the two signals from contradicting each other (card 116 AC 3)", () => {
    const seeded = seedResumedLive(resumed(6000));
    // The pane says "N dropped"; the first row on screen says which seq it
    // starts at. A reader who checks one against the other must not find a gap.
    // Spelled out rather than derived from traceDropped, because `1 === 0 + 1`
    // holds just as well on a seam that never cut anything.
    expect(seeded.traceDropped).toBe(1001);
    expect(seeded.trace[0].seq).toBe(1002);
  });

  it("keeps the resume marker, so the moment the history was picked up survives the cut", () => {
    const seeded = seedResumedLive(resumed(6000));
    const last = seeded.trace[seeded.trace.length - 1];
    expect(last.type).toBe("session_resume");
    // Its seq is untouched by the cut — the marker still names the 6001st frame
    // of the session, which is how a reader ties it back to the file.
    expect(last.seq).toBe(6001);
    expect(seeded.trace.length).toBe(LIVE_TRACE_WINDOW);
  });

  it("leaves a session that fits untouched, object for object", () => {
    const folded = resumed(10);
    expect(seedResumedLive(folded)).toBe(folded);
  });
});
