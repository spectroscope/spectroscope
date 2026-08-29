// Card 303, defect B — the stylesheet's half of the repair, and the seam
// between it and the pure function.
//
// Two things have to be true and neither is visible to a unit test of the
// component:
//
//   1. The track carries a real MINIMUM. `min-width: 0` was the whole defect:
//      it told the flex algorithm that the one control the row exists for is
//      the one thing free to shrink to nothing, and it did — to 4.0px on a
//      771px viewport. The floor is what makes 4px unbuildable.
//   2. When even the minimum cannot be paid for, the row grows a LINE rather
//      than crushing the scrub. That is `flex-wrap: wrap` plus a track that
//      refuses to shrink; the scrub group's own min-content width then pushes
//      it onto a line of its own.
//
// And the seam: the widths at which the row drops a part are decided in
// transportFit.ts, applied by @container queries here, and there is no compiler
// between the two. This test is that compiler.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCRUB_MIN_WIDTH, TRANSPORT_YIELD_ORDER, dropWidthOf } from "./transportFit";
import { HIDDEN_BY } from "./transportFit";

/** Comments come off FIRST, and that ordering is load-bearing rather than
 *  tidiness. Stripping them after slicing means a `}` inside a comment ends the
 *  rule early: writing `input[type="range"] { margin: 2px }` in the prose above
 *  a declaration truncated the extracted body right there, and the assertion
 *  below it failed against a rule that was in fact correct. A false red is the
 *  lucky version — the same cut can hide a declaration a `not.toMatch` is
 *  hunting for and hand back a false green. */
const css = readFileSync(join(__dirname, "..", "styles", "lab.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rule(selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  expect(at, `${selector} must exist`).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}

/** Every `@container labtransport (max-width: Npx)` block, by the px it names. */
function containerQueries(): { max: number; body: string }[] {
  const out: { max: number; body: string }[] = [];
  const re = /@container labtransport \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) out.push({ max: Number(m[1]), body: m[2] });
  return out;
}

describe("the scrub keeps a usable width", () => {
  it("gives the track a floor instead of letting it shrink to nothing", () => {
    const body = rule(".lab-scrub-track");
    expect(body).not.toMatch(/min-width:\s*0/);
    const m = /min-width:\s*(\d+)px/.exec(body);
    expect(m, "the track must state a min-width in px").not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(SCRUB_MIN_WIDTH);
    // And absolutely, not only relative to the constant — the same reason
    // transportFit.test.ts writes NEVER_BELOW out in full. Measured: with
    // SCRUB_MIN_WIDTH lowered to 4 and this declaration lowered with it, every
    // assertion in both files still passed and the four-pixel scrub was back.
    expect(Number(m![1])).toBeGreaterThanOrEqual(200);
  });

  it("lets the row grow a line when it cannot pay for that floor", () => {
    expect(rule(".lab-transport")).toMatch(/flex-wrap:\s*wrap/);
  });

  it("keeps the range input inside the track it is 100% of", () => {
    // MEASURED in a browser on this stylesheet, row 513px: track clientWidth
    // 283, scrollWidth 285 — the input's box ran 2px past the track at each
    // edge. `width: 100%` resolves against the track, and every engine ships
    // `input[type=range] { margin: 2px }` as a UA default, so the input is
    // always its container plus 4px.
    //
    // This is older than card 303 and the floor is what made it show. While
    // the track could still shrink to nothing the flex algorithm simply took
    // the 4px out of it and nobody saw a thing; a track that refuses to shrink
    // has to hand the overflow to the row instead, and the row then scrolls
    // sideways by 2px at every width narrow enough to matter. Zeroing the
    // horizontal margin is the whole fix — the vertical one is left alone,
    // because it is the input's spacing from the tick row under it.
    const body = rule('.lab-scrub-track input[type="range"]');
    expect(body).toMatch(/margin-left:\s*0/);
    expect(body).toMatch(/margin-right:\s*0/);
  });

  it("names the row as the container the parts measure themselves against", () => {
    const body = rule(".lab-transport");
    expect(body).toMatch(/container-type:\s*inline-size/);
    expect(body).toMatch(/container-name:\s*labtransport/);
  });

  it("never hides the drawer that carries the only grain and tempo controls", () => {
    // A @container query that hides `.lab-advanced` is the one hiding rule
    // this row must not have. Measured in a browser at a 488px row: the rule
    // computed `display: none` on the drawer and both grain buttons reported
    // a width of 0 — and with it the tempo slider, the only one the app has.
    // The row's honest answer at that width is the one it already has for the
    // scrub: wrap, and give the drawer a line of its own.
    for (const q of containerQueries()) {
      expect(q.body, `the ${q.max}px query must not hide the drawer`).not.toContain(".lab-advanced");
    }
  });

  it("hides each part at exactly the width the pure function decided", () => {
    const queries = containerQueries();
    expect(queries.length).toBe(TRANSPORT_YIELD_ORDER.length);
    for (const part of TRANSPORT_YIELD_ORDER) {
      const selector = HIDDEN_BY[part];
      const hit = queries.filter((q) => q.body.includes(selector));
      expect(hit, `${part} (${selector}) must be hidden by exactly one query`).toHaveLength(1);
      expect(hit[0].max, `${part}`).toBe(dropWidthOf(part));
      expect(hit[0].body).toMatch(/display:\s*none/);
    }
  });
});
