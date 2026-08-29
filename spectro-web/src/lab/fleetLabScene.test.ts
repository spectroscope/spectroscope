import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { FleetModel, FleetNode } from "../spectrum/fleetModel";
import { buildFleetLabScene } from "./fleetLabScene";

const ts = 1;

function node(id: string, role: string, connected = true): FleetNode {
  return { id, role, capabilities: [], topic: "ctx.events", connected, lastSeen: ts };
}

function model(roster: FleetNode[], events: RunEvent[]): FleetModel {
  return { roster, events, frames: [], epochBySender: {} };
}

describe("buildFleetLabScene — the fleet machine-room fold", () => {
  it("seeds one card per roster node, main first, and keeps roster metadata", () => {
    const scene = buildFleetLabScene(
      model([node("worker-1", "worker"), node("main", "root"), node("explore-1", "explorer", false)], []),
    );
    expect(scene.nodes.map((n) => n.id)).toEqual(["main", "worker-1", "explore-1"]);
    expect(scene.nodes[0].role).toBe("root");
    expect(scene.nodes[2].connected).toBe(false);
    // A card with no events yet idles at its own agent loop.
    expect(scene.nodes[1].focus).toBe("agent");
  });

  it("folds each node's events into that node's own loop", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "worker-1", prompt: "write it", provider: "ollama", ts },
      {
        type: "tool_call",
        agentId: "worker-1",
        callId: "c1",
        name: "write_file",
        input: { path: "a/b.txt" },
        ts,
      },
      { type: "run_start", runId: "r2", agentId: "explore-1", prompt: "map it", provider: "anthropic", ts },
      { type: "thinking_delta", agentId: "explore-1", text: "hm", ts },
    ];
    const scene = buildFleetLabScene(
      model([node("worker-1", "worker"), node("explore-1", "explorer")], events),
    );
    const worker = scene.nodes.find((n) => n.id === "worker-1")!;
    const explorer = scene.nodes.find((n) => n.id === "explore-1")!;
    expect(worker.focus).toBe("disk");
    expect(worker.disk).toBe("write");
    expect(worker.activeFile).toBe("b.txt");
    expect(explorer.focus).toBe("llm");
    expect(scene.activeNode).toBe("explore-1");
  });

  it("a node's run_end rests its packet at the agent, never at the user", () => {
    // The single-run map sends run_end home to the user; a fleet node has no
    // user of its own — it parks at itself between runs. run_end carries no
    // agentId on the wire, so the fold attributes it via its run_start's runId.
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "worker-1", prompt: "go", provider: "ollama", ts },
      { type: "thinking_delta", agentId: "worker-1", text: "…", ts },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
    ];
    const scene = buildFleetLabScene(model([node("worker-1", "worker")], events));
    expect(scene.nodes[0].focus).toBe("agent");
    expect(scene.nodes[0].activeTool).toBeNull();
  });

  it("tracks the provider per node, and summarizes nothing about where it runs", () => {
    // The fold used to carry hasLocal/hasRemote so the machine room could draw
    // a model station per side. One station serves the whole fleet since card
    // 304, so the summary has no reader and the fold has no opinion left: what
    // survives is the per-node provider, which is a fact off the wire.
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "anthropic", ts },
      { type: "run_start", runId: "r2", agentId: "worker-1", prompt: "sub", provider: "ollama", ts },
    ];
    const scene = buildFleetLabScene(model([node("main", "root"), node("worker-1", "worker")], events));
    expect(scene.nodes.find((n) => n.id === "main")!.provider).toBe("anthropic");
    expect(scene.nodes.find((n) => n.id === "worker-1")!.provider).toBe("ollama");
    expect(Object.keys(scene)).not.toContain("hasLocal");
    expect(Object.keys(scene)).not.toContain("hasRemote");
  });

  it("carries task/status/result meta from agent_message like the single-run cards", () => {
    const events: RunEvent[] = [
      {
        type: "agent_message",
        from: "main",
        to: "worker-1",
        role: "task",
        text: "Write build.txt",
        ts,
      } as RunEvent,
      {
        type: "agent_message",
        from: "worker-1",
        to: "main",
        role: "status",
        text: "drafting",
        ts,
      } as RunEvent,
      {
        type: "agent_message",
        from: "worker-1",
        to: "main",
        role: "result",
        state: "completed",
        text: "done",
        ts,
      } as RunEvent,
    ];
    const scene = buildFleetLabScene(model([node("main", "root"), node("worker-1", "worker")], events));
    const worker = scene.nodes.find((n) => n.id === "worker-1")!;
    expect(worker.task).toBe("Write build.txt");
    expect(worker.lastStatus).toBe("drafting");
    expect(worker.state).toBe("completed");
  });

  it("routes a permission decision back to the node that asked", () => {
    const events: RunEvent[] = [
      { type: "permission_request", agentId: "worker-1", callId: "g1", name: "write_file", input: {}, ts },
      { type: "permission_decision", callId: "g1", allowed: false, ts } as RunEvent,
    ];
    const scene = buildFleetLabScene(model([node("main", "root"), node("worker-1", "worker")], events));
    const worker = scene.nodes.find((n) => n.id === "worker-1")!;
    const main = scene.nodes.find((n) => n.id === "main")!;
    expect(worker.gate).toBe("denied");
    expect(worker.isError).toBe(true);
    expect(main.gate).toBe("none");
  });

  it("creates a card for a node only seen in events (no roster entry yet)", () => {
    const events: RunEvent[] = [{ type: "text_delta", agentId: "ghost-1", text: "hi", ts }];
    const scene = buildFleetLabScene(model([node("main", "root")], events));
    expect(scene.nodes.map((n) => n.id)).toEqual(["main", "ghost-1"]);
    expect(scene.nodes[1].focus).toBe("llm");
    expect(scene.nodes[1].connected).toBe(false);
  });
});
