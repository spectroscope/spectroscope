// Card 306: the two things that break SILENTLY the moment a node position
// stops being a world coordinate.
//
// React Flow measures a child's position from its PARENT's top-left. Every
// consumer in this map — the rail router's obstacle set, the seat-collision
// report — was written when every position was a world one, and a relative
// number is still a number: nothing throws, nothing warns, the rail simply
// routes to the wrong place and the collision check simply compares the wrong
// rectangles. So the conversion is one function, and it is pinned.

import { describe, expect, it } from "vitest";
import { orderParentsFirst, worldBoxes } from "./worldBox";

const n = (id: string, x: number, y: number, parentId?: string) => ({
  id,
  position: { x, y },
  ...(parentId === undefined ? {} : { parentId }),
});

describe("worldBoxes", () => {
  it("leaves a parentless node exactly where it stands", () => {
    expect(worldBoxes([n("a", 100, 200)]).get("a")).toEqual({ x: 100, y: 200 });
  });

  it("adds the parent's world origin to its child — the whole point", () => {
    const w = worldBoxes([n("box", 600, 110), n("kid", 14, 70, "box")]);
    expect(w.get("kid")).toEqual({ x: 614, y: 180 });
  });

  it("resolves a grandchild through the whole chain", () => {
    const w = worldBoxes([n("box", 600, 110), n("band", 10, 20, "box"), n("kid", 4, 6, "band")]);
    expect(w.get("kid")).toEqual({ x: 614, y: 136 });
  });

  it("resolves a child that arrives BEFORE its parent — order is not its business", () => {
    const w = worldBoxes([n("kid", 14, 70, "box"), n("box", 600, 110)]);
    expect(w.get("kid")).toEqual({ x: 614, y: 180 });
  });

  it("treats a parent that is not in the set as no parent, rather than dropping the child", () => {
    expect(worldBoxes([n("kid", 14, 70, "ghost")]).get("kid")).toEqual({ x: 14, y: 70 });
  });

  it("does not hang on a cycle — it stops and reports what it can", () => {
    const w = worldBoxes([n("a", 1, 1, "b"), n("b", 2, 2, "a")]);
    expect(w.size).toBe(2);
  });
});

describe("orderParentsFirst", () => {
  it("puts a parent in front of its child — React Flow refuses the other order", () => {
    const out = orderParentsFirst([n("kid", 0, 0, "box"), n("box", 0, 0)]);
    expect(out.map((x) => x.id)).toEqual(["box", "kid"]);
  });

  it("keeps everything else in the order it arrived — the map's own reading", () => {
    const out = orderParentsFirst([n("z-mac", 0, 0), n("user", 0, 0), n("agent", 0, 0)]);
    expect(out.map((x) => x.id)).toEqual(["z-mac", "user", "agent"]);
  });

  it("puts a grandparent in front of the parent in front of the child", () => {
    const out = orderParentsFirst([n("kid", 0, 0, "band"), n("band", 0, 0, "box"), n("box", 0, 0)]);
    expect(out.map((x) => x.id)).toEqual(["box", "band", "kid"]);
  });

  it("emits every node exactly once, even around a cycle", () => {
    const out = orderParentsFirst([n("a", 0, 0, "b"), n("b", 0, 0, "a"), n("c", 0, 0)]);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps a child whose parent is not in the set", () => {
    expect(orderParentsFirst([n("kid", 0, 0, "ghost")]).map((x) => x.id)).toEqual(["kid"]);
  });
});
