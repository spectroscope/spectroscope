import { beforeEach, describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll } from "./reducer";
import {
  __getState,
  __resetForTests,
  backToLive,
  loadReplay,
  pushLive,
  reset,
  resetLive,
  setGrain,
  setMode,
  setSpeed,
  step,
  stepBack,
} from "./stepper";

const T = 1700000000000;

const run: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: T } as RunEvent,
  { type: "turn_start", agentId: "main", turn: 1, ts: T } as RunEvent,
  { type: "text_delta", agentId: "main", text: "Hel", ts: T } as RunEvent,
  { type: "text_delta", agentId: "main", text: "lo", ts: T } as RunEvent,
  { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: {}, ts: T } as RunEvent,
  { type: "tool_result", agentId: "main", callId: "c1", output: "x", isError: false, durationMs: 1, ts: T } as RunEvent,
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T } as RunEvent,
];

beforeEach(() => __resetForTests());

describe("stepper", () => {
  it("queues live events behind the dam in step mode", () => {
    pushLive(run);
    const s = __getState();
    expect(s.queue).toHaveLength(run.length);
    expect(s.applied).toHaveLength(0);
    expect(s.ui).toEqual(initialState);
  });

  it("fine grain applies exactly one event per step", () => {
    pushLive(run);
    setGrain("fine");
    step();
    const s = __getState();
    expect(s.applied).toHaveLength(1);
    expect(s.queue).toHaveLength(run.length - 1);
    expect(s.marking.llm).toBe(1);
  });

  it("block grain: a text run is ONE step, the next station event is the NEXT step", () => {
    pushLive(run);
    // blocks (default): run_start | turn_start | [2 text deltas] | tool_call | ...
    step(); // run_start
    step(); // turn_start
    step(); // the whole text run in ONE click — nothing more
    let s = __getState();
    expect(s.applied.map((e) => e.type)).toEqual([
      "run_start",
      "turn_start",
      "text_delta",
      "text_delta",
    ]);
    step(); // tool_call is its own step
    s = __getState();
    expect(s.applied[s.applied.length - 1].type).toBe("tool_call");
    expect(s.marking.tool).toBe(1);
  });

  it("block grain: thinking and answer are SEPARATE steps", () => {
    const T2 = T + 1;
    pushLive([
      { type: "run_start", runId: "r2", agentId: "main", prompt: "hi", ts: T2 } as RunEvent,
      { type: "thinking_delta", agentId: "main", text: "hm", ts: T2 } as RunEvent,
      { type: "thinking_delta", agentId: "main", text: "…", ts: T2 } as RunEvent,
      { type: "text_delta", agentId: "main", text: "Hello", ts: T2 } as RunEvent,
      { type: "text_delta", agentId: "main", text: "!", ts: T2 } as RunEvent,
    ]);
    step(); // run_start
    step(); // the thinking run ONLY
    expect(__getState().applied.map((e) => e.type)).toEqual([
      "run_start",
      "thinking_delta",
      "thinking_delta",
    ]);
    step(); // the answer run
    expect(__getState().applied.map((e) => e.type)).toEqual([
      "run_start",
      "thinking_delta",
      "thinking_delta",
      "text_delta",
      "text_delta",
    ]);
  });

  it("the stepped ui always equals reduceAll(initialState, applied)", () => {
    pushLive(run);
    step();
    step();
    const s = __getState();
    expect(s.ui).toEqual(reduceAll(initialState, s.applied));
  });

  it("flow mode does NOT drain on its own — a timer drives stepping at a pace", () => {
    pushLive(run.slice(0, 3));
    setMode("flow"); // no longer teleports to the end
    expect(__getState().queue).toHaveLength(3);
    expect(__getState().applied).toHaveLength(0);
    pushLive(run.slice(3)); // live events keep queueing while in flow
    expect(__getState().queue).toHaveLength(run.length);
    // the caller's timer calls step(); flow steps just like manual stepping
    step();
    expect(__getState().applied.length).toBeGreaterThan(0);
  });

  it("setSpeed sets the auto-play interval and clamps to a sane range", () => {
    expect(__getState().intervalMs).toBe(1250); // default pace: 0.8 steps/s
    setSpeed(120);
    expect(__getState().intervalMs).toBe(120);
    setSpeed(5); // too fast → clamped
    expect(__getState().intervalMs).toBe(60);
    setSpeed(99999); // too slow → clamped
    expect(__getState().intervalMs).toBe(2000);
  });

  it("folds the System-Map scene alongside the Petri marking", () => {
    pushLive(run);
    setGrain("fine");
    step(); // run_start
    expect(__getState().scene.focus).toBe("agent");
    for (let i = 0; i < 4; i++) step(); // turn_start, 2 deltas, tool_call(read_file)
    expect(__getState().scene.disk).toBe("read");
    expect(__getState().scene.activeTool).toBe("read_file");
  });

  it("stepBack undoes the last step and re-folds ui, marking and scene", () => {
    pushLive(run);
    setGrain("fine");
    step(); // run_start
    step(); // turn_start
    const applied2 = __getState().applied.length;
    step(); // text_delta "Hel"
    expect(__getState().applied.length).toBe(applied2 + 1);
    stepBack();
    const s = __getState();
    expect(s.applied.length).toBe(applied2); // back to before the delta
    expect(s.queue).toHaveLength(run.length - applied2); // the event went back in front
    expect(s.ui).toEqual(reduceAll(initialState, s.applied)); // chat re-folded from scratch
    expect(s.scene.focus).toBe("llm"); // turn_start focus, delta undone
  });

  it("stepBack mirrors a block step's size (the whole delta run)", () => {
    pushLive(run); // blocks default
    step(); // run_start
    step(); // turn_start
    step(); // the 2-delta text run in ONE block step
    expect(__getState().applied.map((e) => e.type)).toEqual([
      "run_start",
      "turn_start",
      "text_delta",
      "text_delta",
    ]);
    stepBack(); // must undo the whole block
    const s = __getState();
    expect(s.applied.map((e) => e.type)).toEqual(["run_start", "turn_start"]);
  });

  it("stepBack on an empty applied list is a no-op", () => {
    pushLive(run);
    const before = __getState();
    stepBack();
    expect(__getState()).toBe(before);
  });

  it("reset re-steps the same source from zero", () => {
    pushLive(run);
    step();
    step();
    reset();
    const s = __getState();
    expect(s.applied).toHaveLength(0);
    expect(s.queue).toHaveLength(run.length); // applied went back in front
    expect(s.ui).toEqual(initialState);
    expect(s.marking.user).toBe(1);
  });

  it("loadReplay switches the source and ignores live pushes; backToLive returns", () => {
    loadReplay("s-42", run);
    expect(__getState().source).toEqual({ replayId: "s-42" });
    pushLive([run[0]]); // live noise while replaying — ignored
    expect(__getState().queue).toHaveLength(run.length);
    step();
    backToLive(run.slice(0, 2)); // App hands over its raw live list
    const s = __getState();
    expect(s.source).toBe("live");
    expect(s.queue).toHaveLength(2);
    expect(s.applied).toHaveLength(0);
  });

  it("resetLive clears everything for a new chat", () => {
    pushLive(run);
    step();
    resetLive();
    const s = __getState();
    expect(s.queue).toHaveLength(0);
    expect(s.applied).toHaveLength(0);
    expect(s.ui).toEqual(initialState);
  });

  it("step on an empty queue is a no-op", () => {
    const before = __getState();
    step();
    expect(__getState()).toBe(before); // same object — nothing emitted/changed
  });
});
