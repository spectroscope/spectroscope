// Card 586: how the wide run view asks for a run's graph file.
//
// The hook itself needs effects, which the server renderer does not run; its
// two halves are pure and tested here: what to ask (runGraphAsk) and how
// often (pollRunGraph).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunTrack } from "./runView";
import { pollRunGraph, runGraphAsk } from "./useRunGraph";

const run = (over: Partial<RunTrack> = {}): RunTrack => ({
  runId: "aaaaaaaaaaaa",
  kind: "playbook",
  name: "spectro",
  task: null,
  nodes: [],
  startedTs: 1,
  endedTs: null,
  durationMs: null,
  stopReason: null,
  result: null,
  detail: null,
  waitingOn: null,
  entries: [],
  ...over,
});

describe("what the wide view asks for (card 586)", () => {
  it("asks a playbook run's graph and polls while the run has no end and the session is live", () => {
    expect(runGraphAsk("s-1", run(), true)).toEqual({ sessionId: "s-1", runId: "aaaaaaaaaaaa", poll: true });
  });

  it("asks once for an ended run, and once for a run of a session that is not live", () => {
    expect(runGraphAsk("s-1", run({ endedTs: 9 }), true)?.poll).toBe(false);
    expect(runGraphAsk("s-1", run(), false)?.poll).toBe(false);
  });

  it("asks nothing for a workflow run, without a run, or without a session", () => {
    expect(runGraphAsk("s-1", run({ kind: "workflow" }), true)).toBeNull();
    expect(runGraphAsk("s-1", null, true)).toBeNull();
    expect(runGraphAsk(null, run(), true)).toBeNull();
  });
});

describe("how often it asks (card 586)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once at once, then every 1000 ms while it polls, and stops when told", async () => {
    const load = vi.fn(async () => "graph");
    const seen: string[] = [];
    const stop = pollRunGraph(load, true, (t) => seen.push(t));
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(load).toHaveBeenCalledTimes(4);
    expect(seen).toEqual(["graph", "graph", "graph", "graph"]);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it("asks once and never again when it does not poll", async () => {
    const load = vi.fn(async () => "graph");
    const seen: string[] = [];
    pollRunGraph(load, false, (t) => seen.push(t));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(load).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(["graph"]);
  });

  it("drops an answer that arrives after it was stopped", async () => {
    let answer: (t: string) => void = () => {};
    const load = vi.fn(() => new Promise<string>((resolve) => (answer = resolve)));
    const seen: string[] = [];
    const stop = pollRunGraph(load, false, (t) => seen.push(t));
    stop();
    answer("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([]);
  });
});
