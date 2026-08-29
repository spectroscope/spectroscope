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
  it("keeps a card where the reader put it while the LAYOUT leaves it alone", () => {
    const fresh = [node("agent", 250, 150)]; // what the layout said last step
    const prev = [node("agent", 900, 40)]; // and where the reader dragged it
    const next = [node("agent", 250, 150)]; // the layout says the same again
    const merged = mergeNodePositions(prev, next, new Set(), false, fresh);
    expect(merged[0].position).toEqual({ x: 900, y: 40 });
  });

  // THE PIN CARD 306 NEEDED AND DID NOT HAVE. A growing workflow box pushes
  // the OS band, the boundary and the LLM down and right, and none of those
  // ids starts with "sub-". The rule this file used to carry — "a main card
  // keeps its previous position" — froze every one of them at the seat they
  // had when the box was small, and the box was then drawn straight through
  // them. Measured in the running app before this test existed (shipped
  // "declared workflow" scenario, compact, 0 -> 141/188): box 1172x982 at
  // (610,110), z-os still at y 668, llm still at x 1432 — both inside the
  // box's rectangle. Forcing a relayout snapped z-os to 1152, which is what
  // sceneToFlow had been returning all along.
  it("follows the layout when the layout itself moved a card, with no relayout at all", () => {
    const fresh = [node("z-os", 24, 668)]; // where the layout had it
    const prev = [node("z-os", 24, 668)]; // and where it is on screen
    const next = [node("z-os", 24, 1152)]; // the box grew: the layout moved it
    const merged = mergeNodePositions(prev, next, new Set(), false, fresh);
    expect(merged[0].position).toEqual({ x: 24, y: 1152 });
  });

  it("still keeps a DRAGGED card put when the layout moves it — the drag wins", () => {
    const fresh = [node("z-os", 24, 668)];
    const prev = [node("z-os", 900, 40)]; // dragged off its seat
    const next = [node("z-os", 24, 1152)];
    const merged = mergeNodePositions(prev, next, new Set(["z-os"]), false, fresh);
    expect(merged[0].position).toEqual({ x: 900, y: 40 });
  });

  it("re-centres an UN-pinned subagent (takes the fresh position)", () => {
    const fresh = [node("sub-a", 610, 300)];
    const prev = [node("sub-a", 610, 300)];
    const next = [node("sub-a", 610, 110)]; // group re-centred after a new worker
    const merged = mergeNodePositions(prev, next, new Set(), false, fresh);
    expect(merged[0].position).toEqual({ x: 610, y: 110 });
  });

  it("keeps a PINNED subagent where the user dragged it", () => {
    const fresh = [node("sub-a", 610, 300)];
    const prev = [node("sub-a", 1200, 500)]; // dragged
    const next = [node("sub-a", 610, 110)];
    const merged = mergeNodePositions(prev, next, new Set(["sub-a"]), false, fresh);
    expect(merged[0].position).toEqual({ x: 1200, y: 500 });
  });

  it("a brand-new node (no prev) takes its fresh position", () => {
    const merged = mergeNodePositions([], [node("sub-b", 610, 290)], new Set(), false, []);
    expect(merged[0].position).toEqual({ x: 610, y: 290 });
  });

  it("a node the previous fold never held takes its fresh position", () => {
    const prev = [node("sub-b", 1, 1)];
    const merged = mergeNodePositions(prev, [node("sub-b", 610, 290)], new Set(), false, []);
    expect(merged[0].position).toEqual({ x: 610, y: 290 });
  });

  it("a relayout (local/remote flip) drops every card to the fresh position", () => {
    const fresh = [node("agent", 900, 40), node("sub-a", 1200, 500)];
    const prev = [node("agent", 900, 40), node("sub-a", 1200, 500)];
    const next = [node("agent", 250, 150), node("sub-a", 610, 110)];
    const merged = mergeNodePositions(prev, next, new Set(["sub-a"]), true, fresh);
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
