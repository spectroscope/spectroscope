// Card 178: the shell follows the window BOTH ways.
//
// It shrank and never grew back. The chain from `.ws-term` down to
// `.term-host` is all flex, and every box in it grew correctly except one:
// `.term` was `flex: 0 1 auto` — shrink allowed, grow forbidden — so it gave
// height back on the way down and could never take it again. Measured in the
// running app at viewport 900 → 600 → 900:
//
//   .ws-term   276 → 156 → 276   (correct)
//   .term      141 → …   → 141   (stuck: flex-grow was 0)
//   .term-host 194 →  61 →  61   (stuck, so the fit kept 3 rows)
//
// The ResizeObserver and FitAddon were never at fault: they cannot refit a box
// that never grew. Adding the grow gave host 61 → 196 and rows 3 → 10, live.
//
// A drift test rather than a DOM one: jsdom computes no flex layout, so the
// only honest thing to assert here is the declaration itself.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "styles", "terminal.css"), "utf8");

/** One rule's DECLARATIONS, by selector — comments stripped, because the
 *  narrative above a rule quotes the very shapes these tests forbid. */
function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at)).replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("the terminal box can take height back", () => {
  it("lets .term grow, not only shrink", () => {
    const body = rule(".term");
    expect(body).toMatch(/flex:\s*1\s+1\s+auto/);
    // The shape that caused it: a grow factor of 0 on this box means the
    // terminal can never recover height the window gives back.
    expect(body).not.toMatch(/flex:\s*0\s/);
  });

  it("keeps every box below it able to grow too", () => {
    // One `flex-grow: 0` anywhere in this chain reproduces the whole bug, so
    // the chain is pinned rather than just its one repaired link.
    for (const selector of [".term-body", ".term-view", ".term-host"]) {
      expect(rule(selector), selector).toMatch(/flex:\s*1\s+1\s+auto/);
    }
  });

  it("keeps min-height: 0 on the chain, which is what lets it shrink", () => {
    // The other half. Without it a flex item refuses to go below its content,
    // and the terminal would stop following the window downward instead.
    for (const selector of [".term", ".term-view", ".term-host"]) {
      expect(rule(selector), selector).toMatch(/min-height:\s*0/);
    }
  });
});
