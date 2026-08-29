// Card 302: the DECLARED phase beats the derived wave.
//
// Card 293 ranked the lens by time overlap and card 297 widened that to every
// parent, and the header said so plainly: "Where a declared phase and a
// derived wave disagree, the picture shows the derived one." That is
// backwards. The phase existed in the script BEFORE the run; the wave is
// guessed afterwards from stamps that a slow start or a long tail moves. So a
// run that declared its columns gets the columns it declared, and the waves
// stay what they always were for a run that declared nothing.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { lensPhaseNodeId, nodeStateAt, spawnTree } from "./spawnTree";
import { initialScene } from "./labScene";
import type { WorkflowDeclaration } from "./workflowGraph";

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

const decl = (m: Record<string, number>, titles: string[]): WorkflowDeclaration =>
  new Map([
    [
      "wf",
      {
        phases: titles.map((title) => ({ title, detail: null })),
        rankOf: new Map(Object.entries(m)),
      },
    ],
  ]);

describe("a run that declared its phases", () => {
  it("without a declaration, the two overlapping agents share one derived wave", () => {
    const tree = spawnTree(overlapping());
    expect(tree.topo.ranks!.get("one")).toBe(tree.topo.ranks!.get("two"));
    expect(tree.declared).toBe(false);
  });

  it("with one, they sit in the columns the SCRIPT declared, overlap or not", () => {
    const tree = spawnTree(overlapping(), decl({ one: 0, two: 1 }, ["plan", "do"]));
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.ranks!.get("one")).toBe(wf + 1);
    expect(tree.topo.ranks!.get("two")).toBe(wf + 2);
    expect(tree.declared).toBe(true);
  });

  it("captions those columns with the script's own words", () => {
    const tree = spawnTree(overlapping(), decl({ one: 0, two: 1 }, ["plan", "do"]));
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.rankCaptions!.get(wf + 1)?.title).toBe("plan");
    expect(tree.topo.rankCaptions!.get(wf + 2)?.title).toBe("do");
    expect(tree.topo.rankCaptions!.has(wf)).toBe(false);
  });

  it("puts an agent the declaration never named one column past the declared ones", () => {
    const tree = spawnTree(overlapping(), decl({ one: 0 }, ["plan", "do"]));
    const wf = tree.topo.ranks!.get("wf")!;
    expect(tree.topo.ranks!.get("one")).toBe(wf + 1);
    expect(tree.topo.ranks!.get("two")).toBe(wf + 3);
  });

  it("leaves a run the declaration does not mention on its derived waves", () => {
    const other: WorkflowDeclaration = new Map([
      ["someone-else", { phases: [{ title: "x", detail: null }], rankOf: new Map([["nobody", 0]]) }],
    ]);
    const tree = spawnTree(overlapping(), other);
    expect(tree.topo.ranks!.get("one")).toBe(tree.topo.ranks!.get("two"));
    expect(tree.declared).toBe(false);
  });

  it("never captions a column two different runs claim with different words", () => {
    // Two runs at the SAME depth, so their phase columns land on the same
    // ranks. One name for two meanings would be a lie; no name is not.
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "wf1", parentId: "main", task: "run one", ts: 10 },
      { type: "agent_spawn", agentId: "wf2", parentId: "main", task: "run two", ts: 11 },
      // The two runs OVERLAP, so they share a wave and their phase columns
      // land on the same ranks — which is the only way the clash is reachable.
      { type: "text_delta", agentId: "wf1", text: "…", ts: 50 },
      { type: "text_delta", agentId: "wf2", text: "…", ts: 51 },
      { type: "agent_spawn", agentId: "c1", parentId: "wf1", task: "c1", ts: 20 },
      { type: "agent_spawn", agentId: "c2", parentId: "wf2", task: "c2", ts: 21 },
    ];
    const two: WorkflowDeclaration = new Map([
      ["wf1", { phases: [{ title: "plan", detail: null }], rankOf: new Map([["c1", 0]]) }],
      ["wf2", { phases: [{ title: "survey", detail: null }], rankOf: new Map([["c2", 0]]) }],
    ]);
    const tree = spawnTree(events, two);
    const r = tree.topo.ranks!.get("c1")!;
    expect(tree.topo.ranks!.get("c2")).toBe(r);
    expect(tree.topo.rankCaptions!.has(r)).toBe(false);
  });

  it("keeps one caption when both runs happen to agree on the word", () => {
    const events: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
      { type: "agent_spawn", agentId: "wf1", parentId: "main", task: "run one", ts: 10 },
      { type: "agent_spawn", agentId: "wf2", parentId: "main", task: "run two", ts: 11 },
      // The two runs OVERLAP, so they share a wave and their phase columns
      // land on the same ranks — which is the only way the clash is reachable.
      { type: "text_delta", agentId: "wf1", text: "…", ts: 50 },
      { type: "text_delta", agentId: "wf2", text: "…", ts: 51 },
      { type: "agent_spawn", agentId: "c1", parentId: "wf1", task: "c1", ts: 20 },
      { type: "agent_spawn", agentId: "c2", parentId: "wf2", task: "c2", ts: 21 },
    ];
    const two: WorkflowDeclaration = new Map([
      ["wf1", { phases: [{ title: "plan", detail: null }], rankOf: new Map([["c1", 0]]) }],
      ["wf2", { phases: [{ title: "plan", detail: null }], rankOf: new Map([["c2", 0]]) }],
    ]);
    const tree = spawnTree(events, two);
    expect(tree.topo.rankCaptions!.get(tree.topo.ranks!.get("c1")!)?.title).toBe("plan");
  });
});

describe("a declared phase the run never filled", () => {
  const decl3: WorkflowDeclaration = new Map([
    [
      "wf",
      {
        phases: [
          { title: "plan", detail: null },
          { title: "survey", detail: null },
          { title: "verify", detail: null },
        ],
        rankOf: new Map([
          ["one", 0],
          ["two", 2],
        ]),
      },
    ],
  ]);

  it("still gets a box, so the picture cannot quietly rewrite the plan", () => {
    const tree = spawnTree(overlapping(), decl3);
    const wf = tree.topo.ranks!.get("wf")!;
    const id = lensPhaseNodeId("wf", 1);
    expect(tree.topo.nodes.map((n) => n.id)).toContain(id);
    expect(tree.topo.ranks!.get(id)).toBe(wf + 2);
    expect(tree.meta[id].label).toBe("survey");
    // It is a placeholder, not a child: the honesty counts must read exactly
    // what they read without any declaration at all.
    const bare = spawnTree(overlapping());
    expect(tree.reported).toBe(bare.reported);
    expect(tree.resolved).toBe(bare.resolved);
  });

  it("reads as never entered — the state graph's own word for it", () => {
    const tree = spawnTree(overlapping(), decl3);
    const id = lensPhaseNodeId("wf", 1);
    expect(nodeStateAt(initialScene(), new Set(), new Map(), id, tree.root)).toBe("pending");
  });

  it("carries no spawn edge, because nothing spawned it", () => {
    const tree = spawnTree(overlapping(), decl3);
    const id = lensPhaseNodeId("wf", 1);
    expect(tree.topo.edges.some((e) => e.from === id || e.to === id)).toBe(false);
  });

  it("adds nothing at all for a phase that DID get an agent", () => {
    const tree = spawnTree(overlapping(), decl3);
    expect(tree.topo.nodes.map((n) => n.id)).not.toContain(lensPhaseNodeId("wf", 0));
    expect(tree.topo.nodes.map((n) => n.id)).not.toContain(lensPhaseNodeId("wf", 2));
  });
});
