// Card 482, fix round: the run view keeps a canvas at narrow widths.
//
// Measured 2026-10-10 on a temp-home jar (kanban/evidence/482/run6-child,
// run6-child-report.json, key geometry): getBoundingClientRect of .sg-canvas
// in the run view gave 365 px of height at a 1280 px window and 0 px at 390.
// Under the state graph's narrow breakpoint the view stacks the side panel
// under the canvas, and the run view's fixed height went to the header, the
// wrapped transport and the panel. The canvas row is minmax(0, 1fr), so it
// was the one that gave way, and the lit graph was not visible at all.
//
// The fix reserves a canvas height under the same breakpoint and lets the
// run view grow to hold it. A max-height would only cap the canvas, so this
// pins a min-height read from a token, and no fixed height on the box.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blankBlockComments, rules } from "../testkit/source";

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** The bodies of every `@media (max-width: Npx)` block, keyed by N. */
function narrowBlocks(css: string): Map<number, string[]> {
  const clean = blankBlockComments(css);
  const out = new Map<number, string[]>();
  for (const m of clean.matchAll(/@media\s*\(max-width:\s*(\d+)px\)\s*\{/g)) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    const start = i;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "{") depth += 1;
      else if (clean[i] === "}") depth -= 1;
      i += 1;
    }
    const width = Number(m[1]);
    out.set(width, [...(out.get(width) ?? []), clean.slice(start, i - 1)]);
  }
  return out;
}

/** The width under which the state graph stacks its panel under the canvas. */
function stackingBreakpoint(): number {
  for (const [width, bodies] of narrowBlocks(read("./stategraph.css"))) {
    const stacks = bodies.some((b) =>
      rules("stategraph.css", b).some(
        (r) => r.selector === ".sg-body" && /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/.test(r.body),
      ),
    );
    if (stacks) return width;
  }
  throw new Error("stategraph.css has no narrow block that stacks .sg-body into one column");
}

const RUN = read("./playbook-run.css");

/** Every rule of playbook-run.css that applies at or below the stacking width. */
function rulesAtNarrow(): ReturnType<typeof rules> {
  const at = stackingBreakpoint();
  const out: ReturnType<typeof rules> = [];
  for (const [width, bodies] of narrowBlocks(RUN)) {
    if (width < at) continue;
    for (const b of bodies) out.push(...rules("playbook-run.css", b));
  }
  return out;
}

describe("the run view keeps its canvas at narrow widths (card 482)", () => {
  it("reserves a canvas height from a token under the state graph's stacking breakpoint", () => {
    const canvas = rulesAtNarrow().filter((r) => r.selector === ".pb-run-graph .sg-canvas");
    expect(canvas, "a rule for the run view's canvas under the stacking breakpoint").toHaveLength(1);
    expect(canvas[0].body).toMatch(/(^|[;\s])min-height:\s*var\(--pb-run-canvas-min\)\s*;/);
    expect(canvas[0].body).not.toMatch(/max-height/);
  });

  it("the token is a real height that holds a node card and its neighbours", () => {
    const px = read("../tokens.css").match(/--pb-run-canvas-min:\s*(\d+)px\s*;/)?.[1];
    expect(px, "--pb-run-canvas-min is declared in tokens.css in px").toBeDefined();
    // A node card is 46 px high (stategraph.css .sg-card); a reservation
    // under 240 px shows one or two of them and calls that a graph.
    expect(Number(px)).toBeGreaterThanOrEqual(240);
  });

  it("the run view grows with its canvas instead of holding a fixed height there", () => {
    const narrow = rulesAtNarrow();
    const box = narrow.filter((r) => r.selector === ".pb-run-graph");
    expect(box, "the run view's box is restated under the stacking breakpoint").not.toHaveLength(0);
    for (const r of box) expect(r.body).not.toMatch(/(^|[;\s])height:\s*\d/);
    expect(box.some((r) => /(^|[;\s])height:\s*auto\s*;/.test(r.body))).toBe(true);
    const sg = narrow.filter((r) => r.selector === ".pb-run-graph .sg");
    expect(sg).toHaveLength(1);
    expect(sg[0].body).toMatch(/(^|[;\s])height:\s*auto\s*;/);
  });
});
