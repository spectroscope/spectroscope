// Card 303, defect A — the third of the three parts, and the one that does the
// cutting. The layout hands out a width and the overlay draws a box of that
// width; neither of them shortens a word. The stylesheet does, and a stylesheet
// has no test unless one is written: `text-overflow: ellipsis` needs BOTH
// `overflow: hidden` and `white-space: nowrap` beside it, and dropping any one
// of the three silently restores the overflowing caption this card is about.
//
// jsdom is not in this gate and would compute no layout anyway, so the honest
// thing to assert is the declaration itself — the same reasoning as
// scrubStaysDraggable.drift.test.ts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Comments off FIRST — a `}` written inside the prose above a declaration ends
 *  the extracted rule there and the assertions below it judge a fragment.
 *  See the same helper in scrubKeepsItsWidth.drift.test.ts, where exactly that
 *  happened. */
const css = readFileSync(join(__dirname, "workflow.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

describe("an over-long caption is cut, not spilled", () => {
  it("clips the caption to its box", () => {
    expect(rule(".wf-ranklabel")).toMatch(/overflow:\s*hidden/);
  });

  it("marks the cut with an ellipsis instead of ending mid-word", () => {
    expect(rule(".wf-ranklabel")).toMatch(/text-overflow:\s*ellipsis/);
  });

  it("keeps the caption on one line, or there is nothing to cut", () => {
    expect(rule(".wf-ranklabel")).toMatch(/white-space:\s*nowrap/);
  });
});
