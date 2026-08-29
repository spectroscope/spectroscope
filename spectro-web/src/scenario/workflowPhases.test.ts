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
import { spawnTree } from "../lab/spawnTree";
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

  it("draws the measured shape: 13 agents over 5 declared columns, 1/5/1/1/5", () => {
    const events = compile(dsl, "en");
    const tree = spawnTree(events, declarationOf(dsl, "en"));
    expect(tree.declared).toBe(true);
    const laid = layoutStateGraph(tree.topo, "horizontal");
    const width = new Map<number, number>();
    for (const n of laid.nodes) if (n.id !== tree.root) width.set(n.rank, (width.get(n.rank) ?? 0) + 1);
    const cols = [...width.keys()].sort((a, b) => a - b);
    expect(cols).toEqual([1, 2, 3, 4, 5]);
    expect(cols.map((c) => width.get(c))).toEqual([1, 5, 1, 1, 5]);
    expect(laid.nodes).toHaveLength(14); // the root and its thirteen agents
  });

  it("captions each column, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      const tree = spawnTree(compile(dsl, lang), declarationOf(dsl, lang));
      const titles = [1, 2, 3, 4, 5].map((r) => tree.topo.rankCaptions!.get(r)?.title ?? null);
      expect(titles.every((x) => x !== null && x !== "")).toBe(true);
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
    const named = [...declarationOf(dsl, "en")!.values()].flatMap((p) => [...p.rankOf.keys()]);
    expect(named).toHaveLength(13);
    for (const id of named) expect(spawned.has(id), id).toBe(true);
  });
});
