// The workflow lens's reconstruction (card 293, owner call C 2026-08-28):
// an edge is the REAL spawn relation (parent → child), and the POSITION
// carries time — nodes sit in their time-overlap waves via the layout's rank
// override. Both truths in one picture, neither lies. The fixture below is
// synthetic but pins the measured target shape: root, one planning child,
// one rank of five parallel scouts, then a three-step tail — five child
// ranks, widest five, every edge from the root that spawned them.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { layoutStateGraph } from "../stategraph/layout";
import { nodeStateAt, spawnedIn, spawnTree, terminalStatesIn } from "./spawnTree";
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

  it("draws every edge from the root that spawned them — variant C, no synthesized precedence", () => {
    const tree = spawnTree(pipelineEvents());
    expect(edgeSet(tree)).toEqual(
      [
        "main->plan-check",
        ...["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"].map((s) => `main->${s}`),
        "main->consolidate",
        "main->deliver",
        "main->publish",
      ].sort(),
    );
    // Every reconstructed edge is a spawn edge — the dashed kind.
    tree.topo.edges.forEach((e) => expect(e.kind).toBe("spawn"));
  });

  it("supplies the wave ranks to the layout instead of encoding them as edges", () => {
    const tree = spawnTree(pipelineEvents());
    const ranks = tree.topo.ranks!;
    expect(ranks.get("main")).toBe(0);
    expect(ranks.get("plan-check")).toBe(1);
    for (const s of ["scout-a", "scout-b", "scout-c", "scout-d", "scout-e"]) {
      expect(ranks.get(s), s).toBe(2);
    }
    expect(ranks.get("consolidate")).toBe(3);
    expect(ranks.get("deliver")).toBe(4);
    expect(ranks.get("publish")).toBe(5);
  });

  it("routes the root's long edges to late waves over the skip lane, every edge routed", () => {
    const tree = spawnTree(pipelineEvents());
    const laid = layoutStateGraph(tree.topo, "horizontal");
    // Every edge got a routed path — none dropped, none empty.
    expect(laid.edges).toHaveLength(tree.topo.edges.length);
    for (const e of laid.edges) expect(e.path.length, e.id).toBeGreaterThan(0);
    // The edges into the waves beyond plan-check cross ranks whose single
    // boxes sit on the axis — they must fly the skip lane, not cut through.
    for (const to of ["consolidate", "deliver", "publish"]) {
      expect(laid.edges.find((e) => e.from === "main" && e.to === to)!.skip, to).toBe(true);
    }
    expect(laid.edges.filter((e) => e.skip).length).toBeGreaterThan(0);
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
    // Position carries time for the orphan too: it ran and ended before the
    // worker began, so it takes the first wave and the worker the second.
    expect(tree.topo.ranks!.get("orphan")).toBe(1);
    expect(tree.topo.ranks!.get("worker")).toBe(2);
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
    // A nested child overlaps its parent by construction, so a time wave
    // cannot separate them — it ranks one step past its parent instead.
    expect(tree.topo.ranks!.get("worker")).toBe(1);
    expect(tree.topo.ranks!.get("grandchild")).toBe(2);
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

  // Card 298 moved the identity fold into agentDirectory.ts, where it now
  // records EVERY agent the stream names. This lens keeps only the reported
  // ones, which is what makes `reported` mean what its doc says it means.
  it("reports only the children an agent_spawn frame named", () => {
    const only: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      {
        type: "agent_message",
        from: "main",
        to: "no-spawn",
        role: "task",
        state: "submitted",
        text: "do it",
        ts: 1,
      },
      ...child("spawned", 2, 3, "the reported one"),
    ];
    const tree = spawnTree(only);
    expect(tree.reported).toBe(1);
    expect(tree.topo.nodes.map((n) => n.id)).toEqual(["main", "spawned"]);
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
      nodeStateAt(
        sceneAt(beforeSpawn),
        spawnedIn(events.slice(0, beforeSpawn)),
        terminalStatesIn(events.slice(0, beforeSpawn)),
        "scout-a",
        "main",
      ),
    ).toBe("pending");
    const midScouts = events.findIndex((e) => e.type === "agent_spawn" && e.agentId === "consolidate");
    expect(
      nodeStateAt(
        sceneAt(midScouts),
        spawnedIn(events.slice(0, midScouts)),
        terminalStatesIn(events.slice(0, midScouts)),
        "scout-a",
        "main",
      ),
    ).toBe("active");
    const all = events.length;
    expect(
      nodeStateAt(
        sceneAt(all),
        spawnedIn(events.slice(0, all)),
        terminalStatesIn(events.slice(0, all)),
        "scout-a",
        "main",
      ),
    ).toBe("done");
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
    expect(nodeStateAt(scene, spawnedIn(completing), terminalStatesIn(completing), "worker", "main")).toBe(
      "done",
    );
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
    expect(nodeStateAt(scene, spawnedIn(failing), terminalStatesIn(failing), "worker", "main")).toBe(
      "failed",
    );
  });

  it("keeps a failed child failed after run_end — the imported run's resting cursor", () => {
    // An IMPORTED run is complete: its resting cursor sits after run_end,
    // where the scene no longer carries any child. The terminal-state map is
    // what still remembers HOW each child ended.
    const ended: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "worker", parentId: "main", task: "t", ts: 1 },
      { type: "agent_spawn", agentId: "sibling", parentId: "main", task: "u", ts: 2 },
      {
        type: "agent_message",
        from: "worker",
        to: "main",
        role: "result",
        state: "failed",
        text: "gave up",
        ts: 3,
      },
      {
        type: "agent_message",
        from: "sibling",
        to: "main",
        role: "result",
        state: "completed",
        text: "all done",
        ts: 4,
      },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 5 },
    ];
    const scene = ended.reduce((s, e) => advanceScene(s, e), initialScene());
    // Premise of this pin: the scene has retired the children.
    expect(scene.subagents).toEqual([]);
    const spawned = spawnedIn(ended);
    const terminal = terminalStatesIn(ended);
    expect(nodeStateAt(scene, spawned, terminal, "worker", "main")).toBe("failed");
    expect(nodeStateAt(scene, spawned, terminal, "sibling", "main")).toBe("done");
  });

  it("walks the root through pending, active and done", () => {
    expect(nodeStateAt(sceneAt(0), spawnedIn([]), terminalStatesIn([]), "main", "main")).toBe("pending");
    expect(
      nodeStateAt(
        sceneAt(3),
        spawnedIn(events.slice(0, 3)),
        terminalStatesIn(events.slice(0, 3)),
        "main",
        "main",
      ),
    ).toBe("active");
    expect(
      nodeStateAt(sceneAt(events.length), spawnedIn(events), terminalStatesIn(events), "main", "main"),
    ).toBe("done");
  });
});
