// Card 306: the box in the MAP — where it sits, who it takes out of the pool,
// and the three things that break silently when a position becomes relative.
//
// The owner's ask is an ADDITION: the machine lens keeps everything, the
// agents stay the cards they already are, and the box lives inside the normal
// lab map rather than in a view of its own. So the first pin here is the one
// that says the addition costs nothing: a run with NO workflow lays out
// exactly as it did before, node for node.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "../../events";
import { advanceScene, initialScene } from "../labScene";
import { boxNodeId, deriveDetail, resetEnvelopeMemory, sceneToFlow } from "./sceneToFlow";
import { worldBoxes } from "./worldBox";
import { BOX_HEADER_H, boxMemberSize, workflowBoxLayout } from "./workflowBox";
import type { PhaseMember, RunPhases, WorkflowDeclaration } from "../workflowGraph";

const T = 1700000000000;
const runStart = (): RunEvent =>
  ({
    type: "run_start",
    runId: "r1",
    agentId: "main",
    prompt: "hi",
    provider: "anthropic",
    ts: T,
  }) as RunEvent;
const spawn = (agentId: string): RunEvent =>
  ({ type: "agent_spawn", agentId, parentId: "main", task: `task ${agentId}`, ts: T }) as RunEvent;

const member = (agentId: string): PhaseMember => ({
  agentId,
  label: agentId,
  model: null,
  state: "done",
  startedAt: 1,
  endedAt: 2,
});

/** One run: phase 1 holds one, phase 2 holds three. */
const RUN: RunPhases = {
  phases: [
    { title: "survey", detail: "look around", members: [member("a1")] },
    { title: "fan out", detail: null, members: [member("b1"), member("b2"), member("b3")] },
  ],
  unplaced: [],
};
const DECL: WorkflowDeclaration = new Map([["wf1", RUN]]);

const EVENTS = [runStart(), spawn("wf1"), spawn("a1"), spawn("b1"), spawn("b2"), spawn("b3")];

const flowOf = (
  events: RunEvent[],
  opts: Partial<Parameters<typeof sceneToFlow>[2]> = {},
): ReturnType<typeof sceneToFlow> => {
  const scene = events.reduce(advanceScene, initialScene());
  return sceneToFlow(scene, deriveDetail(events), { provider: "anthropic", model: "m", ...opts });
};

const BOX = boxNodeId("wf1");

describe("a run with NO workflow is untouched", () => {
  it("lays out node for node exactly as before, compact", () => {
    const plain = [runStart(), spawn("c1"), spawn("c2")];
    const before = flowOf(plain);
    const after = flowOf(plain, { declared: new Map() });
    expect(JSON.stringify(after.nodes)).toBe(JSON.stringify(before.nodes));
    expect(JSON.stringify(after.edges)).toBe(JSON.stringify(before.edges));
  });

  it("lays out node for node exactly as before, expanded", () => {
    const plain = [runStart(), spawn("c1"), spawn("c2")];
    const before = flowOf(plain, { expanded: true });
    const after = flowOf(plain, { expanded: true, declared: new Map() });
    expect(JSON.stringify(after.nodes)).toBe(JSON.stringify(before.nodes));
  });

  it("is untouched by a declaration about a run the scene never drew", () => {
    const plain = [runStart(), spawn("c1")];
    const before = flowOf(plain);
    const after = flowOf(plain, { declared: DECL });
    expect(JSON.stringify(after.nodes)).toBe(JSON.stringify(before.nodes));
  });
});

describe("the box in the map", () => {
  it("draws ONE box per workflow run, inside the normal map", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    const boxes = flow.nodes.filter((n) => n.type === "wfbox");
    expect(boxes.map((b) => b.id)).toEqual([BOX]);
    // Still the normal map: the zones, the hub and the band are all there.
    for (const id of ["z-mac", "z-os", "user", "agent", "llm", "os-disk"])
      expect(flow.nodes.map((n) => n.id)).toContain(id);
  });

  it("draws five boxes for five runs — a session can hold that many", () => {
    const five = new Map(["w1", "w2", "w3", "w4", "w5"].map((k) => [k, RUN] as [string, RunPhases]));
    const events = [runStart(), ...["w1", "w2", "w3", "w4", "w5"].map(spawn)];
    const flow = flowOf(events, { declared: five });
    expect(flow.nodes.filter((n) => n.type === "wfbox")).toHaveLength(5);
  });

  it("stacks the boxes VERTICALLY, so each reads as one block", () => {
    const two = new Map([
      ["wf1", RUN],
      ["wf2", RUN],
    ]);
    const flow = flowOf([runStart(), spawn("wf1"), spawn("wf2")], { declared: two });
    const boxes = flow.nodes.filter((n) => n.type === "wfbox");
    expect(boxes[0].position.x).toBe(boxes[1].position.x);
    expect(boxes[1].position.y).toBeGreaterThan(boxes[0].position.y);
  });

  it("makes each member a CHILD of its box, held inside it", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    for (const id of ["a1", "b1", "b2", "b3"]) {
      const node = flow.nodes.find((n) => n.id === `sub-${id}`);
      expect(node?.parentId).toBe(BOX);
      expect(node?.extent).toBe("parent");
    }
  });

  it("puts the box BEFORE its children — React Flow refuses the other order", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    const at = (id: string) => flow.nodes.findIndex((n) => n.id === id);
    for (const id of ["a1", "b1", "b2", "b3"]) expect(at(BOX)).toBeLessThan(at(`sub-${id}`));
  });

  it("seats every member INSIDE its box, in world coordinates", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    const world = worldBoxes(flow.nodes as { id: string; position: { x: number; y: number } }[]);
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const bw = world.get(BOX)!;
    const size = boxMemberSize(false);
    const style = box.style as { width: number; height: number };
    for (const id of ["a1", "b1", "b2", "b3"]) {
      const m = world.get(`sub-${id}`)!;
      expect(m.x).toBeGreaterThanOrEqual(bw.x);
      expect(m.y).toBeGreaterThanOrEqual(bw.y + BOX_HEADER_H);
      expect(m.x + size.w).toBeLessThanOrEqual(bw.x + style.width);
      expect(m.y + size.h).toBeLessThanOrEqual(bw.y + style.height);
    }
  });

  it("takes the boxed members OUT of the concurrency pool, and leaves the rest in it", () => {
    const flow = flowOf([...EVENTS, spawn("loner")], { declared: DECL });
    const flat = flow.nodes.filter((n) => n.type === "subagent" && n.parentId === undefined);
    expect(flat.map((n) => n.id)).toEqual(["sub-loner"]);
  });

  it("folds the run's own card into the box rather than drawing the run twice", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    expect(flow.nodes.map((n) => n.id)).not.toContain("sub-wf1");
  });

  it("places only the members the scene has actually reached — a scrub is not an invention", () => {
    const flow = flowOf([runStart(), spawn("wf1"), spawn("a1")], { declared: DECL });
    const kids = flow.nodes.filter((n) => n.parentId === BOX).map((n) => n.id);
    expect(kids).toEqual(["sub-a1"]);
  });
});

describe("the parents-first order is PRODUCED, not inherited", () => {
  // The invariant itself, over a real map.
  it("holds over every node the map emits", () => {
    const flow = flowOf(EVENTS, { declared: DECL });
    const at = new Map(flow.nodes.map((n, i) => [n.id, i]));
    for (const n of flow.nodes) {
      if (n.parentId === undefined) continue;
      expect(at.get(n.parentId)!).toBeLessThan(at.get(n.id)!);
    }
  });

  // And the guarantee, because the invariant alone cannot bite: today's push
  // order already satisfies it, so removing `orderParentsFirst` breaks
  // nothing here and everything the next time a push moves. That is exactly
  // the "an ordering that happens to work is not a guarantee" trap, so what is
  // pinned is that the nodes leave through the function that produces it.
  // `orderParentsFirst` has its own reversed-input pin in worldBox.test.ts.
  it("sends the nodes out through orderParentsFirst", () => {
    const src = readFileSync(new URL("./sceneToFlow.ts", import.meta.url), "utf8");
    expect(src).toContain("return { nodes: orderParentsFirst(nodes), edges };");
  });
});

describe("the seat check reads WORLD rectangles", () => {
  it("reports no collision for a box whose members sit inside it", () => {
    // The trap this pins: a member's position is measured from its BOX. Read
    // raw, a member 14px into a box at x=1400 is compared as a card at x=14,
    // sitting on the user card — and the check would name a collision that is
    // not there. Nothing throws; 14 is a fine number.
    resetEnvelopeMemory();
    const said: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((m: unknown) => void said.push(String(m)));
    try {
      flowOf(EVENTS, { declared: DECL, expanded: true });
    } finally {
      spy.mockRestore();
    }
    expect(said.filter((m) => m.includes("seated on top of each other"))).toEqual([]);
  });
});

describe("the per-box switch", () => {
  it("expands ONE box while the map stays compact", () => {
    const flow = flowOf(EVENTS, { declared: DECL, boxExpanded: new Set([BOX]) });
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const wide = workflowBoxLayout(RUN, { expanded: true, present: null, unplacedTitle: "u" });
    expect((box.style as { width: number }).width).toBe(wide.w);
    // and its members carry the full instrument's data
    const kid = flow.nodes.find((n) => n.id === "sub-a1")!;
    expect((kid.data as { full?: unknown }).full).toBeDefined();
  });

  it("leaves a box the switch was not thrown on compact, even beside an expanded one", () => {
    const two = new Map([
      ["wf1", RUN],
      ["wf2", RUN],
    ]);
    const flow = flowOf([runStart(), spawn("wf1"), spawn("wf2"), spawn("a1")], {
      declared: two,
      boxExpanded: new Set([boxNodeId("wf1")]),
    });
    const w = (id: string) => (flow.nodes.find((n) => n.id === id)!.style as { width: number }).width;
    expect(w(boxNodeId("wf1"))).toBeGreaterThan(w(boxNodeId("wf2")));
  });

  it("follows the GLOBAL switch when no per-box choice was made", () => {
    const flow = flowOf(EVENTS, { declared: DECL, expanded: true });
    const kid = flow.nodes.find((n) => n.id === "sub-a1")!;
    expect((kid.data as { full?: unknown }).full).toBeDefined();
  });
});

describe("a tall box grows the map downward — in COMPACT too", () => {
  /** Twelve phases: deeper than the OS band ever was. */
  const TALL: RunPhases = {
    phases: Array.from({ length: 12 }, (_, i) => ({
      title: `phase ${i}`,
      detail: null,
      members: [member(`m${i}`)],
    })),
    unplaced: [],
  };
  const tallEvents = [runStart(), spawn("wf1"), ...Array.from({ length: 12 }, (_, i) => spawn(`m${i}`))];
  const tallDecl: WorkflowDeclaration = new Map([["wf1", TALL]]);

  it("pushes the OS band below the box instead of drawing the box through it", () => {
    const flow = flowOf(tallEvents, { declared: tallDecl });
    const world = worldBoxes(flow.nodes as { id: string; position: { x: number; y: number } }[]);
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const bottom = world.get(BOX)!.y + (box.style as { height: number }).height;
    const band = flow.nodes.find((n) => n.id === "z-os")!;
    expect(band.position.y).toBeGreaterThanOrEqual(bottom);
  });

  it("grows the mac frame to hold the box", () => {
    const flow = flowOf(tallEvents, { declared: tallDecl });
    const world = worldBoxes(flow.nodes as { id: string; position: { x: number; y: number } }[]);
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const bottom = world.get(BOX)!.y + (box.style as { height: number }).height;
    const mac = flow.nodes.find((n) => n.id === "z-mac")!;
    const macStyle = mac.style as { height: number };
    expect(mac.position.y + macStyle.height).toBeGreaterThanOrEqual(bottom);
  });

  it("keeps the workers clear of the box column, EXPANDED too", () => {
    const flow = flowOf([...tallEvents, spawn("loner")], { declared: tallDecl, expanded: true });
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const right = box.position.x + (box.style as { width: number }).width;
    const loner = flow.nodes.find((n) => n.id === "sub-loner")!;
    expect(loner.position.x).toBeGreaterThanOrEqual(right);
  });

  it("keeps the workers clear of the box column", () => {
    const flow = flowOf([...tallEvents, spawn("loner")], { declared: tallDecl });
    const box = flow.nodes.find((n) => n.id === BOX)!;
    const right = box.position.x + (box.style as { width: number }).width;
    const loner = flow.nodes.find((n) => n.id === "sub-loner")!;
    expect(loner.position.x).toBeGreaterThanOrEqual(right);
  });
});
