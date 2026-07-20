// The chat's thread grouping: main turns pass through flat, consecutive
// subagent turns nest into one thread block per child, interleaving splits
// honestly (chronology wins over tidiness).
import { describe, expect, it } from "vitest";
import type { AgentInfo, ToolCard, Turn } from "./reducer";
import { groupTurns, type ChatBlock } from "./threads";

const worker: AgentInfo = {
  id: "worker-1", parentId: "main", label: "build_plan", task: "Plan the flag",
  state: "working", lastStatus: null, inTokens: 0, outTokens: 0,
};

const cards: Record<string, ToolCard> = {
  m1: { callId: "m1", agentId: "main", name: "grep", input: {}, status: "ok", startedAt: 1 },
  k1: { callId: "k1", agentId: "worker-1", name: "write_file", input: {}, status: "ok", startedAt: 2 },
};

const turns: Turn[] = [
  { kind: "user", text: "Do it" },
  { kind: "assistant", agentId: "main", text: "Delegating.", thinking: "" },
  { kind: "info", text: "Subagent worker-1 spawned: Plan the flag", tone: "neutral", agentId: "worker-1" },
  { kind: "assistant", agentId: "worker-1", text: "", thinking: "planning" },
  { kind: "tool", callId: "k1" },
  { kind: "assistant", agentId: "main", text: "Meanwhile on main.", thinking: "" },
  { kind: "assistant", agentId: "worker-1", text: "Done.", thinking: "" },
  { kind: "tool", callId: "m1" },
];

describe("groupTurns", () => {
  const blocks = groupTurns(turns, cards, [worker]);

  it("keeps main turns flat and in order", () => {
    const kinds = blocks.map((b) => (b.kind === "turn" ? b.turn.kind : "thread"));
    expect(kinds).toEqual(["user", "assistant", "thread", "assistant", "thread", "tool"]);
  });

  it("groups consecutive child turns into one thread carrying the roster's task", () => {
    const thread = blocks[2] as Extract<ChatBlock, { kind: "thread" }>;
    expect(thread.agentId).toBe("worker-1");
    expect(thread.task).toBe("Plan the flag");
    expect(thread.label).toBe("build_plan");
    // spawn info + child thinking + child tool = one burst
    expect(thread.items.map((it) => it.turn.kind)).toEqual(["info", "assistant", "tool"]);
  });

  it("splits the thread when main interleaves (chronology wins)", () => {
    const second = blocks[4] as Extract<ChatBlock, { kind: "thread" }>;
    expect(second.kind).toBe("thread");
    expect(second.agentId).toBe("worker-1");
    expect(second.items).toHaveLength(1);
  });

  it("resolves tool ownership through the card and keeps flat indexes", () => {
    const flatTool = blocks[5] as Extract<ChatBlock, { kind: "turn" }>;
    expect(flatTool.turn.kind).toBe("tool");
    expect(flatTool.index).toBe(7);
    const thread = blocks[2] as Extract<ChatBlock, { kind: "thread" }>;
    expect(thread.items[2].index).toBe(4);
  });

  it("an unknown child still threads, with an empty task", () => {
    const blocks2 = groupTurns(
      [{ kind: "assistant", agentId: "ghost-9", text: "hi", thinking: "" }], {}, []);
    const th = blocks2[0] as Extract<ChatBlock, { kind: "thread" }>;
    expect(th.kind).toBe("thread");
    expect(th.task).toBe("");
    expect(th.label).toBeNull();
  });
});
