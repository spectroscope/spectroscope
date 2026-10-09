// Card 483: the document as React Flow nodes and edges. Positions come from
// the layout only, nothing drags, the start box and the ghosts cannot be
// selected or deleted, and the selection comes from the store.

import { describe, expect, it } from "vitest";
import { layoutStateGraph } from "../../stategraph/layout";
import { outcomesOf, type PlaybookDoc, type Selection } from "./doc";
import { placeLabels } from "./labels";
import { MISSING, project, START } from "./projection";
import { toFlow } from "./toFlow";

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

function flowOf(doc: PlaybookDoc, sel: Selection) {
  const p = project(doc);
  const laid = layoutStateGraph(p.topo, "horizontal");
  const labels = placeLabels(doc, p, laid);
  return { laid, ...toFlow(doc, p, laid, labels, sel, (n) => outcomesOf(doc, n)) };
}

describe("the document as React Flow nodes and edges", () => {
  it("types each box by its kind, places it where the layout put it, and lets nothing drag", () => {
    const { laid, nodes } = flowOf(MINIMAL, null);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(nodes.map((n) => n.id)).toEqual(laid.nodes.map((n) => n.id));
    expect(byId.get(START)?.type).toBe("pbStart");
    expect(byId.get("write")?.type).toBe("pbStep");
    expect(byId.get("ok")?.type).toBe("pbDecision");
    expect(byId.get("done")?.type).toBe("pbEnd");
    for (const n of nodes) {
      const placed = laid.nodes.find((l) => l.id === n.id)!;
      expect(n.draggable, n.id).toBe(false);
      expect(n.position, n.id).toEqual({ x: placed.x, y: placed.y });
    }
    expect(byId.get("ok")?.data.outcomes).toEqual(["pass", "fail", "exhausted"]);
  });

  it("keeps the start box out of selection and deletion, and real boxes in", () => {
    const { nodes } = flowOf(MINIMAL, null);
    const start = nodes.find((n) => n.id === START)!;
    expect(start.selectable).toBe(false);
    expect(start.deletable).toBe(false);
    const write = nodes.find((n) => n.id === "write")!;
    expect(write.selectable).toBe(true);
    expect(write.deletable).toBe(true);
  });

  it("marks exactly the selected arrow, and exactly the selected node", () => {
    const arrow = flowOf(MINIMAL, { kind: "arrow", key: "ok|fail" });
    expect(arrow.edges.filter((e) => e.selected).map((e) => e.id)).toEqual(["arrow:2"]);
    expect(arrow.nodes.filter((n) => n.selected)).toEqual([]);
    const node = flowOf(MINIMAL, { kind: "node", id: "write" });
    expect(node.nodes.filter((n) => n.selected).map((n) => n.id)).toEqual(["write"]);
    expect(node.edges.filter((e) => e.selected)).toEqual([]);
  });

  it("anchors every edge on the hidden handles and draws it with the arrow type", () => {
    const { edges } = flowOf(MINIMAL, null);
    expect(edges.map((e) => e.id)).toEqual(["start", "arrow:0", "arrow:1", "arrow:2", "arrow:3"]);
    for (const e of edges) {
      expect(e.sourceHandle, e.id).toBe("anchor-out");
      expect(e.targetHandle, e.id).toBe("anchor-in");
      expect(e.type, e.id).toBe("pbArrow");
    }
    const start = edges[0];
    expect(start.selectable).toBe(false);
    expect(start.deletable).toBe(false);
    expect(edges[1].selectable).toBe(true);
    expect(edges[1].deletable).toBe(true);
    expect(edges.find((e) => e.id === "arrow:1")?.data?.label).toMatchObject({ text: "pass" });
    expect(edges.find((e) => e.id === "arrow:0")?.data?.label).toBeNull();
    expect(edges.find((e) => e.id === "arrow:2")?.data?.back).toBe(true);
  });

  it("draws a missing endpoint as a ghost that cannot be picked, and its arrow as dangling", () => {
    const doc: PlaybookDoc = { ...MINIMAL, arrows: [...MINIMAL.arrows, { from: "write", to: "gone" }] };
    const { nodes, edges } = flowOf(doc, null);
    const ghost = nodes.find((n) => n.id === `${MISSING}gone`)!;
    expect(ghost.type).toBe("pbGhost");
    expect(ghost.data.ghost).toBe("missing");
    expect(ghost.selectable).toBe(false);
    expect(ghost.deletable).toBe(false);
    expect(edges.find((e) => e.id === "arrow:4")?.data?.dangling).toBe(true);
    expect(edges.filter((e) => e.data?.dangling).map((e) => e.id)).toEqual(["arrow:4"]);
  });
});
