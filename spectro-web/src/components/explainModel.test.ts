import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import { buildRunSummary, gateExplanations } from "./explainModel";

const E = (seq: number, type: string, agentId: string | undefined, payload: Record<string, unknown>): TraceEntry => ({
  seq,
  dir: "in",
  ts: 1000 + seq * 100,
  type,
  ...(agentId !== undefined ? { agentId } : {}),
  payload: { type, ...payload },
});

const stream: TraceEntry[] = [
  E(1, "permission_mode_info", undefined, { mode: "ask" }),
  E(2, "run_start", "main", { runId: "r1", prompt: "tidy the workspace" }),
  E(3, "turn_start", "main", { turn: 1 }),
  E(4, "tool_call", "main", { callId: "c1", name: "run_command", input: { cmd: "rm x" } }),
  E(5, "permission_request", "main", { callId: "c1", name: "run_command", input: { cmd: "rm x" } }),
  E(6, "permission_decision", undefined, { callId: "c1", allowed: false }),
  E(7, "tool_result", "main", { callId: "c1", output: "denied", isError: true }),
  E(8, "tool_call", "main", { callId: "c2", name: "read_file", input: {} }),
  E(9, "permission_request", "main", { callId: "c2", name: "read_file", input: {} }),
  E(10, "usage", "main", { inputTokens: 50, outputTokens: 9, cacheReadTokens: 25 }),
  E(11, "run_end", undefined, { runId: "r1", stopReason: "end_turn" }),
];

describe("buildRunSummary", () => {
  it("folds prompt, counts, tokens and gate tallies from the stream", () => {
    const s = buildRunSummary(stream);
    expect(s.prompt).toBe("tidy the workspace");
    expect(s.turns).toBe(1);
    expect(s.toolCalls).toBe(2);
    expect(s.toolErrors).toBe(1);
    expect(s.toolsByName[0]).toEqual({ name: "run_command", n: 1 });
    expect(s.gatesAsked).toBe(2);
    expect(s.gatesDenied).toBe(1);
    expect(s.gatesAllowed).toBe(0);
    expect(s.gatesPending).toBe(1); // c2 never got a decision
    expect(s.inTokens).toBe(50);
    expect(s.cacheTokens).toBe(25);
    expect(s.stopReason).toBe("end_turn");
    expect(s.durationMs).toBe(1000); // seq 1 .. seq 11
    expect(s.agents).toEqual(["main"]);
  });

  it("skips the synthetic system_context frame", () => {
    const s = buildRunSummary([E(0, "system_context", undefined, { systemPrompt: "x" }), ...stream]);
    expect(s.prompt).toBe("tidy the workspace");
  });
});

describe("gateExplanations", () => {
  it("joins each request with its recorded outcome and the mode at ask time", () => {
    const gates = gateExplanations(stream);
    expect(gates).toHaveLength(2);
    expect(gates[0]).toMatchObject({ callId: "c1", name: "run_command", outcome: "denied", modeAtAsk: "ask" });
    expect(gates[1]).toMatchObject({ callId: "c2", outcome: "pending", modeAtAsk: "ask" });
  });

  it("leaves the mode null when the stream never announced one (stored JSONL)", () => {
    const gates = gateExplanations(stream.slice(1)); // drop the mode frame
    expect(gates[0].modeAtAsk).toBeNull();
  });
});
