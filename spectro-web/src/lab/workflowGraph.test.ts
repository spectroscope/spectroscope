// Card 302: a workflow run read as a state graph — declared columns, executed
// occupancy. Every fixture here is invented; nothing is copied out of a
// recording.

import { describe, expect, it } from "vitest";
import { lifecycleAt } from "../stategraph/artifact";
import { layoutStateGraph } from "../stategraph/layout";
import { WORKFLOW_LIFECYCLE, phaseNodeId, readWorkflowState, workflowGraph } from "./workflowGraph";

/** The measured shape of a real run, rebuilt from nothing but its numbers:
 *  five declared phases, thirteen agents, occupancy 1/5/1/1/5. `phaseIndex`
 *  is ONE-based in the file — measured, not assumed. */
function sample(): string {
  const phases = ["plan", "survey", "consolidate", "deliver", "verify"].map((title, i) => ({
    title,
    detail: `what ${title} is for`,
    index: i + 1,
  }));
  const widths = [1, 5, 1, 1, 5];
  const agents: unknown[] = [];
  let n = 0;
  widths.forEach((w, p) => {
    for (let k = 0; k < w; k++) {
      n += 1;
      agents.push({
        type: "workflow_agent",
        index: n,
        agentId: `a${n}`,
        label: `agent ${n}`,
        phaseIndex: p + 1,
        phaseTitle: phases[p].title,
        model: "some-model",
        state: "done",
        queuedAt: 1000 + n,
        startedAt: 1100 + n,
        durationMs: 50,
      });
    }
  });
  return JSON.stringify({
    workflowName: "a run",
    agentCount: n,
    status: "completed",
    phases: phases.map((p) => ({ title: p.title, detail: p.detail })),
    workflowProgress: [
      ...phases.map((p) => ({ type: "workflow_phase", index: p.index, title: p.title })),
      ...agents,
    ],
  });
}

describe("readWorkflowState", () => {
  it("reads the declared phases and the run's agents", () => {
    const s = readWorkflowState(sample())!;
    expect(s.name).toBe("a run");
    expect(s.phases.map((p) => p.title)).toEqual(["plan", "survey", "consolidate", "deliver", "verify"]);
    expect(s.phases[0].detail).toBe("what plan is for");
    expect(s.agents).toHaveLength(13);
  });

  it("is null for anything that is not a JSON object, and empty for one with nothing in it", () => {
    expect(readWorkflowState("not json")).toBeNull();
    expect(readWorkflowState("[1,2]")).toBeNull();
    const bare = readWorkflowState("{}")!;
    expect(bare.phases).toEqual([]);
    expect(bare.agents).toEqual([]);
  });
});

describe("workflowGraph", () => {
  it("puts every agent in its DECLARED phase column: 13 nodes over 5 ranks, 1/5/1/1/5", () => {
    const g = workflowGraph(readWorkflowState(sample())!);
    expect(g.topo.nodes).toHaveLength(13);
    const ranks = g.topo.ranks!;
    const width = [0, 0, 0, 0, 0];
    for (const n of g.topo.nodes) width[ranks.get(n.id)!] += 1;
    expect(width).toEqual([1, 5, 1, 1, 5]);
  });

  it("ranks from ZERO even though the file counts phases from one", () => {
    const g = workflowGraph(readWorkflowState(sample())!);
    expect([...new Set(g.topo.ranks!.values())].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("captions each rank with the phase's own title and detail", () => {
    const g = workflowGraph(readWorkflowState(sample())!);
    expect(g.topo.rankCaptions!.get(0)).toEqual({ title: "plan", detail: "what plan is for" });
    expect(g.topo.rankCaptions!.get(4)?.title).toBe("verify");
  });

  it("wires phase N to phase N+1 and nowhere else, solid — the ORDER is declared", () => {
    const g = workflowGraph(readWorkflowState(sample())!);
    // 1->5, 5->1, 1->1, 1->5.
    expect(g.topo.edges).toHaveLength(5 + 5 + 1 + 5);
    expect(new Set(g.topo.edges.map((e) => e.kind))).toEqual(new Set(["direct"]));
    const ranks = g.topo.ranks!;
    for (const e of g.topo.edges) expect(ranks.get(e.to)! - ranks.get(e.from)!).toBe(1);
  });

  it("lights every agent through the SHARED fold, in its own vocabulary", () => {
    const g = workflowGraph(readWorkflowState(sample())!);
    const end = g.records.length - 1;
    for (const n of g.topo.nodes) expect(lifecycleAt(g.records, end, n.id, WORKFLOW_LIFECYCLE)).toBe("done");
    // And the cursor still means something: before any record, nothing is lit.
    expect(lifecycleAt(g.records, -1, "a1", WORKFLOW_LIFECYCLE)).toBe("pending");
  });
});

/** Each state value is bitten on its own. The vocabulary is MEASURED, not the
 *  one the card guessed: the file says done / error / progress / start, and it
 *  has no word for "queued" at all — a queued agent is one with a queuedAt and
 *  no start. */
describe("the state vocabulary", () => {
  const one = (state: string | null, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      phases: [{ title: "only", detail: null }],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "only" },
        {
          type: "workflow_agent",
          index: 1,
          agentId: "a1",
          label: "a",
          phaseIndex: 1,
          state,
          queuedAt: 1,
          startedAt: 2,
          durationMs: 3,
          ...extra,
        },
      ],
    });
  const life = (json: string): string => {
    const g = workflowGraph(readWorkflowState(json)!);
    return lifecycleAt(g.records, g.records.length - 1, "a1", WORKFLOW_LIFECYCLE);
  };

  it("done is done", () => expect(life(one("done"))).toBe("done"));
  it("error is error", () => expect(life(one("error"))).toBe("error"));
  it("progress is active", () => expect(life(one("progress"))).toBe("active"));
  it("start is active", () => expect(life(one("start"))).toBe("active"));
  it("queued but never started is pending", () =>
    expect(life(one(null, { startedAt: null }))).toBe("pending"));
  it("a word the file has never used is pending, not a guess", () =>
    expect(life(one("banana", { startedAt: null }))).toBe("pending"));
});

describe("a declared phase with no agents", () => {
  const json = JSON.stringify({
    phases: [
      { title: "one", detail: "d1" },
      { title: "two", detail: "d2" },
      { title: "three", detail: "d3" },
    ],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "one" },
      { type: "workflow_phase", index: 2, title: "two" },
      { type: "workflow_phase", index: 3, title: "three" },
      {
        type: "workflow_agent",
        index: 1,
        agentId: "a1",
        label: "a",
        phaseIndex: 1,
        state: "done",
        startedAt: 2,
        durationMs: 1,
      },
      {
        type: "workflow_agent",
        index: 2,
        agentId: "a2",
        label: "b",
        phaseIndex: 3,
        state: "done",
        startedAt: 4,
        durationMs: 1,
      },
    ],
  });

  it("is a real node, drawn, and never entered", () => {
    const g = workflowGraph(readWorkflowState(json)!);
    const id = phaseNodeId(1);
    expect(g.topo.nodes.map((n) => n.id)).toContain(id);
    expect(g.topo.ranks!.get(id)).toBe(1);
    expect(lifecycleAt(g.records, g.records.length - 1, id, WORKFLOW_LIFECYCLE)).toBe("pending");
    expect(g.emptyPhases).toEqual(new Set([id]));
  });

  it("keeps the chain unbroken through the gap", () => {
    const g = workflowGraph(readWorkflowState(json)!);
    expect(g.topo.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(
      [`a1->${phaseNodeId(1)}`, `${phaseNodeId(1)}->a2`].sort(),
    );
  });
});

describe("an agent whose phaseIndex names no declared phase", () => {
  const json = JSON.stringify({
    phases: [{ title: "one", detail: null }],
    workflowProgress: [
      { type: "workflow_phase", index: 1, title: "one" },
      {
        type: "workflow_agent",
        index: 1,
        agentId: "a1",
        label: "a",
        phaseIndex: 1,
        state: "done",
        startedAt: 1,
        durationMs: 1,
      },
      {
        type: "workflow_agent",
        index: 2,
        agentId: "a2",
        label: "b",
        phaseIndex: 9,
        state: "done",
        startedAt: 2,
        durationMs: 1,
      },
      {
        type: "workflow_agent",
        index: 3,
        agentId: "a3",
        label: "c",
        state: "done",
        startedAt: 3,
        durationMs: 1,
      },
    ],
  });

  it("is drawn in a column of its own, past the declared ones, with no caption to invent", () => {
    const g = workflowGraph(readWorkflowState(json)!);
    expect(g.topo.ranks!.get("a1")).toBe(0);
    expect(g.topo.ranks!.get("a2")).toBe(1);
    expect(g.topo.ranks!.get("a3")).toBe(1);
    expect(g.topo.rankCaptions!.has(1)).toBe(false);
    expect(g.undeclared).toBe(2);
  });
});

describe("the layout carries the captions out to the renderer", () => {
  it("captions every occupied rank label, and leaves an uncaptioned column bare", () => {
    const json = JSON.stringify({
      phases: [
        { title: "one", detail: "d1" },
        { title: "two", detail: null },
      ],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "one" },
        { type: "workflow_phase", index: 2, title: "two" },
        {
          type: "workflow_agent",
          index: 1,
          agentId: "a1",
          label: "a",
          phaseIndex: 1,
          state: "done",
          startedAt: 1,
          durationMs: 1,
        },
        {
          type: "workflow_agent",
          index: 2,
          agentId: "a2",
          label: "b",
          phaseIndex: 2,
          state: "done",
          startedAt: 2,
          durationMs: 1,
        },
        {
          type: "workflow_agent",
          index: 3,
          agentId: "a3",
          label: "c",
          phaseIndex: 7,
          state: "done",
          startedAt: 3,
          durationMs: 1,
        },
      ],
    });
    const laid = layoutStateGraph(workflowGraph(readWorkflowState(json)!).topo, "horizontal");
    expect(laid.rankLabels.map((l) => l.caption?.title ?? null)).toEqual(["one", "two", null]);
    expect(laid.rankLabels[0].caption?.detail).toBe("d1");
    expect(laid.rankLabels[1].caption?.detail).toBeNull();
  });
});
