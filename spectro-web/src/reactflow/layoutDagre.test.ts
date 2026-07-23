import { describe, expect, it } from "vitest";
import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import { layoutDagre } from "./layoutDagre";

const node = (id: string): FlowNode => ({ id, position: { x: 0, y: 0 }, data: {} });

describe("layoutDagre", () => {
  it("places an edge's target below its source (top-to-bottom)", () => {
    const nodes = [node("a"), node("b")];
    const edges: FlowEdge[] = [{ id: "e", source: "a", target: "b" }];
    const laid = layoutDagre(nodes, edges, { nodeW: 200, nodeH: 80 });
    const a = laid.find((n) => n.id === "a")!;
    const b = laid.find((n) => n.id === "b")!;
    expect(b.position.y).toBeGreaterThan(a.position.y);
  });

  it("is deterministic — same input yields the same positions", () => {
    const build = () =>
      layoutDagre(
        [node("a"), node("b"), node("c")],
        [
          { id: "e1", source: "a", target: "b" },
          { id: "e2", source: "a", target: "c" },
        ],
        { nodeW: 200, nodeH: 80 },
      );
    expect(build().map((n) => n.position)).toEqual(build().map((n) => n.position));
  });

  it("does not mutate the input nodes", () => {
    const nodes = [node("a"), node("b")];
    layoutDagre(nodes, [{ id: "e", source: "a", target: "b" }], { nodeW: 200, nodeH: 80 });
    expect(nodes.every((n) => n.position.x === 0 && n.position.y === 0)).toBe(true);
  });

  it("returns top-left positions (centre minus half the box)", () => {
    // A single node lands at dagre centre (nodeW/2, nodeH/2) → top-left (0,0).
    const laid = layoutDagre([node("solo")], [], { nodeW: 200, nodeH: 80 });
    expect(laid[0].position).toEqual({ x: 0, y: 0 });
  });
});
