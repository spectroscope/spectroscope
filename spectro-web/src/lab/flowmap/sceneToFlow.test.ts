import { describe, expect, it } from "vitest";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { deriveDetail, sceneToFlow } from "./sceneToFlow";

const T = 1700000000000;

const runStart = (provider: string): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId: "main", prompt: "hi", provider, ts: T }) as RunEvent;
const spawn = (agentId: string): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task: `task ${agentId}`, ts: T }) as RunEvent;

function build(events: RunEvent[], local: boolean, provider: string, model = "m") {
  const scene = events.reduce(advanceScene, initialScene());
  const detail = deriveDetail(events);
  return sceneToFlow(scene, detail, { local, provider, model });
}

const ids = (flow: { nodes: { id: string }[] }) => flow.nodes.map((n) => n.id);

describe("sceneToFlow", () => {
  it("emits the core agent-system, OS band and external nodes", () => {
    const flow = build([runStart("anthropic")], false, "anthropic");
    for (const id of ["user", "agent", "os-disk", "os-shell", "os-mcp", "os-net", "llm", "netz", "mcpserver"]) {
      expect(ids(flow)).toContain(id);
    }
    // background zones
    for (const id of ["z-mac", "z-os", "z-outside"]) expect(ids(flow)).toContain(id);
  });

  it("remote: the LLM sits BEYOND the network boundary, which is drawn", () => {
    const flow = build([runStart("anthropic")], false, "anthropic");
    expect(ids(flow)).toContain("z-boundary");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    // remote boundary is at x=1016; the LLM must be to the right of it.
    expect(llm.position.x).toBeGreaterThan(1016);
  });

  it("local: no boundary, and the LLM sits INSIDE 'Dein Mac'", () => {
    const flow = build([runStart("ollama")], true, "ollama");
    expect(ids(flow)).not.toContain("z-boundary");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    // local z-mac is 1100 wide from x=0; the LLM must fall inside it.
    expect(llm.position.x).toBeLessThan(1100);
  });

  it("lays out three subagents with equal, non-clumping vertical spacing inside the band", () => {
    const flow = build([runStart("ollama"), spawn("worker-1"), spawn("worker-2"), spawn("worker-3")], true, "ollama");
    const subs = flow.nodes.filter((n) => n.id.startsWith("sub-")).sort((a, b) => a.position.y - b.position.y);
    expect(subs).toHaveLength(3);
    const gap1 = subs[1].position.y - subs[0].position.y;
    const gap2 = subs[2].position.y - subs[1].position.y;
    expect(gap1).toBe(gap2); // deterministic, evenly spaced — the anti-clump rule
    expect(gap1).toBeGreaterThanOrEqual(132 + 44); // >= card height + hard min gap
    expect(subs[0].position.y).toBeGreaterThanOrEqual(110); // top of the band
    expect(subs[2].position.y + 132).toBeLessThanOrEqual(632); // last card clears the OS band
  });

  it("clamps the subagent column to at most three cards", () => {
    const flow = build(
      [runStart("ollama"), spawn("w1"), spawn("w2"), spawn("w3"), spawn("w4")],
      true,
      "ollama",
    );
    expect(flow.nodes.filter((n) => n.id.startsWith("sub-"))).toHaveLength(3);
  });

  it("shared stations light for WHICHEVER loop is on them (child at the disk)", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      { type: "tool_call", agentId: "worker-1", callId: "k1", name: "write_file", input: { path: "docs/plan.md" }, ts: T } as RunEvent,
    ];
    const flow = build(events, true, "ollama");
    const disk = flow.nodes.find((n) => n.id === "os-disk")!;
    expect(disk.data.active).toBe(true); // a CHILD is writing, not main
    expect(disk.data.file).toBe("plan.md");
    // the child's own rail to the shared station exists and is lit
    const rail = flow.edges.find((e) => e.id === "e-sub-worker-1-osdisk")!;
    expect(rail).toBeTruthy();
    expect((rail.data as { active: boolean }).active).toBe(true);
  });

  it("the shared LLM animates and streams per agent when a child thinks", () => {
    const events: RunEvent[] = [
      runStart("ollama"),
      spawn("worker-1"),
      { type: "run_start", runId: "rc", agentId: "worker-1", parentId: "main", prompt: "task", ts: T } as RunEvent,
      { type: "thinking_delta", agentId: "worker-1", text: "child reasoning", ts: T } as RunEvent,
    ];
    const flow = build(events, true, "ollama");
    const llm = flow.nodes.find((n) => n.id === "llm")!;
    expect(llm.data.active).toBe(true); // busy through the CHILD
    const think = llm.data.think as { agent: string; text: string }[];
    expect(think.some((s) => s.agent === "worker-1" && s.text.includes("child reasoning"))).toBe(true);
  });
});
