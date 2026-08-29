// Card 306: the geometry of ONE workflow box, pinned without a DOM.
//
// The interior of a box is a pure function of (declaration, members present,
// expanded) and nothing else. Pinning it here rather than in a render test is
// the point: a band that runs through its neighbour is arithmetic, and
// arithmetic is measurable without a browser.

import { describe, expect, it } from "vitest";
import {
  BOX_BAND_GAP,
  BOX_BAND_LABEL_H,
  BOX_HEADER_H,
  BOX_MEMBER_GAP,
  BOX_PAD,
  boxMemberSize,
  workflowBoxLayout,
} from "./workflowBox";
import type { RunPhases } from "../workflowGraph";

const member = (agentId: string) => ({
  agentId,
  label: agentId,
  model: null,
  state: "done" as const,
  startedAt: 1,
  endedAt: 2,
});

/** The owner's own example: phase 1 holds one, phase 2 holds five, phase 3 holds one. */
const ONE_FIVE_ONE: RunPhases = {
  phases: [
    { title: "survey", detail: "look around", members: [member("a1")] },
    {
      title: "fan out",
      detail: null,
      members: [member("b1"), member("b2"), member("b3"), member("b4"), member("b5")],
    },
    { title: "fold", detail: null, members: [member("c1")] },
  ],
  unplaced: [],
};

const lay = (run: RunPhases, expanded = false) =>
  workflowBoxLayout(run, { expanded, present: null, unplacedTitle: "unplaced" });

describe("workflowBoxLayout", () => {
  it("gives every declared phase its own band, in the declared order", () => {
    const box = lay(ONE_FIVE_ONE);
    expect(box.bands.map((b) => b.title)).toEqual(["survey", "fan out", "fold"]);
  });

  it("lines the members of a phase up SIDE BY SIDE inside their band", () => {
    const box = lay(ONE_FIVE_ONE);
    const fan = box.bands[1];
    expect(fan.members.map((m) => m.agentId)).toEqual(["b1", "b2", "b3", "b4", "b5"]);
    // one row: every member shares the band's member row
    expect(new Set(fan.members.map((m) => m.y)).size).toBe(1);
    const size = boxMemberSize(false);
    for (let i = 1; i < fan.members.length; i++) {
      expect(fan.members[i].x - fan.members[i - 1].x).toBe(size.w + BOX_MEMBER_GAP);
    }
  });

  it("stacks the bands DOWNWARD and never overlaps two of them", () => {
    const box = lay(ONE_FIVE_ONE);
    for (let i = 1; i < box.bands.length; i++) {
      const prev = box.bands[i - 1];
      expect(box.bands[i].y).toBe(prev.y + prev.h + BOX_BAND_GAP);
    }
    expect(box.bands[0].y).toBe(BOX_HEADER_H + BOX_PAD);
  });

  it("holds every band and every member inside the box it reports", () => {
    const box = lay(ONE_FIVE_ONE);
    for (const band of box.bands) {
      expect(band.y + band.h + BOX_PAD).toBeLessThanOrEqual(box.h);
      for (const m of band.members) {
        expect(m.x + m.w + BOX_PAD).toBeLessThanOrEqual(box.w);
        expect(m.y).toBeGreaterThanOrEqual(band.y + BOX_BAND_LABEL_H);
        expect(m.y + m.h).toBeLessThanOrEqual(band.y + band.h);
      }
    }
  });

  it("is as wide as its WIDEST band, so the one-member phases do not stretch it", () => {
    const box = lay(ONE_FIVE_ONE);
    const size = boxMemberSize(false);
    expect(box.w).toBe(2 * BOX_PAD + 5 * size.w + 4 * BOX_MEMBER_GAP);
  });

  it("draws a phase the run never entered — an empty band is a fact, not a gap", () => {
    const box = lay({
      phases: [
        { title: "ran", detail: null, members: [member("a")] },
        { title: "never", detail: null, members: [] },
      ],
      unplaced: [],
    });
    expect(box.bands).toHaveLength(2);
    expect(box.bands[1].members).toEqual([]);
    // Drawn, and drawn SMALLER: it holds no card, so reserving a card's height
    // for it would spend the box's depth on air.
    expect(box.bands[1].h).toBeGreaterThan(0);
    expect(box.bands[1].h).toBeLessThan(box.bands[0].h);
  });

  it("gives the agents the file could not place a band of their own, LAST", () => {
    const box = lay({
      phases: [{ title: "ran", detail: null, members: [member("a")] }],
      unplaced: [member("stray")],
    });
    expect(box.bands.map((b) => b.title)).toEqual(["ran", "unplaced"]);
    expect(box.bands[1].members.map((m) => m.agentId)).toEqual(["stray"]);
  });

  it("adds no unplaced band when the file placed everyone", () => {
    expect(lay(ONE_FIVE_ONE).bands.map((b) => b.title)).not.toContain("unplaced");
  });

  it("grows with the switch: expanded members are the full instrument", () => {
    const compact = lay(ONE_FIVE_ONE, false);
    const expanded = lay(ONE_FIVE_ONE, true);
    expect(boxMemberSize(true).w).toBeGreaterThan(boxMemberSize(false).w);
    expect(expanded.w).toBeGreaterThan(compact.w);
    expect(expanded.h).toBeGreaterThan(compact.h);
  });

  it("places ONLY the members the scene actually drew, when a present set is given", () => {
    const box = workflowBoxLayout(ONE_FIVE_ONE, {
      expanded: false,
      present: new Set(["a1", "b2", "c1"]),
      unplacedTitle: "unplaced",
    });
    expect(box.bands.map((b) => b.members.map((m) => m.agentId))).toEqual([["a1"], ["b2"], ["c1"]]);
  });

  it("reports the members it placed, so the seating can take exactly them out of the pool", () => {
    expect([...lay(ONE_FIVE_ONE).placed]).toEqual(["a1", "b1", "b2", "b3", "b4", "b5", "c1"]);
  });

  it("stays a box a header fits in, even when every band is empty", () => {
    const box = lay({ phases: [{ title: "never", detail: null, members: [] }], unplaced: [] });
    expect(box.h).toBeGreaterThanOrEqual(BOX_HEADER_H);
    // Wide enough for the card that would have stood in it — a box narrower
    // than one member reads as a rule, not as a frame.
    expect(box.w).toBe(2 * BOX_PAD + boxMemberSize(false).w);
  });
});
