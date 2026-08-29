// Card 302: the shipped demo of a declared workflow — the measured SHAPE of a
// real 13-agent run (1 / 5 / 1 / 1 / 5, two fan-outs of five) and nothing else
// of it. The shape is numbers; the scenario's phase words, its subject and its
// name are the registry's own invention, not the recording's. The recording
// itself is not in this repo and never will be: it is the owner's own
// material, and it loads through the folder dialog cards 291 and 297 already
// taught to take a directory.

import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./registry";
import { compile, declarationOf } from "./compile";
import { lensPhaseNodeId, spawnTree } from "../lab/spawnTree";
import { layoutStateGraph } from "../stategraph/layout";

const dsl = SCENARIOS.find((s) => s.id === "workflow-phases")!;

describe("the declared-workflow scenario", () => {
  it("is registered, and is a chat scenario so it lands in the Lab", () => {
    expect(dsl).toBeDefined();
    expect(dsl.fleet).toBeUndefined();
  });

  it("declares five named phases", () => {
    expect(dsl.phases).toHaveLength(5);
  });

  it("draws the measured shape: five phase boxes holding 1/5/1/1/5 agents", () => {
    const events = compile(dsl, "en");
    const tree = spawnTree(events, declarationOf(dsl, "en"));
    expect(tree.declared).toBe(true);
    const laid = layoutStateGraph(tree.topo, "horizontal");
    // Six boxes: main and its five phases. The thirteen agents are ROWS.
    expect(laid.nodes).toHaveLength(6);
    expect(laid.nodes.map((n) => n.rank).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    const held = [0, 1, 2, 3, 4].map((i) => tree.meta[lensPhaseNodeId("main", i)].members.length);
    expect(held).toEqual([1, 5, 1, 1, 5]);
    expect(held.reduce((a, b) => a + b, 0)).toBe(13);
  });

  it("chains the five, and lets nothing else out of the root", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const id = (i: number) => lensPhaseNodeId("main", i);
    expect(tree.topo.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `main->${id(0)}`,
      `${id(0)}->${id(1)}`,
      `${id(1)}->${id(2)}`,
      `${id(2)}->${id(3)}`,
      `${id(3)}->${id(4)}`,
    ]);
    expect(tree.topo.edges.filter((e) => e.from === "main")).toHaveLength(1);
  });

  it("names each agent from the task the run gave it", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const rows = tree.meta[lensPhaseNodeId("main", 1)].members.map((m) => m.label);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r).not.toBe("");
    expect(rows.some((r) => r.includes("probe"))).toBe(true);
  });

  it("captions each column, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      const tree = spawnTree(compile(dsl, lang), declarationOf(dsl, lang));
      const titles = [1, 2, 3, 4, 5].map((r) => tree.topo.rankCaptions!.get(r)?.title ?? null);
      expect(titles.every((x) => x !== null && x !== "")).toBe(true);
    }
  });

  it("keeps every caption off the box it names, in both locales", () => {
    // The half the caption test above cannot see: that the words EXIST says
    // nothing about where they land. A phase box states its own height and the
    // column is packed around it, so the two fan-outs of five start above the
    // margin the caption used to be pinned to — and the caption was painted
    // onto the box's own heading, on exactly the two columns this scenario
    // exists to show. The overlay renders after the nodes in the same
    // transformed viewport, so an overlap is a cover-up, not a near miss.
    for (const lang of ["en", "de"] as const) {
      const laid = layoutStateGraph(
        spawnTree(compile(dsl, lang), declarationOf(dsl, lang)).topo,
        "horizontal",
      );
      // The two fan-outs of five are the tall ones, and they are the reason
      // this case exists: 107px against the 46 a plain node has always been.
      const tall = laid.nodes.filter((n) => n.h >= 107);
      expect(tall).toHaveLength(2);
      for (const l of laid.rankLabels) {
        for (const n of laid.nodes.filter((x) => x.rank === l.rank)) {
          expect(l.y, `${lang} rank ${l.rank}`).toBeLessThan(n.y);
        }
      }
    }
  });

  it("says nothing about a scenario that declared no phases", () => {
    const plain = SCENARIOS.find((s) => s.id === "fanout-eight")!;
    expect(declarationOf(plain, "en")).toBeUndefined();
    expect(spawnTree(compile(plain, "en")).declared).toBe(false);
  });

  it("names only agents the scenario actually spawns", () => {
    const spawned = new Set(
      compile(dsl, "en")
        .filter((e) => e.type === "agent_spawn")
        .map((e) => (e as { agentId: string }).agentId),
    );
    const named = [...declarationOf(dsl, "en")!.values()].flatMap((p) =>
      p.phases.flatMap((ph) => ph.members.map((m) => m.agentId)),
    );
    expect(named).toHaveLength(13);
    for (const id of named) expect(spawned.has(id), id).toBe(true);
  });
});
