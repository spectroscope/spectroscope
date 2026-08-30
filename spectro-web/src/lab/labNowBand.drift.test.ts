// CARD 319, AC 3 — the status band stops shoving the map down.
//
// This one is the mover the scouting for this card never named, and it is the
// bigger half of what the owner sees. The scouting said the whole-scene shift
// had to be either the fold or `fitView`; measured, it is NEITHER. Over his
// own 3328 steps the agent node's world y is 150, one value, and the React
// Flow viewport transform is `x 265.34, y 30.57, zoom 0.35133`, one value —
// and the card's top on screen still takes four, travelling 53.3 px.
//
// WHAT ACTUALLY MOVES IT, measured live at a 1600x900 window:
//
//   .lab-now text                                     band h   .lab-flowmap y   h
//   "the harness is working" (idle)                     47.0        172.2      581
//   "running: sh scripts/check-install-docs.sh > …"     84.1        209.2      544
//   "running: git add README.md index.html scripts/…"  100.4        225.5      540
//
// 100.4 - 47.0 = 53.4, which is the 53.3 the card top travels. The owner named
// the cause himself without knowing the mechanism: "depending on how big the
// command is."
//
// THE MECHANISM, and it is two properties that must not be apart.
// `.lab-now` is `flex-wrap: wrap` (card 296 added it so a fourth control could
// not be cut off at a narrow pane). `.lab-now-label` is `white-space: nowrap`
// with `overflow: hidden` and an ellipsis — but a flex item's default
// `min-width: auto` floors it at its MIN-CONTENT width, and for a nowrap item
// min-content is the entire string. So the ellipsis never gets a chance: the
// label refuses to shrink, and the four trailing controls are pushed onto a
// second and a third line instead.
//
// WHAT THIS FILE CAN PROVE, and what it cannot. It cannot render, so it cannot
// measure a band height; AC 3 asks for the OUTCOME and the outcome is measured
// in the running app by cardStillness.ts's arm, whose `tops` reading is exactly
// where this band's effect lands. What the gate can hold is the seam: the pair
// of properties that has to travel together, DERIVED from the stylesheet so a
// segment added later is judged too — the same shape as
// scrubKeepsItsWidth.drift.test.ts, which welds transportFit's thresholds to
// the @container queries that apply them.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Comments off FIRST (the scrubKeepsItsWidth lesson): a `}` inside a comment
 *  ends an extracted rule early, and the assertion below it then judges a rule
 *  that is not there. A false red is the lucky version of that. */
const css = readFileSync(join(__dirname, "..", "styles", "lab.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

interface Rule {
  selector: string;
  body: string;
}

/** Every rule in the stylesheet, as selector and body. */
function rules(): Rule[] {
  const out: Rule[] = [];
  const re = /(^|\n)([^{}\n][^{}]*)\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[2].trim(), body: m[3] });
  }
  return out;
}

const bandRules = () => rules().filter((r) => /(^|[\s,>+~.])lab-now/.test(r.selector));

/**
 * Every segment of the status band that refuses to break its text.
 *
 * DERIVED, not listed: `white-space: nowrap` is the declaration that makes a
 * flex item's min-content width its whole string, so it is the declaration
 * that decides whether a segment can push its neighbours onto a new line. Any
 * `.lab-now` rule carrying it is a segment this file has to judge — including
 * one added next year by someone who never read this comment.
 */
const unbreakableSegments = () => bandRules().filter((r) => /white-space:\s*nowrap/.test(r.body));

describe("the band cannot be pushed onto a second line", () => {
  // The floor under everything else here: a derivation that finds nothing
  // would make the assertions below green about a band that is still growing.
  it("finds the segment the browser measured growing the band", () => {
    expect(unbreakableSegments().map((r) => r.selector)).toContain(".lab-now-label");
  });

  // THE PIN. A segment that will not break its text must be allowed to shrink,
  // or the flex algorithm has nowhere to take the width from but a new line.
  // `min-width: 0` is what turns the ellipsis that is already declared on
  // `.lab-now-label` from decoration into behaviour.
  //
  // This is a NECESSARY condition and it is not the proof — the proof is one
  // height for every command in the recording, and it is measured in a
  // browser. Named as such so nobody reads a green here as a still band.
  it.each(unbreakableSegments().map((r) => r.selector))("%s is allowed to shrink", (selector) => {
    const rule = bandRules().find((r) => r.selector === selector)!;
    expect(rule.body, `${selector} refuses to break AND refuses to shrink`).toMatch(/min-width:\s*0/);
  });

  // Shrinking without an ellipsis is just a different way to lose the command,
  // and losing it is worse than the flicker: the owner steps through this run
  // to read what is running.
  it.each(unbreakableSegments().map((r) => r.selector))("%s truncates instead of vanishing", (selector) => {
    const rule = bandRules().find((r) => r.selector === selector)!;
    expect(rule.body, selector).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule.body, selector).toMatch(/overflow:\s*hidden/);
  });
});

describe("what the band still has to be able to do", () => {
  // Card 296 put `flex-wrap: wrap` here for a real reason — "a control the
  // pane cannot show is a control that is not there" — and this card must not
  // pay for a still band with a control cut off at a narrow pane. With the
  // label able to shrink, the wrap simply stops firing at ordinary widths and
  // stays as the fallback it was meant to be. So it is pinned as something to
  // KEEP, not something to remove: deleting it would look like a fix here and
  // reopen card 296 at the same time.
  it("keeps the fallback that stops a narrow pane cutting a control off", () => {
    const band = bandRules().find((r) => r.selector === ".lab-now");
    expect(band, ".lab-now must exist").toBeDefined();
    expect(band!.body).toMatch(/flex-wrap:\s*wrap/);
  });
});
