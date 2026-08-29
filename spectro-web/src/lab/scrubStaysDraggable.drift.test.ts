// Card 299, fix round: the chapter ticks must not take the pointer away from
// the scrub bar.
//
// The first build drew them as `position: absolute; inset: 0` over the range
// input, each tick an 11px-wide button with `pointer-events: auto`. Measured on
// a plain 60-turn single-agent run (422 events, 242 coarse steps — the "several
// hundred coarse steps" the card is written for): 61 ticks, 671px of combined
// hit box, adjacent centres 1.65% apart, which is 9.9px on a 600px track. The
// hit boxes therefore touched, and the slider under them could not be dragged
// at all — an existing shipped control stopped working, and no test saw it.
//
// The repair is structural: the ticks live in a row of their OWN, under the
// range input. However many of them there are, they cannot overlay the slider.
// jsdom is not in this gate and would compute no layout anyway, so the honest
// thing to assert is the declaration itself — the same reasoning as
// workspace/terminalGrows.drift.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "styles", "lab.css"), "utf8");

/** One rule's DECLARATIONS, by selector — comments stripped, because the
 *  narrative above a rule names the very shapes these tests forbid. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the tick layer sits beside the slider, not on top of it", () => {
  it("does not lift .lab-marks out of the flow onto the track", () => {
    const body = rule(".lab-marks");
    // The shape that broke the drag: an absolutely positioned layer pinned over
    // the input's own box.
    expect(body).not.toMatch(/position:\s*absolute/);
    expect(body).not.toMatch(/inset:/);
  });

  it("gives the tick row a height of its own, so it is a row and not an overlay", () => {
    expect(rule(".lab-marks")).toMatch(/height:\s*\d/);
  });

  it("stacks the track's two rows, slider above ticks", () => {
    expect(rule(".lab-scrub-track")).toMatch(/flex-direction:\s*column/);
  });

  // The second fix round. The two assertions above forbid ONE of the three
  // shapes that put a tick back over the slider, and the third was a single
  // declaration away.
  //
  // `.lab-mark` is `position: absolute; top: 0; bottom: 0`, so its containing
  // block is the nearest POSITIONED ancestor — the tick row only because
  // `.lab-marks` says `position: relative`. Measured in a browser on this
  // stylesheet, one 900px transport, all four shapes:
  //
  //   track static  + marks relative  ticks y 63–72 under an input y 44–60,
  //                                   a 3px gap, elementFromPoint → INPUT
  //   track relative + marks relative  every number identical to the above
  //   track relative + marks static    ticks y 42–72 ACROSS the input y 44–60,
  //                                   16px overlap, elementFromPoint → the tick
  //   track static  + marks static     ticks 1260px tall, spanning the page
  //
  // The third row is the original blocker, and one deleted declaration was all
  // that stood between it and the shipped build — 4813 tests saw none of it.
  // The first two rows are why dropping the track's `position: relative` is
  // safe: it moved nothing.
  it("keeps the tick row itself positioned, so a tick resolves against IT", () => {
    expect(rule(".lab-marks")).toMatch(/position:\s*relative/);
  });

  it("leaves nothing else in the track for a tick to resolve against", () => {
    // Rather than guard the escape route, remove it: the track is a flex
    // column now and needs no containing block of its own, so the shape where
    // a tick spans the whole track cannot be built at all.
    expect(rule(".lab-scrub-track")).not.toMatch(/position:\s*(relative|absolute|fixed|sticky)/);
  });
});
