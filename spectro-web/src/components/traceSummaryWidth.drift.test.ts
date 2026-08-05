// The summary cell shares its width with the chips, and it may not lose all of
// it.
//
// This suite has no renderer, so it reads the two declarations off the
// stylesheet. What it guards is a measurement taken in Chrome against this very
// file, with the corpus's widest chip run on the row
// ("skill superpowers:test-driven-development · mcp ccd_session:mark_chapter ·
// effort max · model swapped claude-fable-5 → claude-opus-4-8", 131
// characters):
//
//   panel width   chips   summary before   summary after
//   1600 px       4       0 px             192 px
//   1280 px       2       0 px             135 px
//   1280 px       3       0 px             114 px
//
// Two chips is not a corner case: of the 167 transcripts under
// ~/.claude/projects, 18,190 anchored lines carry two chips and 4,657 carry
// three (measured 2026-08-04). A row whose summary is gone no longer says what
// the frame IS, which is worse than a chip that ends in an ellipsis and keeps
// its whole value in the title attribute.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const panelsCss = readFileSync(fileURLToPath(new URL("../styles/panels.css", import.meta.url)), "utf8");

/** @return the one declaration block for `selector`, without its braces */
function rule(selector: string): string {
  const at = panelsCss.indexOf(`\n${selector} {`);
  if (at < 0) throw new Error(`panels.css no longer has a single-line rule for ${selector}`);
  return panelsCss.slice(panelsCss.indexOf("{", at) + 1, panelsCss.indexOf("}", at));
}

describe("the trace row's summary keeps a floor", () => {
  const summary = rule(".trace-summary-text");

  it("does not let the text shrink to nothing", () => {
    // `min-width: 0` was the old value and is what took it to 0 px.
    expect(summary).toMatch(/min-width:\s*10ch/);
    expect(summary).not.toMatch(/min-width:\s*0/);
  });

  it("still gives its width up before the chips do", () => {
    // Basis auto, not 0: the text yields down to the floor and no further.
    expect(summary).toMatch(/flex:\s*1 1 auto/);
  });

  it("ellipsizes what does not fit rather than clipping it", () => {
    expect(summary).toMatch(/text-overflow:\s*ellipsis/);
    expect(summary).toMatch(/white-space:\s*nowrap/);
  });
});

describe("a single chip cannot eat the row", () => {
  const note = rule(".trace-note");

  it("caps how wide one chip may grow", () => {
    // 22ch fits "skill superpowers:tes…"; the whole value rides in the title,
    // which is the rule this cap depends on.
    expect(note).toMatch(/max-width:\s*22ch/);
  });

  it("keeps the chip shrinkable and visibly cut", () => {
    expect(note).toMatch(/flex:\s*0 1 auto/);
    expect(note).toMatch(/text-overflow:\s*ellipsis/);
  });
});
