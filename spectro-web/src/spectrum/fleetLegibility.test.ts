import { describe, it, expect } from "vitest";
import { collapseFleetGraph } from "./fleetLegibility";
import type { FleetGraph, FleetGraphNode } from "./fleetGraph";

function anode(id: string, over: Partial<FleetGraphNode> = {}): FleetGraphNode {
  return {
    id, role: "", connected: true, epoch: 0, state: "working",
    pendingGate: false, spawnedBy: null, inTokens: 0, outTokens: 0, ...over,
  };
}
const spawn = (source: string, target: string) =>
  ({ id: `spawn:${source}->${target}`, source, target, kind: "spawn" as const });

describe("collapseFleetGraph — aggregate-by-name", () => {
  it("collapses same-role siblings into one group node when >= minGroup", () => {
    const graph: FleetGraph = {
      nodes: [
        anode("panel", { role: "conductor" }),
        anode("w1", { role: "worker", spawnedBy: "panel", inTokens: 10, outTokens: 5 }),
        anode("w2", { role: "worker", spawnedBy: "panel", inTokens: 20, outTokens: 7 }),
        anode("w3", { role: "worker", spawnedBy: "panel", state: "completed" }),
      ],
      edges: [spawn("panel", "w1"), spawn("panel", "w2"), spawn("panel", "w3")],
    };

    const out = collapseFleetGraph(graph, { minGroup: 3 });

    expect(out.nodes).toHaveLength(2); // panel + one worker group
    const group = out.nodes.find((n) => n.kind === "group")!;
    expect(group.role).toBe("worker");
    expect(group.count).toBe(3);
    expect(group.members).toEqual(["w1", "w2", "w3"]);
    expect(group.inTokens).toBe(30); // summed across members
    expect(group.outTokens).toBe(12);
    // the three spawn edges collapse to one deduped panel -> group edge
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: "panel", target: group.id, kind: "spawn" });
  });

  it("leaves a sub-threshold sibling set untouched (fan-out of 2 stays readable)", () => {
    const graph: FleetGraph = {
      nodes: [
        anode("panel", { role: "conductor" }),
        anode("w1", { role: "worker", spawnedBy: "panel" }),
        anode("w2", { role: "worker", spawnedBy: "panel" }),
      ],
      edges: [spawn("panel", "w1"), spawn("panel", "w2")],
    };

    const out = collapseFleetGraph(graph, { minGroup: 3 });

    expect(out.nodes).toHaveLength(3);
    expect(out.nodes.every((n) => n.kind === "agent")).toBe(true);
    expect(out.edges).toHaveLength(2);
  });
});

describe("collapseFleetGraph — subtree roll-up", () => {
  it("absorbs ungrouped descendants of collapsed members into the group", () => {
    const graph: FleetGraph = {
      nodes: [
        anode("panel", { role: "conductor" }),
        anode("w1", { role: "worker", spawnedBy: "panel" }),
        anode("w2", { role: "worker", spawnedBy: "panel" }),
        anode("w3", { role: "worker", spawnedBy: "panel" }),
        anode("t1", { role: "tool", spawnedBy: "w1", inTokens: 3, pendingGate: true }),
        anode("t2", { role: "tool", spawnedBy: "w2", inTokens: 4 }),
      ],
      edges: [
        spawn("panel", "w1"), spawn("panel", "w2"), spawn("panel", "w3"),
        spawn("w1", "t1"), spawn("w2", "t2"),
      ],
    };

    const out = collapseFleetGraph(graph, { minGroup: 3 });

    // only panel + the worker group survive; t1/t2 fold into the group
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["group:panel:worker", "panel"]);
    const group = out.nodes.find((n) => n.kind === "group")!;
    expect(group.descendants.sort()).toEqual(["t1", "t2"]);
    // absorbed descendants' tokens and pending gate roll into the group
    expect(group.inTokens).toBe(7);
    expect(group.pendingGate).toBe(true);
    // the w->t spawn edges are internal to the group and disappear; only panel->group remains
    expect(out.edges).toHaveLength(1);
    expect(out.edges[0]).toMatchObject({ source: "panel", target: group.id, kind: "spawn" });
  });

  it("keeps a nested fan-out that forms its own group as a separate node", () => {
    // w1..w3 collapse to a worker group; each spawns 3 subs of role "sub" — but
    // the subs are spread one-per-worker, so no (parent,role) bucket reaches 3.
    // Here all three subs share parent w1 → they form their OWN group under w1,
    // which is itself inside the worker group. That nested group stays visible.
    const graph: FleetGraph = {
      nodes: [
        anode("panel", { role: "conductor" }),
        anode("w1", { role: "worker", spawnedBy: "panel" }),
        anode("w2", { role: "worker", spawnedBy: "panel" }),
        anode("w3", { role: "worker", spawnedBy: "panel" }),
        anode("s1", { role: "sub", spawnedBy: "w1" }),
        anode("s2", { role: "sub", spawnedBy: "w1" }),
        anode("s3", { role: "sub", spawnedBy: "w1" }),
      ],
      edges: [
        spawn("panel", "w1"), spawn("panel", "w2"), spawn("panel", "w3"),
        spawn("w1", "s1"), spawn("w1", "s2"), spawn("w1", "s3"),
      ],
    };

    const out = collapseFleetGraph(graph, { minGroup: 3 });

    const ids = out.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["group:panel:worker", "group:w1:sub", "panel"]);
    // the sub-group's parent reroutes to the worker group it lives under
    const subGroup = out.nodes.find((n) => n.id === "group:w1:sub")!;
    expect(subGroup.spawnedBy).toBe("group:panel:worker");
    expect(out.edges.some((e) => e.source === "group:panel:worker" && e.target === "group:w1:sub")).toBe(true);
  });
});

describe("collapseFleetGraph — a group must not hide a failure", () => {
  it("surfaces a failed member as the group state, even amid working siblings", () => {
    const graph: FleetGraph = {
      nodes: [
        anode("panel", { role: "conductor" }),
        anode("w1", { role: "worker", spawnedBy: "panel", state: "working" }),
        anode("w2", { role: "worker", spawnedBy: "panel", state: "failed" }),
        anode("w3", { role: "worker", spawnedBy: "panel", state: "working" }),
      ],
      edges: [spawn("panel", "w1"), spawn("panel", "w2"), spawn("panel", "w3")],
    };
    const out = collapseFleetGraph(graph, { minGroup: 3 });
    const group = out.nodes.find((n) => n.kind === "group")!;
    expect(group.state).toBe("failed"); // a monitor never hides a red behind a green
  });
});

describe("collapseFleetGraph — clustering and level-of-detail", () => {
  it("tags every node with its role as the cluster", () => {
    const graph: FleetGraph = {
      nodes: [anode("panel", { role: "conductor" }), anode("w1", { role: "worker", spawnedBy: "panel" })],
      edges: [spawn("panel", "w1")],
    };
    const out = collapseFleetGraph(graph, { minGroup: 3 });
    expect(out.nodes.find((n) => n.id === "panel")!.cluster).toBe("conductor");
    expect(out.nodes.find((n) => n.id === "w1")!.cluster).toBe("worker");
  });

  it("drops detail as the node count crosses the budget", () => {
    const mk = (count: number): FleetGraph => ({
      nodes: Array.from({ length: count }, (_, i) => anode(`n${i}`, { role: `r${i}` })),
      edges: [],
    });
    // minGroup high so nothing collapses — node count == count.
    expect(collapseFleetGraph(mk(5), { minGroup: 99, maxNodes: 10 }).detail).toBe("full");
    expect(collapseFleetGraph(mk(15), { minGroup: 99, maxNodes: 10 }).detail).toBe("compact");
    expect(collapseFleetGraph(mk(25), { minGroup: 99, maxNodes: 10 }).detail).toBe("dot");
  });
});
