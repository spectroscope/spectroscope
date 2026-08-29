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

/**
 * A declared workflow does not get the tree to itself. The run's main agent
 * spawns plain Task children beside the workflow, and their GUESSED waves land
 * on the same columns the workflow's script named — so a caption saying "plan"
 * would be standing over an agent the script never mentioned, and its
 * time-guessed spawn edge would be drawn in the stroke that means "declared".
 *
 * The declaration is per NODE, not per tree. A column a guess also occupies
 * loses its word, the same way a column two runs claim with different words
 * does; and only the boxes a declaration placed are named as declared, so the
 * lens can draw the rest the way card 293 always drew them.
 */
describe("a declared workflow beside plain Task siblings", () => {
  const mixed = (): RunEvent[] => [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    { type: "agent_spawn", agentId: "wf", parentId: "main", task: "a run", ts: 10 },
    { type: "agent_spawn", agentId: "p1", parentId: "wf", task: "phase one", ts: 12 },
    { type: "agent_spawn", agentId: "p2", parentId: "wf", task: "phase two", ts: 13 },
    { type: "agent_spawn", agentId: "p3", parentId: "wf", task: "phase three", ts: 14 },
    { type: "text_delta", agentId: "wf", text: "…", ts: 20 },
    // Two plain siblings of the workflow, in their own derived waves.
    { type: "agent_spawn", agentId: "sibB", parentId: "main", task: "something else", ts: 30 },
    { type: "text_delta", agentId: "sibB", text: "…", ts: 40 },
    { type: "agent_spawn", agentId: "sibC", parentId: "main", task: "another thing", ts: 50 },
    { type: "text_delta", agentId: "sibC", text: "…", ts: 60 },
  ];
  const three = decl({ p1: 0, p2: 1, p3: 2 }, ["plan", "survey", "verify"]);

  it("puts the siblings in the same columns the script named — the case that makes this reachable", () => {
    const tree = spawnTree(mixed(), three);
    const r = tree.topo.ranks!;
    expect([r.get("p1"), r.get("p2"), r.get("p3")]).toEqual([2, 3, 4]);
    expect([r.get("sibB"), r.get("sibC")]).toEqual([2, 3]);
  });

  it("takes the script's word off any column a guess also stands in", () => {
    const tree = spawnTree(mixed(), three);
    expect(tree.topo.rankCaptions!.has(2)).toBe(false);
    expect(tree.topo.rankCaptions!.has(3)).toBe(false);
    // The column no guess reached keeps its word.
    expect(tree.topo.rankCaptions!.get(4)?.title).toBe("verify");
  });

  it("names as declared only the boxes a declaration placed", () => {
    const tree = spawnTree(mixed(), three);
    expect([...tree.declaredNodes].sort()).toEqual(["p1", "p2", "p3"]);
    expect(tree.declared).toBe(true);
  });

  it("says nothing is declared when no declaration placed anything", () => {
    const tree = spawnTree(mixed());
    expect(tree.declaredNodes.size).toBe(0);
    expect(tree.declared).toBe(false);
  });

  it("counts a declared phase the run never filled as a declared box", () => {
    const tree = spawnTree(mixed(), decl({ p1: 0 }, ["plan", "survey"]));
    // p2 and p3 were not named, so they go to the stray column; phase 1 was
    // never filled, so it gets its own box — and that box is declared.
    expect(tree.declaredNodes.has(lensPhaseNodeId("wf", 1))).toBe(true);
    expect(tree.declaredNodes.has("p2")).toBe(false);
  });
});
