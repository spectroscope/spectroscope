// Card 314: the workflow whose SHAPE IS THE FAN-OUT.
//
// "workflow-phases" (card 302) is a five-stage pipeline that happens to
// contain two fan-outs; this one is a single wide phase with a scope in front
// of it and a sign-off behind it, which is the picture the owner asked to be
// able to load by name.
//
// The name carries the count, so these cases exist to keep that number honest
// in the only way that survives an edit: the name is compared against the
// DECLARATION, the declaration against the STREAM, and the stream against the
// BOX that draws it. Break any one link and exactly one case goes red.

import { describe, expect, it } from "vitest";
import { SCENARIOS } from "./registry";
import { compile, declarationOf } from "./compile";
import { loc } from "./dsl";
import { lensPhaseNodeId, spawnTree } from "../lab/spawnTree";
import { layoutStateGraph } from "../stategraph/layout";
import { SEATS_MAX_EXPANDED } from "../lab/flowmap/workerGrid";

const dsl = SCENARIOS.find((s) => s.id === "fanout-workflow")!;

/** The two numbers the name claims, read back off the declaration. */
const declaredWidths = (): number[] => (dsl.phases ?? []).map((p) => p.agents.length);
const declaredTotal = (): number => declaredWidths().reduce((a, b) => a + b, 0);
const declaredWidest = (): number => Math.max(...declaredWidths());

/** Every number in the shown name, in the order it is shown. */
const numbersInName = (lang: "en" | "de"): number[] =>
  [...loc(dsl.name, lang).matchAll(/\d+/g)].map((m) => Number(m[0]));

describe("the fan-out workflow scenario", () => {
  it("is registered, and is a chat scenario so it lands in the Lab", () => {
    expect(dsl).toBeDefined();
    expect(dsl.fleet).toBeUndefined();
  });

  it("is shaped as a fan-out: a scope, ONE wide phase, a sign-off", () => {
    const widths = declaredWidths();
    expect(widths).toHaveLength(3);
    expect(widths[0]).toBe(1);
    expect(widths[2]).toBe(1);
    // The middle phase is the scenario. Wider than both its neighbours put
    // together is what makes this a fan-out rather than a pipeline.
    expect(widths[1]).toBeGreaterThan(widths[0] + widths[2]);
  });

  it("keeps the wide phase inside the seat grid the map can actually draw", () => {
    // Eight is the width card 287 measured the expanded seat grid against;
    // SEATS_MAX_EXPANDED is the ceiling above which seats stop being drawn.
    // A name promising more agents than the map seats is the drift this card
    // exists to avoid.
    expect(declaredWidest()).toBeLessThanOrEqual(SEATS_MAX_EXPANDED);
  });

  it("states the total agent count in its name, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang)[0], lang).toBe(declaredTotal());
    }
  });

  it("states the fan-out width in its name, in both locales", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang)[1], lang).toBe(declaredWidest());
    }
  });

  it("puts no third number in its name that nothing pins", () => {
    for (const lang of ["en", "de"] as const) {
      expect(numbersInName(lang), lang).toHaveLength(2);
    }
  });

  it("hands out every agent id exactly once", () => {
    const ids = (dsl.phases ?? []).flatMap((p) => p.agents);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares only agents the stream actually spawns", () => {
    const spawned = compile(dsl, "en")
      .filter((e) => e.type === "agent_spawn")
      .map((e) => (e as { agentId: string }).agentId);
    for (const id of (dsl.phases ?? []).flatMap((p) => p.agents)) {
      expect(spawned.includes(id), id).toBe(true);
    }
  });

  it("spawns no agent the declaration left out", () => {
    const declared = new Set((dsl.phases ?? []).flatMap((p) => p.agents));
    const spawned = compile(dsl, "en")
      .filter((e) => e.type === "agent_spawn")
      .map((e) => (e as { agentId: string }).agentId);
    expect(spawned).toHaveLength(declaredTotal());
    for (const id of spawned) expect(declared.has(id), id).toBe(true);
  });

  it("draws three phase boxes holding exactly what the phases declare", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    expect(tree.declared).toBe(true);
    const laid = layoutStateGraph(tree.topo, "horizontal");
    // Four boxes: main and its three phases. The agents are ROWS.
    expect(laid.nodes).toHaveLength(4);
    const held = [0, 1, 2].map((i) => tree.meta[lensPhaseNodeId("main", i)].members.length);
    expect(held).toEqual(declaredWidths());
  });

  it("chains the three, and lets nothing else out of the root", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const id = (i: number) => lensPhaseNodeId("main", i);
    expect(tree.topo.edges.map((e) => `${e.from}->${e.to}`)).toEqual([
      `main->${id(0)}`,
      `${id(0)}->${id(1)}`,
      `${id(1)}->${id(2)}`,
    ]);
  });

  it("names every row of the wide phase from the task the run gave it", () => {
    const tree = spawnTree(compile(dsl, "en"), declarationOf(dsl, "en"));
    const rows = tree.meta[lensPhaseNodeId("main", 1)].members.map((m) => m.label);
    expect(rows).toHaveLength(declaredWidest());
    for (const r of rows) expect(r).not.toBe("");
    // Eight rows saying the same thing would render as one job done eight
    // times, which is not what a fan-out is.
    expect(new Set(rows).size).toBe(rows.length);
    // A row that fell back to its raw id is a row the stream never named.
    const ids = new Set((dsl.phases ?? [])[1].agents);
    for (const r of rows) expect(ids.has(r), r).toBe(false);
  });

  it("captions all three columns, in both locales, clear of the boxes", () => {
    for (const lang of ["en", "de"] as const) {
      const tree = spawnTree(compile(dsl, lang), declarationOf(dsl, lang));
      const laid = layoutStateGraph(tree.topo, "horizontal");
      const titles = [1, 2, 3].map((r) => tree.topo.rankCaptions!.get(r)?.title ?? null);
      expect(
        titles.every((x) => x !== null && x !== ""),
        lang,
      ).toBe(true);
      // The wide box is the tall one, and it is the reason this case exists:
      // the caption is pinned above a column whose height the widest box in
      // it sets, so a taller box than card 302 ever drew is where an overlap
      // would first show.
      for (const l of laid.rankLabels) {
        for (const n of laid.nodes.filter((x) => x.rank === l.rank)) {
          expect(l.y, `${lang} rank ${l.rank}`).toBeLessThan(n.y);
        }
      }
    }
  });
});
