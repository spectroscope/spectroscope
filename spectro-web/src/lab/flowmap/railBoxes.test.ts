// Card 306: the rails' obstacle set, and the layout key, as pure functions.
//
// Both used to be expressions inside FlowMap, and both changed meaning the
// moment a node position stopped being a world coordinate. Out here they can
// be bitten.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { railBoxesFrom, seatingKey } from "./railBoxes";

const node = (
  id: string,
  x: number,
  y: number,
  over: Record<string, unknown> = {},
): Parameters<typeof railBoxesFrom>[0][number] =>
  ({ id, type: "subagent", position: { x, y }, ...over }) as Parameters<typeof railBoxesFrom>[0][number];

describe("railBoxesFrom", () => {
  it("drops the zones — a frame is not a card the rails route around", () => {
    const out = railBoxesFrom([node("z-mac", 0, 0, { type: "zone" }), node("agent", 10, 20)]);
    expect(out.map((b) => b.id)).toEqual(["agent"]);
  });

  it("gives a boxed member its WORLD box, not the position React Flow stores", () => {
    // The whole reason this left FlowMap: a child's position is measured from
    // its parent, and a rail routed to the relative number lands 600px away
    // from the card it is drawn from — silently, because 14 is a fine number.
    const out = railBoxesFrom([
      node("wfbox-1", 600, 110, { type: "wfbox" }),
      node("sub-a", 14, 70, { parentId: "wfbox-1" }),
    ]);
    expect(out.find((b) => b.id === "sub-a")).toMatchObject({ x: 614, y: 180 });
  });

  it("prefers what the browser measured over what the node declared", () => {
    const out = railBoxesFrom([node("agent", 0, 0, { width: 300, measured: { width: 421, height: 88 } })]);
    expect(out[0]).toMatchObject({ w: 421, h: 88 });
  });

  it("falls back to the node's own size, then to the map's default", () => {
    const declared = railBoxesFrom([node("a", 0, 0, { width: 300, height: 120 })]);
    expect(declared[0]).toMatchObject({ w: 300, h: 120 });
    expect(railBoxesFrom([node("b", 0, 0)])[0]).toMatchObject({ w: 200, h: 100 });
  });
});

describe("seatingKey", () => {
  it("changes when the global switch flips — that IS a different seating", () => {
    expect(seatingKey(true, null, "auto", "")).not.toBe(seatingKey(false, null, "auto", ""));
  });

  it("changes when a BOX's switch flips, because the box's members move", () => {
    expect(seatingKey(false, null, "auto", "wfbox-1")).not.toBe(seatingKey(false, null, "auto", ""));
  });

  it("changes with the measured pane and the row choice, as it always did", () => {
    expect(seatingKey(false, 1.7, "auto", "")).not.toBe(seatingKey(false, 1.2, "auto", ""));
    expect(seatingKey(false, null, 3, "")).not.toBe(seatingKey(false, null, "auto", ""));
  });

  it("is the same string for the same seating — a key that drifts re-lays the map for nothing", () => {
    expect(seatingKey(false, 1.7, "auto", "a,b")).toBe(seatingKey(false, 1.7, "auto", "a,b"));
  });
});

// The wiring half. FlowMap is rendered through a mocked canvas in this gate
// (no DOM), so what the map actually DOES with these two cannot be asserted by
// rendering it — but the call sites can, and a call site that silently goes
// back to reading a raw position is exactly the regression they exist to stop.
describe("FlowMap uses them", () => {
  const src = readFileSync(new URL("../FlowMap.tsx", import.meta.url), "utf8");

  it("routes the rails through the world-resolving derivation", () => {
    expect(src).toContain("railBoxesFrom(nodes)");
    // and not around it
    expect(src).not.toContain("n.position.x");
  });

  it("names the box switch in the seating key, so the key cannot claim the wrong seating", () => {
    expect(src).toContain("seatingKey(expandAll, paneAspect, rowsPref, boxSwitch)");
  });

  it("hands the declaration and the per-box switch to the mapping", () => {
    expect(src).toContain("declared: props.declared");
    expect(src).toContain("boxExpanded,");
    expect(src).toContain("onToggleBox,");
  });
});

describe("LabView feeds the map its declaration", () => {
  it("passes the imported run's declaration to the map, not only to the lens", () => {
    const src = readFileSync(new URL("../LabView.tsx", import.meta.url), "utf8");
    expect(src).toContain("declared={replay?.declared}");
  });
});
