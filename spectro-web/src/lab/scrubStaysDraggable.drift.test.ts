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
});
