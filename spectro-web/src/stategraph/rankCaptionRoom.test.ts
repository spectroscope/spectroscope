// Card 303, defect A: a column caption must stay inside its own column.
//
// MEASURED on the merged head, in a browser, at the shipped fit scale 0.5758:
// the caption "merge - one picture out of five" [left 393.2, right 517.0] ran
// 14.4px into "draft - write it up" [left 502.6] in the SAME band, and the page
// read "...out of fdraft write it up". At zoom 0.995 the same pair overlapped
// by 25px, so the collision is scale-invariant. The second face of it: "scope -
// decide what to look at" [right 234] ran over the phase BOX at [left 216] of
// the column to its right.
//
// Both faces are ONE fact: the caption is anchored on its column's left edge
// and was given no width, so any title wider than the column pitch runs into
// the neighbour — into its caption, into its box, into both.
//
// This pins the room, not the words. The titles below are deliberately far
// longer than anything the shipped scenario carries, because a test that only
// checks the shipped scenario pins nothing: those titles could be shortened
// tomorrow and the defect would still be there for the next author's.
import { describe, expect, it } from "vitest";
import { RANK_CAPTION_GUTTER, layoutStateGraph, type Topology } from "./layout";

const LONG = "merge - one picture out of five, and a title nobody is going to shorten";
const LONGER = "and a detail line that is just as long as the title above it, deliberately";

/** A chain of `n` captioned columns — the workflow lens's own shape. */
function chain(n: number): Topology {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `p${i}` }));
  return {
    entry: "p0",
    nodes,
    edges: nodes.slice(1).map((x, i) => ({ from: `p${i}`, to: x.id, kind: "spawn" as const })),
    ranks: new Map(nodes.map((x, i) => [x.id, i])),
    rankCaptions: new Map(nodes.map((_, i) => [i, { title: LONG, detail: LONGER }])),
  };
}

describe("a rank caption is given the room it may use", () => {
  it("never hands out more than one column pitch, however long the title", () => {
    const laid = layoutStateGraph(chain(5), "horizontal");
    expect(laid.rankLabels).toHaveLength(5);
    const pitch = laid.rankLabels[1].x - laid.rankLabels[0].x;
    expect(pitch).toBeGreaterThan(0);
    for (const l of laid.rankLabels) {
      expect(l.maxWidth, `rank ${l.rank}`).toBeGreaterThan(0);
      expect(l.maxWidth, `rank ${l.rank}`).toBeLessThanOrEqual(pitch - RANK_CAPTION_GUTTER);
    }
  });

  it("keeps every pair of caption boxes apart, whatever band they landed in", () => {
    // The y anchor is per rank (a tall column lifts its own caption), so two
    // captions can share a band or not. Disjoint x intervals hold either way,
    // which is the stronger statement and the one the reader needs.
    //
    // DAYLIGHT, not merely "not overlapping". Written as an absolute literal
    // and not as RANK_CAPTION_GUTTER, because a threshold taken from the
    // constant under test cannot fail: bitten, with the gutter edited to 0 all
    // four tests in this file passed, and a caption ending on the exact pixel
    // the next one starts still reads as one run of words. At 10px mono the
    // gap has to be about a character wide before the eye separates them.
    const MIN_DAYLIGHT = 8;
    const laid = layoutStateGraph(chain(5), "horizontal");
    for (const a of laid.rankLabels) {
      for (const b of laid.rankLabels) {
        if (a.rank >= b.rank) continue;
        expect(a.x + a.maxWidth, `rank ${a.rank} into rank ${b.rank}`).toBeLessThanOrEqual(
          b.x - MIN_DAYLIGHT,
        );
      }
    }
  });

  it("keeps a caption off the boxes of the column next door", () => {
    // The second face, and the one commit 5dfac75e did not touch: it raised a
    // caption clear of the TALL box it names, and a caption running sideways
    // into the neighbour's box was never in question.
    const laid = layoutStateGraph(chain(5), "horizontal");
    for (const l of laid.rankLabels) {
      for (const n of laid.nodes) {
        if (n.rank <= l.rank) continue;
        expect(l.x + l.maxWidth, `rank ${l.rank} into ${n.id}`).toBeLessThanOrEqual(n.x);
      }
    }
  });


  it("takes a NARROW rank's room from that rank, not from the cell constant", () => {
    // THE MERGE SEAM of cards 303 and 305, and nothing in the merge showed it.
    // 303 wrote this bound as the constant `NW + gapAlong`, which WAS every
    // column's pitch while every box was a cell. 305 made a rank as long as
    // its longest box and lets a caller state a width BELOW NW. A rank that
    // states 60 is then 72px narrower than the constant assumes, so the
    // constant hands its caption room it does not own and the caption reaches
    // into the neighbour again — 303's own defect, restored by a textually
    // clean merge that compiled and left every other test in this file green.
    //
    // Bitten: with the bound written back as `NW + gapAlong` this is the only
    // assertion in the suite that goes red.
    const laid = layoutStateGraph({ ...chain(3), sizes: new Map([["p0", { w: 60, h: 46 }]]) }, "horizontal");
    const narrow = laid.rankLabels[0];
    const pitch = laid.rankLabels[1].x - narrow.x;
    expect(pitch).toBeLessThan(132 + 58); // the rank really is narrower than a cell
    expect(narrow.maxWidth).toBeLessThanOrEqual(pitch - RANK_CAPTION_GUTTER);
    // and the consequence the reader actually sees: it stops short of the box next door
    for (const n of laid.nodes) {
      if (n.rank <= narrow.rank) continue;
      expect(narrow.x + narrow.maxWidth, `into ${n.id}`).toBeLessThanOrEqual(n.x);
    }
  });

  it("gives a lone column its room too — there is no neighbour to borrow from", () => {
    const laid = layoutStateGraph(chain(1), "horizontal");
    expect(laid.rankLabels).toHaveLength(1);
    expect(laid.rankLabels[0].maxWidth).toBeGreaterThan(0);
  });
});
