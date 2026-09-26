// Card 435, review finding 2 (2026-09-25): the count on the trace tab keeps its
// place from the open. Before an archive knows its count, the chip is drawn
// hidden at the width of its least count, so the tabs to its right do not move
// when the number arrives. Rendered to static markup (no DOM in this suite,
// house rule); styles/graph.css hides the pending chip
// (archiveTraceWiring.drift.test.ts).

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TraceTabCount } from "./TraceTabCount";

/**
 * The markup's text for the assertions. Tags are stripped until none is left,
 * so a tag that only forms once an inner one is gone goes too.
 */
function stripTags(markup: string): string {
  let text = markup;
  for (let prev = ""; prev !== text;) {
    prev = text;
    text = text.replace(/<[^>]*>/g, "");
  }
  return text;
}

const render = (count: number | null, least: number): string =>
  renderToStaticMarkup(<TraceTabCount count={count} least={least} />);

describe("the count on the trace tab", () => {
  it("shows a known count, with its label", () => {
    expect(render(91_957, 91_956)).toBe(
      '<span class="tab-count tabular" aria-label="91957 frames">91957</span>',
    );
    expect(render(40, 0)).toBe('<span class="tab-count tabular" aria-label="40 frames">40</span>');
  });

  it("shows nothing for a known count of none", () => {
    expect(render(0, 0)).toBe("");
    expect(render(0, 12)).toBe("");
  });

  it("holds the place of a count not known yet with a hidden chip as wide as the least count", () => {
    const markup = render(null, 91_956);
    expect(markup).toBe('<span class="tab-count tabular tab-count--pending" aria-hidden="true">00000</span>');
    // The same characters in the same mono face as the number that replaces it.
    const held = stripTags(markup);
    expect(held).toHaveLength(String(91_957).length);
    expect(stripTags(render(null, 7))).toBe("0");
  });

  it("holds no place when the record has no rows to count", () => {
    expect(render(null, 0)).toBe("");
  });
});
