import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { Turn, UiState } from "./reducer";
import { initialState, reduce, reduceAll } from "./reducer";

// Card 414: a model turn that writes no text (a tool call alone) reported its
// usage onto the answer above it. Where a test puts text and a tool call in ONE
// model turn, it sends them in the order the three providers produce: text
// deltas, then tool calls, then the turn's single usage (Ollama,
// OpenAI-compatible and Anthropic each add their one PUsage after the tool
// calls, and Agent.java passes the events on in that order).

type Answer = Extract<Turn, { kind: "assistant" }>;

const answers = (s: UiState): Answer[] => s.turns.filter((t): t is Answer => t.kind === "assistant");

const runStart = (runId: string, prompt: string, ts: number): RunEvent => ({
  type: "run_start",
  runId,
  agentId: "main",
  prompt,
  provider: "ollama",
  ts,
});

const usage = (inputTokens: number, outputTokens: number, ts: number, agentId = "main"): RunEvent => ({
  type: "usage",
  agentId,
  inputTokens,
  outputTokens,
  ts,
});

const toolCall = (callId: string, ts: number, agentId = "main"): RunEvent => ({
  type: "tool_call",
  agentId,
  callId,
  name: "run_command",
  input: { command: "ls -la" },
  ts,
});

const toolResult = (callId: string, ts: number, agentId = "main"): RunEvent => ({
  type: "tool_result",
  agentId,
  callId,
  output: "total 0",
  isError: false,
  durationMs: 5,
  ts,
});

describe("card 414: a text-less turn does not restamp the answer above it", () => {
  it("criterion 1 and 2: the tool-call turn's usage leaves the first answer's usage, duration and end time as its own usage set them", () => {
    const answered = reduceAll(initialState, [
      runStart("r1", "hello", 1000),
      { type: "text_delta", agentId: "main", text: "Hello there.", ts: 1100 },
      usage(7498, 84, 2600),
    ]);
    const first = answers(answered)[0];
    expect(first.usage).toEqual({ inputTokens: 7498, outputTokens: 84 });
    expect(first.durationMs).toBe(1500);
    expect(first.endTs).toBe(2600);

    const after = reduceAll(answered, [toolCall("c1", 13_000), usage(900, 12, 13_100)]);
    const same = answers(after)[0];
    expect(same.usage).toEqual({ inputTokens: 7498, outputTokens: 84 });
    expect(same.durationMs).toBe(1500);
    expect(same.endTs).toBe(2600);
  });

  it("criterion 3: the text-less usage adds to both run totals and changes no turn at all", () => {
    const before = reduceAll(initialState, [
      runStart("r1", "hello", 1000),
      { type: "text_delta", agentId: "main", text: "Hello there.", ts: 1100 },
      usage(7498, 84, 2600),
      toolCall("c1", 13_000),
    ]);
    const after = reduce(before, usage(900, 12, 13_100));

    expect(after.usage).toEqual({ inputTokens: 7498 + 900, outputTokens: 84 + 12 });
    expect(after.runUsage).toEqual({ inputTokens: 7498 + 900, outputTokens: 84 + 12 });
    // No line of its own and no change to an existing footer: the turn list is
    // the very same list the tool call left.
    expect(after.turns).toBe(before.turns);
    expect(after.turns).toHaveLength(2 + 1); // prompt, answer, tool call
  });

  it("the browser's shape: a second prompt that only runs a tool leaves the first run's answer line alone, and its own answer gets its own line", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "hello", 1000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 1050 },
      { type: "text_delta", agentId: "main", text: "Hello there.", ts: 1100 },
      usage(7498, 84, 2600),
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2700 },
      runStart("r2", "rtk-ls", 12_000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 12_050 },
      toolCall("c1", 13_000),
      usage(900, 12, 13_100),
      toolResult("c1", 14_000),
      { type: "turn_start", agentId: "main", turn: 2, ts: 14_050 },
      { type: "text_delta", agentId: "main", text: "One file.", ts: 14_200 },
      usage(950, 5, 14_900),
      { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 15_000 },
    ]);
    const [first, second] = answers(s);
    expect(first.usage).toEqual({ inputTokens: 7498, outputTokens: 84 });
    expect(first.durationMs).toBe(1500);
    expect(first.endTs).toBe(2600);
    expect(second.usage).toEqual({ inputTokens: 950, outputTokens: 5 });
    expect(second.durationMs).toBe(700);
    expect(second.endTs).toBe(14_900);
    expect(s.usage).toEqual({ inputTokens: 7498 + 900 + 950, outputTokens: 84 + 12 + 5 });
    expect(s.runUsage).toEqual({ inputTokens: 900 + 950, outputTokens: 12 + 5 });
  });

  it("criterion 4, usage before the tool call: two answers each keep their own usage", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "text_delta", agentId: "main", text: "First.", ts: 1100 },
      usage(100, 10, 1200),
      toolCall("c1", 1300),
      toolResult("c1", 1400),
      { type: "text_delta", agentId: "main", text: "Second.", ts: 1500 },
      usage(200, 20, 1700),
    ]);
    const [first, second] = answers(s);
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(first.endTs).toBe(1200);
    expect(second.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(second.endTs).toBe(1700);
  });

  it("criterion 4, usage after the tool call (the wire's own order): an answer that also called a tool keeps its usage, and so does the next answer", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 1050 },
      { type: "text_delta", agentId: "main", text: "Let me list the files.", ts: 1100 },
      toolCall("c1", 1150),
      usage(100, 10, 1200),
      toolResult("c1", 1400),
      { type: "turn_start", agentId: "main", turn: 2, ts: 1450 },
      { type: "text_delta", agentId: "main", text: "Now the second file.", ts: 1500 },
      toolCall("c2", 1550),
      usage(200, 20, 1700),
      toolResult("c2", 1800),
    ]);
    const [first, second] = answers(s);
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(first.durationMs).toBe(100);
    expect(first.endTs).toBe(1200);
    expect(second.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(second.durationMs).toBe(200);
    expect(second.endTs).toBe(1700);
  });

  it("a turn that only thought and then called a tool gets its usage on its own thinking block", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "text_delta", agentId: "main", text: "Answer.", ts: 1100 },
      usage(100, 10, 1200),
      toolCall("c1", 1300),
      toolResult("c1", 1400),
      { type: "turn_start", agentId: "main", turn: 2, ts: 1450 },
      { type: "thinking_delta", agentId: "main", text: "next I read the pom", ts: 1500 },
      toolCall("c2", 1600),
      usage(300, 30, 1650),
    ]);
    const [first, thought] = answers(s);
    expect(first.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(thought.thinking).toBe("next I read the pom");
    expect(thought.usage).toEqual({ inputTokens: 300, outputTokens: 30 });
    expect(thought.endTs).toBe(1650);
  });

  it("a model turn whose text joins the agent's open block (nothing between) stamps that block, as the reducer did before card 414", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 1050 },
      { type: "text_delta", agentId: "main", text: "First part. ", ts: 1100 },
      usage(100, 10, 1200),
      { type: "turn_start", agentId: "main", turn: 2, ts: 1250 },
      { type: "text_delta", agentId: "main", text: "Second part.", ts: 1300 },
      usage(200, 20, 1400),
    ]);
    const blocks = answers(s);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe("First part. Second part.");
    expect(blocks[0].usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(blocks[0].endTs).toBe(1400);
  });

  it("a model turn whose thinking joins the agent's open block, then calls a tool, stamps that block", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 1050 },
      { type: "text_delta", agentId: "main", text: "First part.", ts: 1100 },
      usage(100, 10, 1200),
      { type: "turn_start", agentId: "main", turn: 2, ts: 1250 },
      { type: "thinking_delta", agentId: "main", text: "now the pom", ts: 1300 },
      toolCall("c1", 1350),
      usage(200, 20, 1400),
    ]);
    const blocks = answers(s);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].thinking).toBe("now the pom");
    expect(blocks[0].usage).toEqual({ inputTokens: 200, outputTokens: 20 });
    expect(blocks[0].endTs).toBe(1400);
  });

  it("an answer whose turn ended without usage does not take the usage of a later text-less turn", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 1050 },
      { type: "text_delta", agentId: "main", text: "Half an ans", ts: 1100 },
      { type: "run_end", runId: "r1", stopReason: "aborted", ts: 1200 },
      runStart("r2", "rtk-ls", 5000),
      { type: "turn_start", agentId: "main", turn: 1, ts: 5050 },
      toolCall("c1", 5100),
      usage(900, 12, 5200),
    ]);
    const [torn] = answers(s);
    expect(torn.text).toBe("Half an ans");
    expect(torn.usage).toBeUndefined();
    expect(torn.endTs).toBeUndefined();
    expect(s.runUsage).toEqual({ inputTokens: 900, outputTokens: 12 });
  });

  it("a child's text-less turn does not restamp the child's answer, and the root's answer keeps its own", () => {
    const s = reduceAll(initialState, [
      runStart("r1", "go", 1000),
      { type: "text_delta", agentId: "main", text: "Spawning.", ts: 1100 },
      usage(100, 10, 1200),
      { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "look", ts: 1300 },
      { type: "text_delta", agentId: "explore-1", text: "Child answer.", ts: 1400 },
      usage(40, 4, 1500, "explore-1"),
      toolCall("k1", 1600, "explore-1"),
      usage(60, 6, 1700, "explore-1"),
    ]);
    const root = answers(s).find((a) => a.agentId === "main");
    const child = answers(s).find((a) => a.agentId === "explore-1");
    expect(root?.usage).toEqual({ inputTokens: 100, outputTokens: 10 });
    expect(child?.usage).toEqual({ inputTokens: 40, outputTokens: 4 });
    expect(child?.endTs).toBe(1500);
    expect(s.usage).toEqual({ inputTokens: 200, outputTokens: 20 });
  });
});
