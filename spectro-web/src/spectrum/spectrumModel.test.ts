import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { buildSpectrum, MAX_LANE_TICKS, MAX_LANE_THINKING } from "./spectrumModel";

// A small fleet run: main spawns a worker, the worker hits a gate, reports
// back, the run ends. Timestamps rise in steps of 100ms from t=1000.
const fleet: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "audit the repo", provider: "anthropic", ts: 1000 },
  { type: "thinking_delta", agentId: "main", text: "plan…", ts: 1100 },
  { type: "text_delta", agentId: "main", text: "ok", ts: 1200 },
  { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "scan files", ts: 1300 },
  { type: "agent_message", from: "main", to: "worker-1", role: "task", state: "submitted", text: "scan files", ts: 1350 },
  { type: "run_start", runId: "r2", agentId: "worker-1", parentId: "main", prompt: "scan files", ts: 1400 },
  { type: "tool_call", agentId: "worker-1", callId: "c1", name: "run_command", input: { cmd: "ls" }, ts: 1500 },
  { type: "permission_request", agentId: "worker-1", callId: "c1", name: "run_command", input: { cmd: "ls" }, ts: 1600 },
  { type: "permission_decision", callId: "c1", allowed: true, ts: 1700 },
  { type: "tool_result", agentId: "worker-1", callId: "c1", output: "ok", isError: false, durationMs: 5, ts: 1800 },
  { type: "agent_message", from: "worker-1", to: "main", role: "result", state: "completed", text: "done", ts: 1900 },
  { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 1950 },
  { type: "usage", agentId: "main", inputTokens: 100, outputTokens: 20, ts: 1980 },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2000 },
];

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

  it("thins dense token streams but never structural marks, and reports the drop", () => {
    const flood: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "p", ts: 1000 },
    ];
    for (let i = 0; i < MAX_LANE_TICKS + 800; i++) {
      flood.push({ type: "text_delta", agentId: "main", text: "x", ts: 1001 + i });
    }
    flood.push({ type: "tool_call", agentId: "main", callId: "c9", name: "read_file", input: {}, ts: 99000 });
    const m = buildSpectrum(flood);
    const lane = m.lanes[0];
    expect(lane.ticks.length).toBeLessThanOrEqual(MAX_LANE_TICKS);
    expect(lane.dropped).toBeGreaterThan(0);
    expect(lane.ticks.some((t) => t.kind === "tool")).toBe(true); // structural survived
    expect(m.totalEvents).toBe(flood.length);
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
