// Card 483: outcome labels joined to their arrows by position, a column gap
// wide enough for the longest one, and parallel labels stacked apart.

import { describe, expect, it } from "vitest";
import { layoutStateGraph } from "../../stategraph/layout";
import type { PlaybookDoc } from "./doc";
import { gapFor, LABEL_STEP, placeLabels } from "./labels";
import { project } from "./projection";

const MINIMAL: PlaybookDoc = {
  schema_version: 1,
  id: "p",
  name: "P",
  description: "d",
  models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
  documents: { spec: { name: "Spec", purpose: "design", location: "docs/{slug}.md", sections: ["Goal"] } },
  checks: { spec_ok: { kind: "sections", documents: ["spec"] } },
  vars: {},
  start: "write",
  nodes: [
    {
      kind: "step",
      id: "write",
      name: "Write",
      performer: "chat",
      skills: [],
      model: "fast",
      privacy: "cheap",
      permission: "inherit",
      consumes: [],
      produces: ["spec"],
      nod: false,
    },
    { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", max_rounds: 2 },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [
    { from: "write", to: "ok" },
    { from: "ok", to: "done", on: "pass" },
    { from: "ok", to: "write", on: "fail" },
    { from: "ok", to: "done", on: "exhausted" },
  ],
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
};

function withOutcome(on: string | undefined): PlaybookDoc {
  return {
    ...MINIMAL,
    arrows: [
      { from: "write", to: "ok" },
      { from: "ok", to: "done", on },
    ],
  };
}

describe("the column gap", () => {
  it("is the engine's own when no arrow carries an outcome", () => {
    expect(gapFor(withOutcome(undefined))).toBeUndefined();
  });

  it("never goes below 58, grows with the longest label and stops at 140", () => {
    expect(gapFor(withOutcome("fail"))).toBe(58);
    expect(gapFor(withOutcome("architectural"))).toBe(106);
    expect(gapFor(withOutcome("x".repeat(40)))).toBe(140);
  });
});

describe("the outcome labels", () => {
  const p = project(MINIMAL);
  const laid = layoutStateGraph(p.topo, "horizontal");
  const labels = placeLabels(MINIMAL, p, laid);
  const byEdge = new Map(labels.map((l) => [laid.edges[l.edgeIndex].id, l]));

  it("labels only the arrows that carry an outcome", () => {
    expect(labels.map((l) => [laid.edges[l.edgeIndex].id, l.text])).toEqual([
      ["ok->done", "pass"],
      ["ok->write", "fail"],
      ["ok->done#2", "exhausted"],
    ]);
  });

  it("stacks the second label of a parallel pair one step above the first", () => {
    const first = byEdge.get("ok->done")!;
    const second = byEdge.get("ok->done#2")!;
    expect(second.x).toBe(first.x);
    expect(first.y - second.y).toBe(LABEL_STEP);
    expect(LABEL_STEP).toBe(14);
  });

  it("puts the label of a back edge at its anchor", () => {
    const e = laid.edges.find((x) => x.id === "ok->write")!;
    expect(byEdge.get("ok->write")).toMatchObject({ x: e.labelX, y: e.labelY });
  });
});
