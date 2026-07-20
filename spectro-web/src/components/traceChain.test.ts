import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import { causalChain, reasoningPairs } from "./traceChain";

const E = (seq: number, type: string, agentId: string | undefined, payload: Record<string, unknown>): TraceEntry => ({
  seq,
  dir: "in",
  ts: 1000 + seq,
  type,
  ...(agentId !== undefined ? { agentId } : {}),
  payload: { type, ...(agentId !== undefined ? { agentId } : {}), ...payload },
});

// prompt -> turn -> thinking -> call -> gate request -> decision -> result,
// plus a subagent spawned from main with its own run and call.
const stream: TraceEntry[] = [
  E(1, "run_start", "main", { runId: "r1", prompt: "clean up /tmp" }),
  E(2, "turn_start", "main", { turn: 1 }),
  E(3, "thinking_delta", "main", { text: "rm needs a gate…" }),
  E(4, "thinking_delta", "main", { text: "asking first." }),
  E(5, "tool_call", "main", { callId: "c1", name: "run_command", input: { cmd: "rm -rf data/tmp" } }),
  E(6, "permission_request", "main", { callId: "c1", name: "run_command" }),
  E(7, "permission_decision", undefined, { callId: "c1", allowed: true }),
  E(8, "tool_result", "main", { callId: "c1", output: "ok", isError: false }),
  E(9, "agent_spawn", "helper", { parentId: "main", task: "verify" }),
  E(10, "run_start", "helper", { runId: "r2", parentId: "main", prompt: "verify" }),
  E(11, "turn_start", "helper", { turn: 1 }),
  E(12, "tool_call", "helper", { callId: "c2", name: "read_file", input: {} }),
  E(13, "text_delta", "main", { text: "done." }),
];

describe("causalChain", () => {
  it("walks a tool_result back to the prompt through gate, call and turn", () => {
    const chain = causalChain(stream, stream[7]); // seq 8, tool_result
    expect(chain.map((e) => e.type)).toEqual([
      "run_start",
      "turn_start",
      "tool_call",
      "permission_request",
      "permission_decision",
      "tool_result",
    ]);
    expect(chain[0].seq).toBe(1); // the root prompt anchors the chain
  });

  it("hops a subagent call over its spawn to the parent run", () => {
    const chain = causalChain(stream, stream[11]); // seq 12, helper tool_call
    expect(chain.map((e) => e.seq)).toEqual([1, 9, 10, 11, 12]);
    expect(chain[1].type).toBe("agent_spawn");
  });

  it("keeps a frame with no known links as a single-element chain", () => {
    const lone = E(99, "usage", "main", { inputTokens: 1, outputTokens: 1 });
    expect(causalChain(stream, lone)).toEqual([lone]);
  });
});

describe("reasoningPairs", () => {
  it("pairs the END of a thinking block with the next same-agent action", () => {
    const pairs = reasoningPairs(stream);
    expect(pairs.get(4)).toBe(5); // block 3-4 -> tool_call seq 5
    expect(pairs.has(3)).toBe(false); // mid-block deltas carry no pair
  });

  it("pairs across other agents' frames, never with them", () => {
    const s = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "tool_call", "helper", { callId: "x", name: "read_file", input: {} }),
      E(3, "text_delta", "main", { text: "answer" }),
    ];
    expect(reasoningPairs(s).get(1)).toBe(3);
  });
});
