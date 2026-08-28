// Card 293 fix round: the overlay SVG must not swallow the canvas's input.
//
// The workflow overlay is an inline SVG inside the ViewportPortal. Without
// its own rule it keeps the SVG default box (~300×150) and INTERCEPTS every
// pointer event over that box: panning and node clicks near the graph origin
// hit the SVG, not the canvas. The paths still paint (overflow is visible
// inline), so every server-render pin stays green — only a live browser shows
// the defect. The proven twin is `.sg-arcs` in styles/stategraph.css.
//
// A drift test rather than a DOM one: jsdom computes no layout and delivers
// no pointer events, so the only honest thing to assert is the declaration.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "workflow.css"), "utf8");

/** One rule's DECLARATIONS, by selector — comments stripped, because the
 *  narrative above a rule may quote the very shapes these tests forbid. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the overlay SVG lets pointer input through to the canvas", () => {
  it("pins .wf-arcs to the sg-arcs contract: absolute, full-size, inert", () => {
    const body = rule(".wf-arcs");
    // Without these two the SVG sits in flow at its default box and eats
    // clicks and pans over it — the exact defect the review found.
    expect(body).toMatch(/position:\s*absolute/);
    expect(body).toMatch(/pointer-events:\s*none/);
    // Full-size over the viewport, arcs allowed to leave the box.
    expect(body).toMatch(/inset:\s*0/);
    expect(body).toMatch(/width:\s*100%/);
    expect(body).toMatch(/height:\s*100%/);
    expect(body).toMatch(/overflow:\s*visible/);
  });
});
