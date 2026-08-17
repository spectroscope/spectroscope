import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildSpectrum, MAX_LANE_THINKING } from "./spectrumModel";
import { sliceLane } from "./laneSlice";
import { fit } from "./viewport";

// A small fleet run: main spawns a worker, the worker hits a gate, reports
// back, the run ends. Timestamps rise in steps of 100ms from t=1000.
const fleet: RunEvent[] = [
  {
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "audit the repo",
    provider: "anthropic",
    ts: 1000,
  },
  { type: "thinking_delta", agentId: "main", text: "plan…", ts: 1100 },
  { type: "text_delta", agentId: "main", text: "ok", ts: 1200 },
  { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "scan files", ts: 1300 },
  {
    type: "agent_message",
    from: "main",
    to: "worker-1",
    role: "task",
    state: "submitted",
    text: "scan files",
    ts: 1350,
  },
  { type: "run_start", runId: "r2", agentId: "worker-1", parentId: "main", prompt: "scan files", ts: 1400 },
  {
    type: "tool_call",
    agentId: "worker-1",
    callId: "c1",
    name: "run_command",
    input: { cmd: "ls" },
    ts: 1500,
  },
  {
    type: "permission_request",
    agentId: "worker-1",
    callId: "c1",
    name: "run_command",
    input: { cmd: "ls" },
    ts: 1600,
  },
  { type: "permission_decision", callId: "c1", allowed: true, ts: 1700 },
  {
    type: "tool_result",
    agentId: "worker-1",
    callId: "c1",
    output: "ok",
    isError: false,
    durationMs: 5,
    ts: 1800,
  },
  {
    type: "agent_message",
    from: "worker-1",
    to: "main",
    role: "result",
    state: "completed",
    text: "done",
    ts: 1900,
  },
  { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 1950 },
  { type: "usage", agentId: "main", inputTokens: 100, outputTokens: 20, ts: 1980 },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2000 },
];

describe("buildSpectrum reasoning divider", () => {
  it("divides distinct reasoning segments so the aggregated thinking is not one blob", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts: 1000 },
      { type: "thinking_delta", agentId: "main", text: "First, ", ts: 1100 },
      { type: "thinking_delta", agentId: "main", text: "I plan.", ts: 1150 }, // continuous → no divider
      { type: "text_delta", agentId: "main", text: "working", ts: 1200 },
      { type: "thinking_delta", agentId: "main", text: "Now I verify.", ts: 1300 }, // resumed → divider
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 1400 },
    ];
    const main = buildSpectrum(events).lanes[0];
    expect(main.thinking).toBe("First, I plan.\n\n———\n\nNow I verify.");
    expect(main.thinking).not.toContain("First, ———"); // no divider WITHIN a segment
  });
});

describe("buildSpectrum", () => {
  it("folds one lane per agent, in first-seen order", () => {
    const m = buildSpectrum(fleet);
    expect(m.lanes.map((l) => l.id)).toEqual(["main", "worker-1"]);
    expect(m.lanes[0].parentId).toBeNull();
    expect(m.lanes[1].parentId).toBe("main");
    expect(m.lanes[0].task).toBe("audit the repo");
    expect(m.lanes[1].task).toBe("scan files");
  });

  it("tracks lane state, tokens and the time domain", () => {
    const m = buildSpectrum(fleet);
    expect(m.running).toBe(false);
    expect(m.t0).toBe(1000);
    expect(m.t1).toBe(2000);
    expect(m.lanes[0].state).toBe("completed");
    expect(m.lanes[1].state).toBe("completed"); // the result message decides
    expect(m.lanes[0].inTokens).toBe(100);
    expect(m.lanes[0].outTokens).toBe(20);
  });

  it("normalizes tick positions into 0..1 and keeps kinds discrete", () => {
    const m = buildSpectrum(fleet);
    const main = m.lanes[0];
    for (const t of main.ticks) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(1);
    }
    expect(main.ticks.some((t) => t.kind === "reasoning")).toBe(true);
    expect(main.ticks.some((t) => t.kind === "token")).toBe(true);
    expect(main.ticks.some((t) => t.kind === "subagent")).toBe(true); // the spawn mark
  });

  it("keeps a decided gate un-pending and records the outcome", () => {
    const m = buildSpectrum(fleet);
    const worker = m.lanes[1];
    const gates = worker.ticks.filter((t) => t.kind === "gate");
    expect(gates).toHaveLength(2); // request + decision
    expect(gates[0].pending).toBe(false);
    expect(gates[1].allowed).toBe(true);
    expect(worker.pendingGate).toBe(false);
  });

  it("marks an undecided request as the pending violet line", () => {
    const open = fleet.slice(0, 8); // ends right after permission_request
    const m = buildSpectrum(open);
    const worker = m.lanes[1];
    expect(worker.pendingGate).toBe(true);
    expect(worker.ticks.find((t) => t.kind === "gate")?.pending).toBe(true);
    expect(m.running).toBe(true); // root run never ended in this slice
  });

  // Card 265 / concept §3.5, leg 26: "the lane carries pendingAsk; the tick
  // appears". The gate had both since the Spectrum shipped; the ask arrived with
  // neither, so the one view built to show a whole fleet at once could not show
  // the only state in which a run needs a person.
  const question: RunEvent = {
    type: "question_asked",
    agentId: "worker-1",
    callId: "q1",
    questions: [{ question: "Which store?", multiSelect: false, options: [{ label: "Postgres" }] }],
    ts: 1650,
  } as unknown as RunEvent;

  it("puts an ask tick on the lane and flags the lane as waiting on a person", () => {
    const asked = [...fleet.slice(0, 8), question];
    const worker = buildSpectrum(asked).lanes[1];
    const asks = worker.ticks.filter((t) => t.kind === "ask");
    expect(asks).toHaveLength(1);
    expect(asks[0].pending).toBe(true);
    expect(worker.pendingAsk).toBe(true);
  });

  it("keeps the ask apart from the gate, both ways", () => {
    // Two waits, two flags. A gate is a yes/no on a side effect and has a verdict
    // to report; a question has none, and the two bars are two components on
    // purpose. One flag standing in for both would raise the wrong one.
    const openGate = buildSpectrum(fleet.slice(0, 8)).lanes[1];
    expect(openGate.pendingGate).toBe(true);
    expect(openGate.pendingAsk).toBe(false);

    const openAsk = buildSpectrum([...fleet.slice(0, 7), question]).lanes[1];
    expect(openAsk.pendingAsk).toBe(true);
    expect(openAsk.pendingGate).toBe(false);
  });

  it("clears the lane and marks the tick once the answer lands", () => {
    const answered = [
      ...fleet.slice(0, 8),
      question,
      { type: "question_answered", callId: "q1", answers: ["Postgres"], cancelled: false, ts: 1700 },
    ] as unknown as RunEvent[];
    const worker = buildSpectrum(answered).lanes[1];
    expect(worker.pendingAsk).toBe(false);
    const asks = worker.ticks.filter((t) => t.kind === "ask");
    expect(asks).toHaveLength(2); // the question and the answer
    expect(asks[0].pending).toBe(false);
  });

  it("stops claiming a wait when the question was released without an answer", () => {
    const released = [
      ...fleet.slice(0, 8),
      question,
      { type: "question_answered", callId: "q1", answers: [], cancelled: true, ts: 1700 },
    ] as unknown as RunEvent[];
    expect(buildSpectrum(released).lanes[1].pendingAsk).toBe(false);
  });

  it("keeps every mark: density is a question for the viewport, not for the fold", () => {
    // The old fold deleted the dense channels wholesale past a fixed budget, so
    // a long imported session lost its whole reasoning channel while the legend
    // kept drawing a swatch for it. Memory was never the constraint here (a few
    // thousand small objects); render cost was, and that belongs to whatever is
    // actually on screen.
    const flood: RunEvent[] = [{ type: "run_start", runId: "r1", agentId: "main", prompt: "p", ts: 1000 }];
    for (let i = 0; i < 2000; i++) {
      flood.push({ type: "text_delta", agentId: "main", text: "x", ts: 1001 + i });
    }
    for (let i = 0; i < 2000; i++) {
      flood.push({ type: "thinking_delta", agentId: "main", text: "y", ts: 3001 + i });
    }
    flood.push({ type: "tool_call", agentId: "main", callId: "c9", name: "read_file", input: {}, ts: 99000 });
    const lane = buildSpectrum(flood).lanes[0];
    expect(lane.ticks.filter((t) => t.kind === "token")).toHaveLength(2000);
    expect(lane.ticks.filter((t) => t.kind === "reasoning")).toHaveLength(2000);
    expect(lane.ticks.some((t) => t.kind === "tool")).toBe(true);
    expect("dropped" in lane).toBe(false); // the fold no longer has an opinion
  });

  it("emits ticks sorted by x, with seq breaking a tie", () => {
    // Imported transcripts are not always monotonic, and the slicer reaches for
    // the visible range with a binary search, so sorted is a precondition and
    // not a happy accident of event order.
    const outOfOrder: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "p", ts: 1000 },
      { type: "text_delta", agentId: "main", text: "late", ts: 3000 },
      { type: "text_delta", agentId: "main", text: "early", ts: 2000 },
      { type: "text_delta", agentId: "main", text: "tied", ts: 2000 },
    ];
    const ticks = buildSpectrum(outOfOrder).lanes[0].ticks;
    const xs = ticks.map((t) => t.x);
    expect(xs).toEqual([...xs].sort((p, q) => p - q));
    const tied = ticks.filter((t) => t.x === 0.5).map((t) => t.seq);
    expect(tied).toEqual([2, 3]); // same instant: the earlier event still leads
  });

  it("clamps a frame with no timestamp into the domain instead of off the band", () => {
    const m = buildSpectrum([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1000 },
      { type: "text_delta", agentId: "main", text: "x" } as unknown as RunEvent,
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2000 },
    ]);
    for (const t of m.lanes[0].ticks) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThanOrEqual(1);
    }
  });

  it("pins what the band draws at full extent: the fold and the slice agree", () => {
    // Read this for what it says. This fixture's five marks sit at 0, 0.1, 0.2,
    // 0.3 and 1 of the axis, so at 1000 columns no two of them can meet: the
    // slice is the identity here because the arithmetic leaves it no choice.
    //
    // It is NOT a promise that the band renders what it rendered before marks
    // were thinned per column. It does not: on a real store that changed for 55
    // of 147 sessions, and the busiest lane went from 826 rects to 39. What this
    // pins is the sparse case, that a lane with room on screen is left alone.
    // The rule itself is pinned by exact counts in laneSlice.test.ts, and that
    // nothing became unreachable is pinned in bandScrub.test.ts.
    const m = buildSpectrum(fleet);
    for (const lane of m.lanes) {
      const { marks, hidden } = sliceLane(lane.ticks, fit(), 1000);
      expect(marks).toEqual(lane.ticks);
      expect(hidden).toBe(0);
    }
    expect(m.lanes[0].ticks.map((t) => t.kind)).toEqual([
      "lifecycle", // run_start
      "reasoning", // thinking_delta
      "token", // text_delta
      "subagent", // the spawn, marked on the PARENT
      "lifecycle", // run_end
    ]);
    expect(m.lanes[0].ticks.map((t) => t.x)).toEqual([0, 0.1, 0.2, 0.3, 1]);
  });

  it("stays calm on an empty stream", () => {
    const m = buildSpectrum([]);
    expect(m.lanes).toEqual([]);
    expect(m.running).toBe(false);
    expect(m.t0).toBe(m.t1);
  });
});

describe("lane thinking pass-through", () => {
  it("threads thinking_delta text into the lane, not only a tick", () => {
    const m = buildSpectrum([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1000 },
      { type: "thinking_delta", agentId: "main", text: "first I will ", ts: 1100 },
      { type: "thinking_delta", agentId: "main", text: "read the files", ts: 1200 },
    ]);
    expect(m.lanes[0].thinking).toBe("first I will read the files");
    // The tick survives — the timeline mark is not replaced by the text.
    expect(m.lanes[0].ticks.some((t) => t.kind === "reasoning")).toBe(true);
  });

  it("bounds the buffer to the latest MAX_LANE_THINKING chars", () => {
    const big = "x".repeat(MAX_LANE_THINKING + 500);
    const m = buildSpectrum([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1000 },
      { type: "thinking_delta", agentId: "main", text: big + "TAIL", ts: 1100 },
    ]);
    expect(m.lanes[0].thinking.length).toBe(MAX_LANE_THINKING);
    expect(m.lanes[0].thinking.endsWith("TAIL")).toBe(true); // latest wins: the tail is kept
  });

  it("is empty for a lane that never reasons", () => {
    const m = buildSpectrum([
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1000 },
      { type: "text_delta", agentId: "main", text: "answer", ts: 1100 },
    ]);
    expect(m.lanes[0].thinking).toBe("");
  });
});
