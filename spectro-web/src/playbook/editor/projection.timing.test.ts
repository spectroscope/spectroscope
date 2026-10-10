// Card 483: a reading of how long a 60 node playbook takes to project and lay
// out in Node. The acceptance number is measured in the browser (Task 12);
// this test pins that the fixture is whole and lays out with nothing dropped.

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { layoutStateGraph } from "../../stategraph/layout";
import { FIXTURE_60 } from "./fixture60";
import { assertJoined, project } from "./projection";

describe("the 60 node fixture", () => {
  it("holds 40 steps, 18 decisions, 2 ends and 4 loops", () => {
    const kinds = FIXTURE_60.nodes.map((n) => n.kind);
    expect(kinds.filter((k) => k === "step").length).toBe(40);
    expect(kinds.filter((k) => k === "decision").length).toBe(18);
    expect(kinds.filter((k) => k === "end").length).toBe(2);
    const rounds = FIXTURE_60.nodes.filter((n) => n.kind === "decision" && n.max_rounds !== undefined);
    expect(rounds.length).toBe(4);
    const laid = layoutStateGraph(project(FIXTURE_60).topo, "horizontal");
    expect(laid.edges.filter((e) => e.back).length).toBe(4);
  });

  it("lays out twenty times with every node placed and every arrow drawn", () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = performance.now();
      const p = project(FIXTURE_60);
      const laid = layoutStateGraph(p.topo, "horizontal");
      times.push(performance.now() - t0);
      expect(p.ghosts.size).toBe(0);
      expect(laid.nodes.length).toBe(FIXTURE_60.nodes.length + 1);
      assertJoined(p, laid);
    }
    const sorted = [...times].sort((a, b) => a - b);
    const median = (sorted[9] + sorted[10]) / 2;
    console.info(
      `fixture60 project+layout in Node, 20 runs: median ${median.toFixed(2)} ms, max ${sorted[19].toFixed(2)} ms`,
    );
  });

  const out = process.env.PB_FIXTURE_OUT;
  it.skipIf(!out)("writes the fixture as playbook.json when PB_FIXTURE_OUT names a path", () => {
    writeFileSync(out!, JSON.stringify(FIXTURE_60, null, 2));
  });
});
