import { describe, expect, it } from "vitest";
import type { Node, NodeChange } from "@xyflow/react";
import { collectDraggedIds, mergeNodePositions } from "./positions";

const node = (id: string, x: number, y: number): Node => ({
  id,
  position: { x, y },
  data: {},
  type: id.startsWith("sub-") ? "subagent" : "agent",
});

describe("mergeNodePositions (positions survive a step)", () => {
  it("keeps a main card's previous position (the dragged spot), not the fresh one", () => {
    const prev = [node("agent", 900, 40)]; // user dragged it here
    const next = [node("agent", 250, 150)]; // fresh deterministic position
    const merged = mergeNodePositions(prev, next, new Set(), false);
    expect(merged[0].position).toEqual({ x: 900, y: 40 });
  });

  it("re-centres an UN-pinned subagent (takes the fresh position)", () => {
    const prev = [node("sub-a", 610, 300)];
    const next = [node("sub-a", 610, 110)]; // group re-centred after a new worker
    const merged = mergeNodePositions(prev, next, new Set(), false);
    expect(merged[0].position).toEqual({ x: 610, y: 110 });
  });

  it("keeps a PINNED subagent where the user dragged it", () => {
    const prev = [node("sub-a", 1200, 500)]; // dragged
    const next = [node("sub-a", 610, 110)];
    const merged = mergeNodePositions(prev, next, new Set(["sub-a"]), false);
    expect(merged[0].position).toEqual({ x: 1200, y: 500 });
  });

  it("a brand-new node (no prev) takes its fresh position", () => {
    const merged = mergeNodePositions([], [node("sub-b", 610, 290)], new Set(), false);
    expect(merged[0].position).toEqual({ x: 610, y: 290 });
  });

  it("a relayout (local/remote flip) drops every card to the fresh position", () => {
    const prev = [node("agent", 900, 40), node("sub-a", 1200, 500)];
    const next = [node("agent", 250, 150), node("sub-a", 610, 110)];
    const merged = mergeNodePositions(prev, next, new Set(["sub-a"]), true);
    expect(merged.map((n) => n.position)).toEqual([
      { x: 250, y: 150 },
      { x: 610, y: 110 },
    ]);
  });
});

describe("collectDraggedIds", () => {
  it("pins every node with a position change, leaves others alone", () => {
    const pinned = new Set<string>();
    const changes: NodeChange<Node>[] = [
      { id: "agent", type: "position", position: { x: 5, y: 5 }, dragging: true },
      { id: "sub-a", type: "position", position: { x: 9, y: 9 }, dragging: false },
      { id: "llm", type: "dimensions", dimensions: { width: 10, height: 10 } } as NodeChange<Node>,
      { id: "user", type: "select", selected: true } as NodeChange<Node>,
    ];
    collectDraggedIds(changes, pinned);
    expect([...pinned].sort()).toEqual(["agent", "sub-a"]);
  });
});
