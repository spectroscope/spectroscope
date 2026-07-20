import { describe, it, expect } from "vitest";
import { buildFleetGraph } from "./fleetGraph";
import type { FleetModel, FleetNode } from "./fleetModel";
import type { RunEvent } from "../events";

function rnode(id: string, connected = true): FleetNode {
  return { id, role: "worker", capabilities: [], topic: "ctx.events", connected, lastSeen: 1 };
}

// root spawns worker-1 and worker-2; root tasks worker-1; worker-2 restarted
// (epoch 1) and is blocked on a gate; worker-1 reports a result.
const model: FleetModel = {
  roster: [rnode("root"), rnode("worker-1"), rnode("worker-2")],
  events: [
    { type: "run_start", runId: "r0", agentId: "root", prompt: "orchestrate", ts: 1 },
    { type: "agent_spawn", agentId: "worker-1", parentId: "root", task: "scan", ts: 2 },
    { type: "run_start", runId: "r1", agentId: "worker-1", parentId: "root", prompt: "scan", ts: 3 },
    { type: "agent_message", from: "root", to: "worker-1", role: "task", state: "submitted", text: "scan", ts: 4 },
    { type: "agent_spawn", agentId: "worker-2", parentId: "root", task: "build", ts: 5 },
    { type: "permission_request", agentId: "worker-2", callId: "c1", name: "run_command", input: {}, ts: 6 },
    { type: "usage", agentId: "worker-1", inputTokens: 100, outputTokens: 20, ts: 7 },
    { type: "agent_message", from: "worker-1", to: "root", role: "result", state: "completed", text: "done", ts: 8 },
  ] as unknown as RunEvent[],
  epochBySender: { root: 0, "worker-1": 0, "worker-2": 1 },
};

describe("buildFleetGraph", () => {
  it("builds one node per roster agent", () => {
    const g = buildFleetGraph(model);
    expect(g.nodes.map((n) => n.id).sort()).toEqual(["root", "worker-1", "worker-2"]);
  });

  it("derives EXACTLY the payload edges — spawn/task/result, spawn deduped, no spurious edge", () => {
    const g = buildFleetGraph(model);
    const set = g.edges.map((e) => `${e.kind}:${e.source}->${e.target}`).sort();
    expect(set).toEqual([
      "result:worker-1->root",
      "spawn:root->worker-1", // run_start.parentId AND agent_spawn collapse to one
      "spawn:root->worker-2",
      "task:root->worker-1",
    ]);
    // The correctness pin: root has NO incoming edge (it is the root, parentId
    // null). A fold that mis-read a "who sent last" chain would invent one.
    expect(g.edges.some((e) => e.target === "root" && e.kind === "spawn")).toBe(false);
  });

  it("marks the blocked agent's pending gate and its epoch", () => {
    const g = buildFleetGraph(model);
    const w2 = g.nodes.find((n) => n.id === "worker-2")!;
    expect(w2.pendingGate).toBe(true);
    expect(w2.epoch).toBe(1);
  });

  it("threads tokens and result-state onto the node", () => {
    const g = buildFleetGraph(model);
    const w1 = g.nodes.find((n) => n.id === "worker-1")!;
    expect(w1.inTokens).toBe(100);
    expect(w1.outTokens).toBe(20);
    expect(w1.state).toBe("completed");
    expect(w1.spawnedBy).toBe("root");
  });

  it("clears the gate once a decision lands", () => {
    const decided: FleetModel = {
      ...model,
      events: [
        ...model.events,
        { type: "permission_decision", callId: "c1", allowed: true, ts: 9 } as unknown as RunEvent,
      ],
    };
    const g = buildFleetGraph(decided);
    expect(g.nodes.find((n) => n.id === "worker-2")!.pendingGate).toBe(false);
  });

  it("is empty for an empty fleet", () => {
    const g = buildFleetGraph({ roster: [], events: [], epochBySender: {} });
    expect(g.nodes).toEqual([]);
    expect(g.edges).toEqual([]);
  });
});
