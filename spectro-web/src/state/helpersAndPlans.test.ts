// Card 593: a helper's figures in their own slot, one plan per writer, and the
// root's fields untouched by anything a child sends.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, reduceAll, type UiState } from "./reducer";
import { sessionHarness } from "../testkit/chatHost";

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;
const M = "main";
const K = "explore-1";
const rootStart = ev({
  type: "run_start",
  runId: "r1",
  agentId: M,
  prompt: "go",
  model: "qwen2.5:7b",
  contextWindow: 32_768,
  windowSource: "model",
});
const childStart = (extra: Record<string, unknown> = {}): RunEvent =>
  ev({
    type: "run_start",
    runId: "r2",
    agentId: K,
    parentId: M,
    prompt: "look",
    model: "minimax-m3:cloud",
    ...extra,
  });
const info = (agentId: string, extra: Record<string, unknown> = {}): RunEvent =>
  ev({
    type: "context_info",
    agentId,
    turn: 1,
    messages: 3,
    estimatedTokens: 90,
    threshold: 22_937,
    thresholdSource: "window",
    contextWindow: 32_768,
    parts: [{ label: "system prompt", chars: 200, estTokens: 50 }],
    ...extra,
  });
const usage = (agentId: string, inputTokens: number, extra: Record<string, unknown> = {}): RunEvent =>
  ev({ type: "usage", agentId, inputTokens, outputTokens: 1, ...extra });
const plan = (agentId: string, steps: { text: string; status: string }[]): RunEvent =>
  ev({ type: "plan", agentId, steps });
const steps3 = [
  { text: "read", status: "completed" },
  { text: "fix", status: "in_progress" },
  { text: "gate", status: "pending" },
];
const run = (events: RunEvent[], from: UiState = initialState): UiState => reduceAll(from, events);

describe("a helper's figures (card 593)", () => {
  it("a helper's usage writes its slot and leaves the root's fill alone", () => {
    const s = run([rootStart, usage(M, 1000), childStart(), usage(K, 300, { cacheReadTokens: 50 })]);
    expect(s.helpers[K]?.lastInputTokens).toBe(350);
    expect(s.lastInputTokens).toBe(1000);
    expect(s.helpers[M]).toBeUndefined();
  });

  it("a helper's context_info lands in its slot, the root's snapshot untouched by identity", () => {
    const before = run([rootStart, info(M)]);
    const after = reduce(before, info(K, { contextWindow: 1_000_000, thresholdSource: "model" }));
    expect(after.helpers[K]?.context?.contextWindow).toBe(1_000_000);
    expect(after.helpers[K]?.announcedWindow).toBeNull();
    expect(after.context).toBe(before.context);
    expect(after.context?.contextWindow).toBe(32_768);
  });

  it("a helper's run_start names its window until its first snapshot", () => {
    const before = run([rootStart]);
    const named = reduce(before, childStart({ contextWindow: 200_000, windowSource: "model" }));
    expect(named.helpers[K]?.announcedWindow).toEqual({ contextWindow: 200_000, thresholdSource: "model" });
    expect(named.announcedWindow).toBe(before.announcedWindow);
    const snapped = reduce(named, info(K));
    expect(snapped.helpers[K]?.announcedWindow).toBeNull();
    expect(snapped.helpers[K]?.context?.turn).toBe(1);
  });

  it("a child's run_start without a window leaves its slot alone", () => {
    const s = run([rootStart, childStart()]);
    expect(s.helpers[K]).toBeUndefined();
  });

  it("a child's run_start model reaches the roster; the root's model stays in runModel", () => {
    const s = run([rootStart, childStart()]);
    expect(s.agents.find((a) => a.id === K)?.model).toBe("minimax-m3:cloud");
    expect(s.agents.find((a) => a.id === M)?.model).toBeUndefined();
    expect(s.runModel).toBe("qwen2.5:7b");
  });

  it("a reused helper id takes the newer run's figures and keeps one roster row", () => {
    const s = run([
      rootStart,
      childStart(),
      usage(K, 100),
      childStart({ runId: "r3", model: "qwen2.5:7b" }),
      usage(K, 700),
    ]);
    expect(s.agents.filter((a) => a.id === K)).toHaveLength(1);
    expect(s.agents.find((a) => a.id === K)?.model).toBe("qwen2.5:7b");
    expect(s.helpers[K]?.lastInputTokens).toBe(700);
  });

  it("a child's context_info before its run_start still makes its slot", () => {
    const s = run([rootStart, info(K)]);
    expect(s.helpers[K]?.context).not.toBeNull();
  });

  it("window_override and context_cleared move the root's fields and not a helper's", () => {
    const before = run([rootStart, info(M), childStart(), usage(K, 300), info(K)]);
    const overridden = reduce(
      before,
      ev({
        type: "window_override",
        tokens: 512_000,
        threshold: 358_400,
        thresholdSource: "window_override",
        contextWindow: 512_000,
      }),
    );
    expect(overridden.context?.contextWindow).toBe(512_000);
    expect(overridden.helpers).toBe(before.helpers);
    const cleared = reduce(overridden, ev({ type: "context_cleared", agentId: M }));
    expect(cleared.helpers).toBe(before.helpers);
    expect(cleared.context?.parts.length).toBeLessThanOrEqual(overridden.context?.parts.length ?? 0);
  });

  it("starts empty", () => {
    expect(initialState.helpers).toEqual({});
    expect(initialState.plans).toEqual({});
  });
});

describe("one plan per writer (card 593)", () => {
  it("keeps the root's and the playbook's plans apart; plan and planAgent stay the latest frame", () => {
    const s = run([rootStart, plan(M, steps3), plan("playbook", [{ text: "[a] A", status: "pending" }])]);
    expect(s.plans[M]).toHaveLength(3);
    expect(s.plans.playbook).toHaveLength(1);
    expect(s.plan).toHaveLength(1);
    expect(s.planAgent).toBe("playbook");
  });

  it("the root plan survives the 13 child frame kinds and an empty child plan, by reference", () => {
    const kid = (o: Record<string, unknown>): RunEvent => ev({ agentId: K, ...o });
    const child: RunEvent[] = [
      kid({ type: "agent_spawn", parentId: M, task: "t" }),
      ev({ type: "agent_message", from: M, to: K, role: "task", state: "submitted", text: "t" }),
      kid({ type: "run_start", runId: "r2", parentId: M, prompt: "t" }),
      kid({ type: "turn_start", turn: 1 }),
      kid({ type: "thinking_delta", text: "h" }),
      kid({ type: "text_delta", text: "x" }),
      kid({ type: "tool_call", callId: "c", name: "read_file", input: {} }),
      kid({ type: "tool_result", callId: "c", output: "x", isError: false, durationMs: 1 }),
      kid({ type: "context_info", turn: 1, messages: 3, estimatedTokens: 9, threshold: 99, parts: [] }),
      kid({ type: "usage", inputTokens: 1, outputTokens: 1 }),
      kid({ type: "compaction", removedTurns: 1, summaryChars: 1 }),
      ev({ type: "run_end", runId: "r2", stopReason: "end_turn" }),
      ev({ type: "agent_message", from: K, to: M, role: "result", state: "completed", text: "ok" }),
      kid({ type: "plan", steps: [] }),
    ];
    expect(child).toHaveLength(14);
    let s = run([rootStart, plan(M, steps3)]);
    const rootPlan = s.plans[M];
    for (const e of child) {
      s = reduce(s, e);
      expect(s.plans[M], e.type).toBe(rootPlan);
    }
    expect(s.plans[K]).toEqual([]);
  });

  it("a session switch round trip through SessionSet keeps the plan", () => {
    const { set, sockets } = sessionHarness();
    const first = set.view().key;
    // A record nobody has typed into is reused by newChat; a send makes it a session.
    set.send(first, "go");
    sockets[0].emit([rootStart, plan(M, steps3)]);
    const held = set.view().state.plans[M];
    expect(held).toHaveLength(3);
    const second = set.newChat();
    expect(second).not.toBe(first);
    set.select(first);
    expect(set.view().key).toBe(first);
    expect(set.view().state.plans[M]).toBe(held);
  });
});
