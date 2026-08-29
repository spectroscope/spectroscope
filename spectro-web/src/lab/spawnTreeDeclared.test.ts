// Card 302: for a run that DECLARED its phases, the phase is the node and the
// edge means what follows what.
//
// Card 293's spawn edge — parent → child, dashed — is right for a Task tree,
// where the parent genuinely did start each child. A workflow is not that:
// its phases come out of one another, and drawing one edge from the parent to
// each of thirteen agents says the opposite. So a declared run collapses into
// a chain of phase boxes, and its agents live inside the box they belong to.
//
// The derived wave stays exactly what it was for a run that declared nothing,
// which is every Task spawn tree.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { lensPhaseNodeId, nodeStateAt, phaseStateAt, spawnTree } from "./spawnTree";
import { initialScene } from "./labScene";
import { phaseHeight, workflowGraph, type RunPhases, type WorkflowDeclaration } from "./workflowGraph";

/** Two agents whose lifetimes OVERLAP — one derived wave — but which the
 *  script put in two different phases. The stamps and the declaration
 *  disagree on purpose: that is the only case where the rule is visible. */
function overlapping(): RunEvent[] {
  return [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    { type: "agent_spawn", agentId: "wf", parentId: "main", task: "a run", ts: 10 },
    { type: "agent_spawn", agentId: "one", parentId: "wf", task: "first", ts: 20 },
    { type: "text_delta", agentId: "one", text: "…", ts: 90 },
    { type: "agent_spawn", agentId: "two", parentId: "wf", task: "second", ts: 30 },
    { type: "text_delta", agentId: "two", text: "…", ts: 95 },
  ];
}

const member = (agentId: string, state: RunPhases["unplaced"][number]["state"] = "done") => ({
  agentId,
  label: `label of ${agentId}`,
  model: "some-model",
  state,
  startedAt: 1,
  endedAt: 2,
});

/** A declaration for the node "wf": phase titles, and who ran in each. */
const decl = (titles: string[], per: string[][]): WorkflowDeclaration =>
  new Map([
    [
      "wf",
      {
        phases: titles.map((title, i) => ({
          title,
          detail: null,
          members: (per[i] ?? []).map((id) => member(id)),
        })),
        unplaced: [],
      },
    ],
  ]);

describe("a run that declared its phases", () => {
  it("without a declaration, the two overlapping agents share one derived wave", () => {
    const tree = spawnTree(overlapping());
    expect(tree.topo.ranks!.get("one")).toBe(tree.topo.ranks!.get("two"));
    expect(tree.declared).toBe(false);
  });

  it("draws its PHASES, not its agents", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    const ids = tree.topo.nodes.map((n) => n.id);
    expect(ids).toContain(lensPhaseNodeId("wf", 0));
    expect(ids).toContain(lensPhaseNodeId("wf", 1));
    expect(ids).not.toContain("one");
    expect(ids).not.toContain("two");
    expect(tree.declared).toBe(true);
  });

  it("chains them: wf → phase 0 → phase 1, and NOTHING else out of wf", () => {
    // The defect this card exists to undo: thirteen agents each taking their
    // own edge from the parent, thirteen arcs across the whole canvas.
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    const out = tree.topo.edges.filter((e) => e.from === "wf");
    expect(out.map((e) => e.to)).toEqual([lensPhaseNodeId("wf", 0)]);
    expect(tree.topo.edges).toContainEqual({
      from: lensPhaseNodeId("wf", 0),
      to: lensPhaseNodeId("wf", 1),
      kind: "direct",
    });
  });

  it("keeps the run's own spawn a reconstruction — dashed stays dashed", () => {
    // The workflow node itself was NOT declared by anybody; the session's
    // events are the only reason it is on screen. Only the phases are solid.
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    expect(tree.declaredNodes.has("wf")).toBe(false);
    expect(tree.declaredNodes.has(lensPhaseNodeId("wf", 0))).toBe(true);
    expect(tree.topo.edges.find((e) => e.to === "wf")?.kind).toBe("spawn");
  });

  it("ranks the phases in the script's order, right after the run's own node", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.ranks!.get(lensPhaseNodeId("wf", 0))).toBe(wf + 1);
    expect(tree.topo.ranks!.get(lensPhaseNodeId("wf", 1))).toBe(wf + 2);
  });

  it("captions those columns with the script's own words", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.rankCaptions!.get(wf + 1)?.title).toBe("plan");
    expect(tree.topo.rankCaptions!.get(wf + 2)?.title).toBe("do");
  });

  it("lists its agents INSIDE the box, with their label and model", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    const meta = tree.meta[lensPhaseNodeId("wf", 0)];
    expect(meta.label).toBe("plan");
    expect(meta.members.map((m) => m.agentId)).toEqual(["one"]);
    expect(meta.members[0].label).toBe("label of one");
    expect(meta.members[0].model).toBe("some-model");
  });

  it("states the box's height from what it holds, so the column packs around it", () => {
    const tree = spawnTree(overlapping(), decl(["wide"], [["one", "two"]]));
    expect(tree.topo.heights!.get(lensPhaseNodeId("wf", 0))).toBe(phaseHeight(2));
  });

  it("still counts what the RECONSTRUCTION resolved — the chip is about the events", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "do"], [["one"], ["two"]]));
    expect(tree.reported).toBe(3);
    expect(tree.resolved).toBe(3);
  });
});

describe("a phase the script promised and the run never filled", () => {
  it("is still a box, in its own column, with the chain running through it", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "gap", "do"], [["one"], [], ["two"]]));
    const gap = lensPhaseNodeId("wf", 1);
    expect(tree.topo.nodes.map((n) => n.id)).toContain(gap);
    expect(tree.meta[gap].members).toEqual([]);
    expect(tree.topo.edges).toContainEqual({ from: lensPhaseNodeId("wf", 0), to: gap, kind: "direct" });
    expect(tree.topo.edges).toContainEqual({ from: gap, to: lensPhaseNodeId("wf", 2), kind: "direct" });
  });

  it("reads pending — the state graph's own word for never entered", () => {
    const tree = spawnTree(overlapping(), decl(["plan", "gap"], [["one"], []]));
    const gap = lensPhaseNodeId("wf", 1);
    const scene = initialScene();
    expect(phaseStateAt(scene, new Set(), new Map(), tree, gap)).toBe("pending");
  });
});

describe("a phase box's own state", () => {
  const tree = () => spawnTree(overlapping(), decl(["plan"], [["one", "two"]]));
  const phase = lensPhaseNodeId("wf", 0);

  it("follows the CURSOR for an agent the stream carries", () => {
    // Nothing spawned yet: the box is pending even though the state file's
    // word for both members is `done`. The stepper is the point of the lens.
    const t = tree();
    expect(phaseStateAt(initialScene(), new Set(), new Map(), t, phase)).toBe("pending");
    // Both reached and both finished: done.
    const spawned = new Set(["one", "two"]);
    const ended = new Map<string, "completed" | "failed">([
      ["one", "completed"],
      ["two", "completed"],
    ]);
    expect(phaseStateAt(initialScene(), spawned, ended, t, phase)).toBe("done");
  });

  it("shows failed the moment one member failed, while the other still runs", () => {
    const t = tree();
    const spawned = new Set(["one", "two"]);
    const ended = new Map<string, "completed" | "failed">([["one", "failed"]]);
    expect(phaseStateAt(initialScene(), spawned, ended, t, phase)).toBe("failed");
  });

  it("falls back to the state file for an agent no transcript recorded", () => {
    // A run's state file names every agent; the import only carries the ones
    // whose sidecar was picked. An agent the stream never met would read
    // "pending" forever off the cursor, which is a lie about a finished run.
    const declared: WorkflowDeclaration = new Map([
      ["wf", { phases: [{ title: "p", detail: null, members: [member("ghost")] }], unplaced: [] }],
    ]);
    const t = spawnTree(overlapping(), declared);
    expect(phaseStateAt(initialScene(), new Set(), new Map(), t, lensPhaseNodeId("wf", 0))).toBe("done");
  });
});

describe("an agent the declaration could not place", () => {
  it("gets a box past the declared columns, uncaptioned and unattached", () => {
    const declared: WorkflowDeclaration = new Map([
      [
        "wf",
        {
          phases: [{ title: "p", detail: null, members: [member("one")] }],
          unplaced: [member("two")],
        },
      ],
    ]);
    const tree = spawnTree(overlapping(), declared);
    const stray = tree.topo.nodes.find((n) => n.id.endsWith(":unplaced"))!;
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.ranks!.get(stray.id)).toBe(wf + 2);
    expect(tree.topo.edges.filter((e) => e.to === stray.id)).toEqual([]);
    expect(tree.topo.rankCaptions!.get(wf + 2)).toBeUndefined();
    expect(tree.meta[stray.id].members.map((m) => m.agentId)).toEqual(["two"]);
  });
});

describe("what the declaration does NOT govern", () => {
  const mixed = (): RunEvent[] => [
    ...overlapping(),
    { type: "agent_spawn", agentId: "task", parentId: "main", task: "a plain child", ts: 15 },
    { type: "text_delta", agentId: "task", text: "…", ts: 80 },
  ];

  it("leaves a plain Task sibling drawn as a spawn, dashed, in its derived wave", () => {
    const tree = spawnTree(mixed(), decl(["plan", "do"], [["one"], ["two"]]));
    expect(tree.topo.nodes.map((n) => n.id)).toContain("task");
    expect(tree.declaredNodes.has("task")).toBe(false);
    expect(tree.topo.edges).toContainEqual({ from: "main", to: "task", kind: "spawn" });
  });

  it("refuses the script's word for a column a guess also stands in", () => {
    // One name over two meanings is a lie; an unnamed column is only a
    // column. The plain sibling's wave lands on the same rank as phase 0.
    const tree = spawnTree(mixed(), decl(["plan", "do"], [["one"], ["two"]]));
    expect(tree.topo.ranks!.get("task")).toBe(tree.topo.ranks!.get(lensPhaseNodeId("wf", 0)));
    expect(tree.topo.rankCaptions!.get(tree.topo.ranks!.get("task")!)).toBeUndefined();
  });

  it("keeps nodeStateAt untouched for everything that is still an agent", () => {
    const tree = spawnTree(mixed(), decl(["plan", "do"], [["one"], ["two"]]));
    expect(nodeStateAt(initialScene(), new Set(["task"]), new Map(), "task", tree.root)).toBe("done");
  });
});

describe("the reader and the lens draw ONE chain", () => {
  // Two callers build the same succession: the reader, for a state file read
  // on its own, and the lens, splicing it into a tree that can hold other
  // children beside it. They must not drift, so the agreement is pinned
  // rather than trusted to two sets of tests that never meet.
  it("agrees edge for edge and height for height", () => {
    const run: RunPhases = {
      phases: ["plan", "survey", "gap", "verify"].map((title, i) => ({
        title,
        detail: null,
        members: i === 1 ? [member("one"), member("two")] : i === 2 ? [] : [member(`only-${i}`)],
      })),
      unplaced: [],
    };
    const tree = spawnTree(overlapping(), new Map([["wf", run]]));
    const read = workflowGraph(run, "wf");
    const chain = (es: { from: string; to: string; kind: string }[]) =>
      es.filter((e) => e.kind === "direct").map((e) => `${e.from}->${e.to}`);
    expect(chain(tree.topo.edges)).toEqual(chain(read.topo.edges));
    expect(chain(read.topo.edges)).toHaveLength(4);
    for (const [id, h] of read.topo.heights!) expect(tree.topo.heights!.get(id)).toBe(h);
  });
});
