// Card 395, wave H1c: children who think at the same time.
//
// The live stream interleaves their deltas, and the chat used to open a new
// Thinking block whenever the speaker changed. The wave H1 browser check counted
// 1,113 to 2,751 blocks per child after a three-child spawn. These tests pin the
// rule that replaces it: an agent's delta joins that agent's open assistant
// turn, which is the agent's latest turn of any kind when that turn is an
// assistant turn. A tool call or a line of the agent's own ends the phase;
// another agent's turns do not. A user turn (a new prompt or a taken steering
// message) belongs to the root, so it ends the root's phase.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { Turn, UiState } from "./reducer";
import { initialState, liveThinkingTurns, reduce, reduceAll } from "./reducer";

const fanOut: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "fan out", ts: 1 },
  { type: "tool_call", agentId: "main", callId: "spawn", name: "spawn_agents", input: {}, ts: 2 },
  { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "a", ts: 3 },
  { type: "agent_spawn", agentId: "explore-2", parentId: "main", task: "b", ts: 4 },
  { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "a", ts: 5 },
  { type: "run_start", runId: "r3", agentId: "explore-2", parentId: "main", prompt: "b", ts: 6 },
];

let clock = 100;
const think = (agentId: string, text: string): RunEvent => ({
  type: "thinking_delta",
  agentId,
  text,
  ts: clock++,
});
const say = (agentId: string, text: string): RunEvent => ({ type: "text_delta", agentId, text, ts: clock++ });
const call = (agentId: string, callId: string): RunEvent => ({
  type: "tool_call",
  agentId,
  callId,
  name: "read_file",
  input: {},
  ts: clock++,
});

type AssistantTurn = Extract<Turn, { kind: "assistant" }>;

/** The flat list as [kind, text] pairs, an assistant turn as [kind, thinking, text]. */
function shape(state: UiState): string[][] {
  return state.turns.map((turn) =>
    turn.kind === "assistant"
      ? [turn.kind, turn.thinking, turn.text]
      : [turn.kind, "text" in turn ? turn.text : ""],
  );
}

/** An agent's assistant turns in order, each with its index in the flat list. */
function assistantTurnsOf(state: UiState, agentId: string): Array<AssistantTurn & { index: number }> {
  const out: Array<AssistantTurn & { index: number }> = [];
  state.turns.forEach((turn, index) => {
    if (turn.kind === "assistant" && turn.agentId === agentId) out.push({ ...turn, index });
  });
  return out;
}

describe("children thinking at once (card 395)", () => {
  it("keeps one thinking block per child, each child's text whole and in its own order", () => {
    const deltas: RunEvent[] = [];
    let a = "";
    let b = "";
    for (let i = 0; i < 50; i++) {
      deltas.push(think("explore-1", `a${i}|`), think("explore-2", `b${i}|`));
      a += `a${i}|`;
      b += `b${i}|`;
    }
    const before = reduceAll(initialState, fanOut);
    const state = reduceAll(before, deltas);

    expect(assistantTurnsOf(state, "explore-1").map((t) => [t.thinking, t.text])).toEqual([[a, ""]]);
    expect(assistantTurnsOf(state, "explore-2").map((t) => [t.thinking, t.text])).toEqual([[b, ""]]);
    // A hundred interleaved deltas add two turns, not a hundred.
    expect(state.turns.length).toBe(before.turns.length + 2);
  });

  it("joins a child's answer to the block its thinking opened, with the other child speaking in between", () => {
    const state = reduceAll(initialState, [
      ...fanOut,
      think("explore-1", "a-think "),
      think("explore-2", "b-think "),
      say("explore-1", "a-says "),
      think("explore-2", "more"),
      say("explore-1", "done"),
      say("explore-2", "b-says"),
    ]);
    expect(assistantTurnsOf(state, "explore-1").map((t) => [t.thinking, t.text])).toEqual([
      ["a-think ", "a-says done"],
    ]);
    expect(assistantTurnsOf(state, "explore-2").map((t) => [t.thinking, t.text])).toEqual([
      ["b-think more", "b-says"],
    ]);
  });

  it("ends a child's phase at its own tool call and not at another child's", () => {
    const state = reduceAll(initialState, [
      ...fanOut,
      think("explore-1", "a1"),
      think("explore-2", "b1"),
      call("explore-1", "k-a"),
      think("explore-2", "b2"),
      call("explore-2", "k-b"),
      think("explore-1", "a2"),
      think("explore-2", "b3"),
    ]);
    const a = assistantTurnsOf(state, "explore-1");
    const b = assistantTurnsOf(state, "explore-2");
    expect(a.map((t) => t.thinking)).toEqual(["a1", "a2"]);
    expect(b.map((t) => t.thinking)).toEqual(["b1b2", "b3"]);
    // Each second phase opens after its own agent's tool turn.
    const toolAt = (callId: string): number =>
      state.turns.findIndex((t) => t.kind === "tool" && t.callId === callId);
    expect(a[1].index).toBeGreaterThan(toolAt("k-a"));
    expect(b[1].index).toBeGreaterThan(toolAt("k-b"));
  });

  it("ends a child's phase at its own error line, and not at a line of the run's own", () => {
    const ownLine = reduceAll(initialState, [
      ...fanOut,
      think("explore-1", "a1"),
      { type: "error", agentId: "explore-1", message: "the child's backend failed", ts: clock++ },
      think("explore-1", "a2"),
    ]);
    expect(assistantTurnsOf(ownLine, "explore-1").map((t) => t.thinking)).toEqual(["a1", "a2"]);

    const rootLine = reduceAll(initialState, [
      ...fanOut,
      think("explore-1", "a1"),
      { type: "error", message: "the run's own failure", ts: clock++ },
      think("explore-1", "a2"),
    ]);
    expect(assistantTurnsOf(rootLine, "explore-1").map((t) => t.thinking)).toEqual(["a1a2"]);
  });

  it("keeps main's open block one block while a child's turn arrives in between", () => {
    const state = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 },
      think("main", "m1 "),
      { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "a", ts: clock++ },
      think("explore-1", "a1"),
      think("main", "m2"),
    ]);
    expect(assistantTurnsOf(state, "main").map((t) => t.thinking)).toEqual(["m1 m2"]);
    expect(assistantTurnsOf(state, "explore-1").map((t) => t.thinking)).toEqual(["a1"]);
  });

  it("opens a new block for main under the second prompt after a clean first run", () => {
    const state = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "first", ts: clock++ },
      think("main", "t1"),
      say("main", "answer1"),
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: clock++ },
      { type: "run_start", runId: "r2", agentId: "main", prompt: "second", ts: clock++ },
      think("main", "t2"),
      say("main", "answer2"),
    ]);
    expect(shape(state)).toEqual([
      ["user", "first"],
      ["assistant", "t1", "answer1"],
      ["user", "second"],
      ["assistant", "t2", "answer2"],
    ]);
  });

  it("opens a new block for main under a steering message the run took", () => {
    const state = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: clock++ },
      think("main", "t1"),
      say("main", "answer1"),
      { type: "steering_message", agentId: "main", text: "also this", taken: true, turn: 2, ts: clock++ },
      think("main", "t2"),
      say("main", "answer2"),
    ]);
    expect(shape(state)).toEqual([
      ["user", "go"],
      ["assistant", "t1", "answer1"],
      ["user", "also this"],
      ["assistant", "t2", "answer2"],
    ]);
  });

  it("ends main's phase at a line of the run's own, one with no agentId", () => {
    const state = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: clock++ },
      think("main", "t1"),
      { type: "error", message: "the run's own failure", ts: clock++ },
      think("main", "t2"),
    ]);
    expect(shape(state)).toEqual([
      ["user", "go"],
      ["assistant", "t1", ""],
      ["error", "the run's own failure"],
      ["assistant", "t2", ""],
    ]);
  });

  it("still opens a new block for main after its own tool call", () => {
    const state = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 },
      think("main", "before"),
      call("main", "k-main"),
      {
        type: "tool_result",
        agentId: "main",
        callId: "k-main",
        output: "ok",
        isError: false,
        durationMs: 1,
        ts: clock++,
      },
      think("main", "after"),
    ]);
    expect(assistantTurnsOf(state, "main").map((t) => t.thinking)).toEqual(["before", "after"]);
  });
});

describe("the live thinking marker per agent (card 395)", () => {
  const twoThinking = (): UiState =>
    reduceAll(initialState, [
      ...fanOut,
      think("explore-1", "a1"),
      think("explore-2", "b1"),
      think("explore-1", "a2"),
    ]);
  const openIndex = (state: UiState, agentId: string): number => {
    const turns = assistantTurnsOf(state, agentId);
    return turns[turns.length - 1].index;
  };

  it("marks the open block of every child that is thinking, not only the last turn's", () => {
    const state = twoThinking();
    expect([...liveThinkingTurns(state)].sort((x, y) => x - y)).toEqual([
      openIndex(state, "explore-1"),
      openIndex(state, "explore-2"),
    ]);
  });

  it("drops a child when its answer starts or it calls a tool, and keeps the other", () => {
    const answered = reduce(twoThinking(), say("explore-1", "answer"));
    expect([...liveThinkingTurns(answered)]).toEqual([openIndex(answered, "explore-2")]);
    expect(answered.thinkingAgents).toEqual(["explore-2"]);

    // The tool turn alone would hide the mark, since the child's latest turn is
    // no longer an assistant turn; the list itself has to drop the child too.
    const calling = reduce(twoThinking(), call("explore-2", "k-b"));
    expect([...liveThinkingTurns(calling)]).toEqual([openIndex(calling, "explore-1")]);
    expect(calling.thinkingAgents).toEqual(["explore-1"]);
  });

  it("drops a child at its own run_end and everyone at the root's", () => {
    const childEnded = reduce(twoThinking(), {
      type: "run_end",
      runId: "r2",
      stopReason: "aborted",
      ts: clock++,
    });
    expect([...liveThinkingTurns(childEnded)]).toEqual([openIndex(childEnded, "explore-2")]);
    expect(childEnded.thinkingAgents).toEqual(["explore-2"]);

    const rootEnded = reduce(twoThinking(), {
      type: "run_end",
      runId: "r1",
      stopReason: "aborted",
      ts: clock++,
    });
    expect(liveThinkingTurns(rootEnded).size).toBe(0);
    expect(rootEnded.thinkingAgents).toEqual([]);
  });

  it("marks main's block alone the way the single-agent chat always did", () => {
    const thinking = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 1 },
      think("main", "hmm"),
    ]);
    expect([...liveThinkingTurns(thinking)]).toEqual([thinking.turns.length - 1]);
    expect(liveThinkingTurns(reduce(thinking, say("main", "42"))).size).toBe(0);
  });
});
