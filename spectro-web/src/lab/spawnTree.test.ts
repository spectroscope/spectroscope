// The workflow lens's reconstruction (card 293): the run's agents as a
// topology for the UNCHANGED layoutStateGraph. Nodes are the agents, edges
// follow the spawn tree, and the RANK comes from time overlap — children
// whose lifetimes overlap share a rank. The fixture below is synthetic but
// pins the measured target shape: root, one planning child, one rank of five
// parallel scouts, then a three-step tail — five child ranks, widest five.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { layoutStateGraph } from "../stategraph/layout";
import { nodeStateAt, spawnedIn, spawnTree } from "./spawnTree";
import { advanceScene, initialScene, type Scene } from "./labScene";

/** One child: spawned at `start`, last heard from at `end`. */
function child(id: string, start: number, end: number, task: string, parentId = "main"): RunEvent[] {
  return [
    { type: "agent_spawn", agentId: id, parentId, task, ts: start },
    { type: "text_delta", agentId: id, text: "…", ts: end },
  ];
}

/** The measured target shape, rebuilt synthetically: a planning child, five
 *  overlapping scouts, then consolidate → deliver → publish, all spawned by
 *  the root. Interleaved in timestamp order, the way a real stream arrives. */
function pipelineEvents(): RunEvent[] {
  const events: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    ...child("plan-check", 100, 200, "plan the pass and check the premise"),
    ...child("scout-a", 210, 280, "scout target a"),
    ...child("scout-b", 215, 300, "scout target b"),
    ...child("scout-c", 220, 285, "scout target c"),
    ...child("scout-d", 225, 290, "scout target d"),
    ...child("scout-e", 230, 295, "scout target e"),
    ...child("consolidate", 310, 400, "consolidate the findings"),
    ...child("deliver", 410, 500, "deliver the report"),
    ...child("publish", 510, 600, "publish the summary"),
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 610 },
  ];
  return events.sort((a, b) => a.ts - b.ts);
}

const edgeSet = (t: ReturnType<typeof spawnTree>) => t.topo.edges.map((e) => `${e.from}->${e.to}`).sort();

describe("spawnTree — the reconstructed workflow topology", () => {
  it("pins the measured target shape: five child ranks, widest five", () => {
    const tree = spawnTree(pipelineEvents());
    const laid = layoutStateGraph(tree.topo, "horizontal");
    const rankOf = (id: string) => laid.nodes.find((n) => n.id === id)!.rank;

    expect(rankOf("main")).toBe(0);
    expect(rankOf("plan-check")).toBe(1);
    for (const s of ["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"]) {
      expect(rankOf(s), s).toBe(2);
    }
    expect(rankOf("consolidate")).toBe(3);
    expect(rankOf("deliver")).toBe(4);
    expect(rankOf("publish")).toBe(5);
    expect(laid.maxRank).toBe(5);
    // Widest rank: the five parallel scouts.
    const widest = Math.max(
      ...Array.from({ length: laid.maxRank + 1 }, (_, r) => laid.nodes.filter((n) => n.rank === r).length),
    );
    expect(widest).toBe(5);
  });

  it("chains consecutive waves and fans in/out at the parallel rank", () => {
    const tree = spawnTree(pipelineEvents());
    expect(edgeSet(tree)).toEqual(
      [
        "main->plan-check",
        ...["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"].map((s) => `plan-check->${s}`),
        ...["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"].map((s) => `${s}->consolidate`),
        "consolidate->deliver",
        "deliver->publish",
      ].sort(),
    );
    // Every reconstructed edge is a spawn edge — the dashed kind.
    tree.topo.edges.forEach((e) => expect(e.kind).toBe("spawn"));
  });

  it("counts the honesty chip's values: nine reported, nine resolved", () => {
    const tree = spawnTree(pipelineEvents());
    expect(tree.reported).toBe(9);
    expect(tree.resolved).toBe(9);
  });

  it("keeps a child with an unresolvable parent, attached to root and counted as unresolved", () => {
    const raw: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      ...child("orphan", 50, 90, "a child whose parent never appears", "ghost-parent"),
      ...child("worker", 100, 200, "a resolved child"),
    ];
    const events = raw.sort((a, b) => a.ts - b.ts);
    const tree = spawnTree(events);
    expect(tree.topo.nodes.map((n) => n.id)).toContain("orphan");
    expect(edgeSet(tree)).toContain("main->orphan");
    expect(tree.reported).toBe(2);
    expect(tree.resolved).toBe(1);
    expect(tree.meta["orphan"].parentResolved).toBe(false);
    expect(tree.meta["worker"].parentResolved).toBe(true);
  });

  it("hangs a nested child under its real parent, not under root", () => {
    const raw: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      ...child("worker", 100, 400, "a first-level child"),
      ...child("grandchild", 150, 300, "spawned by the worker", "worker"),
    ];
    const events = raw.sort((a, b) => a.ts - b.ts);
    const tree = spawnTree(events);
    expect(edgeSet(tree)).toContain("worker->grandchild");
    expect(edgeSet(tree)).not.toContain("main->grandchild");
  });

  it("reads model and agent type where the run said them", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "worker", parentId: "main", task: "scout target a", ts: 100 },
      {
        type: "agent_message",
        from: "main",
        to: "worker",
        role: "task",
        state: "submitted",
        text: "scout target a",
        label: "app-scout",
        ts: 101,
      },
      {
        type: "run_start",
        runId: "c1",
        agentId: "worker",
        parentId: "main",
        prompt: "scout",
        model: "m-small",
        ts: 102,
      },
    ];
    const tree = spawnTree(events);
    expect(tree.meta["worker"].agentType).toBe("app-scout");
    expect(tree.meta["worker"].model).toBe("m-small");
    expect(tree.meta["worker"].label).toBe("scout target a");
  });

  it("yields a lone root for a run with no children", () => {
    const tree = spawnTree([{ type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 }]);
    expect(tree.topo.nodes.map((n) => n.id)).toEqual(["main"]);
    expect(tree.topo.edges).toEqual([]);
    expect(tree.reported).toBe(0);
  });
});

describe("nodeStateAt — the cursor lights the graph from the ONE scene fold", () => {
  const events = pipelineEvents();
  const sceneAt = (upto: number): Scene =>
    events.slice(0, upto).reduce((s, e) => advanceScene(s, e), initialScene());

  it("shows a child pending before its spawn, active while it lives, done after the run", () => {
    const beforeSpawn = 1; // only run_start applied
    expect(
      nodeStateAt(sceneAt(beforeSpawn), spawnedIn(events.slice(0, beforeSpawn)), "scout-a", "main"),
    ).toBe("pending");
    const midScouts = events.findIndex((e) => e.type === "agent_spawn" && e.agentId === "consolidate");
    expect(nodeStateAt(sceneAt(midScouts), spawnedIn(events.slice(0, midScouts)), "scout-a", "main")).toBe(
      "active",
    );
    const all = events.length;
    expect(nodeStateAt(sceneAt(all), spawnedIn(events.slice(0, all)), "scout-a", "main")).toBe("done");
  });

  it("marks a completed child as done while the scene still carries it", () => {
    const completing: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "worker", parentId: "main", task: "t", ts: 1 },
      {
        type: "agent_message",
        from: "worker",
        to: "main",
        role: "result",
        state: "completed",
        text: "all done",
        ts: 2,
      },
    ];
    const scene = completing.reduce((s, e) => advanceScene(s, e), initialScene());
    expect(nodeStateAt(scene, spawnedIn(completing), "worker", "main")).toBe("done");
  });

  it("marks a failed child as failed while the scene still carries it", () => {
    const failing: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "worker", parentId: "main", task: "t", ts: 1 },
      {
        type: "agent_message",
        from: "worker",
        to: "main",
        role: "result",
        state: "failed",
        text: "gave up",
        ts: 2,
      },
    ];
    const scene = failing.reduce((s, e) => advanceScene(s, e), initialScene());
    expect(nodeStateAt(scene, spawnedIn(failing), "worker", "main")).toBe("failed");
  });

  it("walks the root through pending, active and done", () => {
    expect(nodeStateAt(sceneAt(0), spawnedIn([]), "main", "main")).toBe("pending");
    expect(nodeStateAt(sceneAt(3), spawnedIn(events.slice(0, 3)), "main", "main")).toBe("active");
    expect(nodeStateAt(sceneAt(events.length), spawnedIn(events), "main", "main")).toBe("done");
  });
});
