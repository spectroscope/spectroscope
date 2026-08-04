import { describe, expect, it } from "vitest";
import type { TraceEntry } from "../state/reducer";
import { causalChain, reasoningPairs, reasoningBlockText } from "./traceChain";

const E = (
  seq: number,
  type: string,
  agentId: string | undefined,
  payload: Record<string, unknown>,
): TraceEntry => ({
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

/**
 * Both lens maps key the row that OPENS a block, and this used to be the row
 * that closed it.
 *
 * The owner reported that "a turn_start always has a huge thinking event and
 * the thinking lens ignores it", and the measurement said he was right. On his
 * own transcript the 451 thinking frames form 305 blocks, 146 of them two rows
 * long. In 146 of those 146 the FIRST row sits directly under the turn_start,
 * and in 146 of 146 it holds more text than the second — so the lens drew its
 * panel and its "then:" chip on the short tail while the long thought above it,
 * the one the eye lands on, showed nothing at all. Measured example, seq 13/14:
 * 788 characters silent, 112 characters carrying the whole joined block.
 *
 * The block still reads as one block and the joined text is unchanged. What
 * moved is which row wears it: the one where the block starts, which is the row
 * under the turn_start.
 */
describe("reasoningPairs", () => {
  it("pairs the START of a thinking block with the next same-agent action", () => {
    const pairs = reasoningPairs(stream);
    expect(pairs.get(3)).toBe(5); // block 3-4 opens at 3 -> tool_call seq 5
    expect(pairs.has(4)).toBe(false); // the block wears its pair once, at the top
  });

  it("pairs across other agents' frames, never with them", () => {
    const s = [
      E(1, "thinking_delta", "main", { text: "…" }),
      E(2, "tool_call", "helper", { callId: "x", name: "read_file", input: {} }),
      E(3, "text_delta", "main", { text: "answer" }),
    ];
    expect(reasoningPairs(s).get(1)).toBe(3);
  });

  it("looks for the action past the whole block, not past its first row", () => {
    // The action follows the block; anchoring at the top must not make the
    // block's own later rows count as the thing it led to.
    const s = [
      E(1, "thinking_delta", "main", { text: "first " }),
      E(2, "thinking_delta", "main", { text: "second" }),
      E(3, "tool_call", "main", { callId: "c", name: "x", input: {} }),
    ];
    expect(reasoningPairs(s).get(1)).toBe(3);
  });
});

describe("reasoningBlockText", () => {
  it("joins a block's full thinking text onto the seq that OPENS it", () => {
    const blocks = reasoningBlockText(stream);
    expect(blocks.get(3)).toBe("rm needs a gate…asking first.");
    expect(blocks.has(4)).toBe(false); // said once, on the row the block starts on
  });

  it("keeps separate agents' blocks apart", () => {
    const s: TraceEntry[] = [
      E(1, "thinking_delta", "a", { text: "A1 " }),
      E(2, "thinking_delta", "a", { text: "A2" }),
      E(3, "thinking_delta", "b", { text: "B1" }),
      E(4, "tool_call", "b", { callId: "c", name: "x", input: {} }),
    ];
    const blocks = reasoningBlockText(s);
    expect(blocks.get(1)).toBe("A1 A2");
    expect(blocks.get(3)).toBe("B1");
  });

  it("puts the long thought's own row in charge of showing it", () => {
    // The owner's shape, in miniature: a long first row and a short tail.
    const s: TraceEntry[] = [
      E(1, "turn_start", "main", { turn: 7 }),
      E(2, "thinking_delta", "main", { text: "x".repeat(788) }),
      E(3, "thinking_delta", "main", { text: "y".repeat(112) }),
      E(4, "tool_call", "main", { callId: "c", name: "Bash", input: {} }),
    ];
    const blocks = reasoningBlockText(s);
    expect(blocks.get(2)).toHaveLength(900);
    expect(blocks.has(3)).toBe(false);
    expect(reasoningPairs(s).get(2)).toBe(4);
  });
});
