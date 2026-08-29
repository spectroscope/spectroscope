// Card 306: the geometry of ONE workflow box, pinned without a DOM.
//
// The interior of a box is a pure function of (declaration, members present,
// expanded) and nothing else. Pinning it here rather than in a render test is
// the point: a band that runs through its neighbour is arithmetic, and
// arithmetic is measurable without a browser.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BOX_BAND_GAP,
  BOX_BAND_LABEL_H,
  BOX_HEADER_H,
  BOX_MEMBER_CAP_HEAD_PX,
  BOX_MEMBER_CAP_STATUS_PX,
  BOX_MEMBER_CAP_TASK_PX,
  BOX_MEMBER_DISC_SHUT_H,
  BOX_MEMBER_FRAME_H,
  BOX_MEMBER_GAP,
  BOX_MEMBER_H_COMPACT,
  BOX_MEMBER_MEASURED_MAX,
  BOX_MEMBER_MEASURED_MIN,
  BOX_MEMBER_ROW_GAP,
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

// The header is written TWICE — as BOX_HEADER_H here, and as a literal height
// in flowmap.css, because a CSS `height` cannot read a TS constant. The pure
// geometry seats the first band BELOW the header by this many px, and the
// header is what fills that space on screen, so the two drifting apart leaves
// either a gap under the title or a title over the first band. Nothing renders
// that as an error; it reads as a design choice.
//
// The same pin cardGeometry.test.ts puts on the worker card's caps.
describe("the box header has ONE height", () => {
  const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");

  it("the CSS header is exactly the height the geometry seated the bands under", () => {
    const at = css.indexOf(".pf-wfbox__head {");
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf("}", at));
    expect(rule).toMatch(new RegExp(`height:\\s*${BOX_HEADER_H}px`));
  });
});

// ---------------------------------------------------------------------------
// THE RESERVE IS A MEASUREMENT, and it was 17px short of the card it holds.
//
// The handover said the minimal member "now measures 133 against the 132
// reserved". Measured on the shipped "declared workflow" scenario at 141/188,
// compact, through offsetHeight (React Flow's zoom is a viewport transform and
// is not in these numbers): three cards at 149, eight at 133, two at 112 —
// eleven of thirteen over the 132 that was reserved. The map's own compact
// seat is 132 too, but there a 44px rail gap swallows the difference; a band
// has 10px of foot and 12px of gap, so the same card crossed the dashed frame
// of the phase it is supposed to be standing in.
// ---------------------------------------------------------------------------
describe("what a compact member card costs", () => {
  it("reserves at least the tallest card the browser laid out in a box", () => {
    expect(BOX_MEMBER_H_COMPACT).toBeGreaterThanOrEqual(BOX_MEMBER_MEASURED_MAX);
  });

  it("does not reserve twice the shortest one either — the under-fill rule", () => {
    expect(BOX_MEMBER_H_COMPACT).toBeLessThan(2 * BOX_MEMBER_MEASURED_MIN);
  });

  // A value pin alone is green in both directions: write 165 back as a literal
  // and the equality still holds, because the parts sum to 165 today. What has
  // to hold is the LINK between the reserve and the caps that bound it, so the
  // sum is spelled out here and each cap is bitten against the CSS on its own.
  it("is the sum of the parts the CSS bounds, not a literal", () => {
    expect(BOX_MEMBER_H_COMPACT).toBe(
      BOX_MEMBER_FRAME_H +
        BOX_MEMBER_CAP_HEAD_PX +
        BOX_MEMBER_ROW_GAP +
        BOX_MEMBER_CAP_TASK_PX +
        BOX_MEMBER_ROW_GAP +
        BOX_MEMBER_CAP_STATUS_PX +
        BOX_MEMBER_DISC_SHUT_H,
    );
  });

  it("flowmap.css caps every region of a boxed member that grows with content", () => {
    const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");
    for (const [selector, cap] of [
      [".pf-sub--boxed .pf-sub__head", BOX_MEMBER_CAP_HEAD_PX],
      [".pf-sub--boxed .pf-sub__task", BOX_MEMBER_CAP_TASK_PX],
      [".pf-sub--boxed .pf-sub__status", BOX_MEMBER_CAP_STATUS_PX],
    ] as const) {
      const at = css.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      expect(css.slice(at, css.indexOf("}", at)), selector).toContain(`max-height: ${cap}px`);
    }
  });

  it("a band always holds the card it reserved for, in every phase shape", () => {
    for (const counts of [[1], [5], [1, 5, 1], [0, 3]]) {
      const run: RunPhases = {
        phases: counts.map((n, i) => ({
          title: `p${i}`,
          detail: null,
          members: Array.from({ length: n }, (_, k) => member(`p${i}-${k}`)),
        })),
        unplaced: [],
      };
      const box = workflowBoxLayout(run, { expanded: false, present: null, unplacedTitle: "unplaced" });
      for (const band of box.bands) {
        for (const m of band.members) {
          expect(m.y + BOX_MEMBER_MEASURED_MAX, band.title).toBeLessThanOrEqual(band.y + band.h);
        }
      }
    }
  });
});
