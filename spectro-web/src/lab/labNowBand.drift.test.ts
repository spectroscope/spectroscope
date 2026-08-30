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

  // THE OTHER HALF, and it was found by measuring rather than by reading: with
  // `min-width: 0` alone the band still rendered 100.36px on the same command.
  // A wrapping flex container breaks its lines BEFORE it shrinks anything, and
  // line-breaking uses the item's flex BASE size — `auto`, which for a nowrap
  // item is the whole string again, so the label kept starting a line of its
  // own. At a base of 0 it always fits the first line and truncates inside it.
  // Both declarations or neither: either one alone leaves the band growing.
  it.each(unbreakableSegments().map((r) => r.selector))("%s starts from no width at all", (selector) => {
    const rule = bandRules().find((r) => r.selector === selector)!;
    expect(rule.body, `${selector} may shrink but still claims a line of its own`).toMatch(
      /flex:\s*\d+\s+\d+\s+0(?![.\d])/,
    );
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

// ---------------------------------------------------------------------------
// THE HALF THE FIRST PASS MISSED: the label is not the only thing in this band
// whose width the run decides.
//
// `min-width: 0` and `flex: 1 1 0` take the LABEL out of the line-breaking
// decision. They do nothing about the queue chip beside it, which appears while
// events are still waiting and vanishes on the last step — and a chip that
// comes and goes IS the band changing line count, exactly the way a panel that
// comes and goes was the card changing height.
//
// MEASURED, in the running app, same instrument as the rest of this card
// (playwright + Chrome, frames counted first, the chip removed and put back on
// one settled page):
//
//                        with the chip   without it
//   1600x900                   47.05        47.05
//   1280x800                   47.05        47.05
//   1100x700                   84.09        47.05   <- 37.04 px, on one click
//
// And it is this card's own doing: with the two declarations above undone on
// the same page, 1100x700 reads 84.09 BOTH ways. The label could not shrink, so
// the band was already on two lines and the chip changed nothing. Making the
// label shrink handed the chip the casting vote.
//
// THE FIX, and why it is a wrapper rather than a third declaration. The chip
// cannot be given a flex base of 0 — it has no room to shrink into and would
// simply disappear. So the label and the chip go into ONE group that has the
// base of 0, and the chip takes its width out of the label's share instead of
// out of the band's line. The line-breaking sees one item whose base never
// changes, so the run cannot move it. Re-measured the same way: 47.05 / 47.05 /
// 84.09 / 84.09 — one value at every width, chip or no chip.
//
//   node /tmp/c319fix/group.mjs   # W/H per run, MIN=24ch
// ---------------------------------------------------------------------------

/** The two files that render this band. */
const BANDS = ["LabTransport.tsx", "FleetLab.tsx"] as const;
const bandSource = (file: string) => readFileSync(join(__dirname, file), "utf8");

/** The `.lab-now` element's markup in one of those files, from its opening tag
 *  to the matching close — depth-counted, because the band holds nested
 *  elements and the first `</div>` is not its end. */
function bandMarkup(file: string): string {
  const src = bandSource(file);
  const from = src.indexOf('<div className="lab-now"');
  expect(from, `${file} must render the band`).toBeGreaterThan(-1);
  let depth = 0;
  const tag = /<(\/?)div\b|\/>/g;
  tag.lastIndex = from;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(src)) !== null) {
    if (m[0] === "/>") continue;
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return src.slice(from, tag.lastIndex);
    } else depth++;
  }
  throw new Error(`${file}: the band's markup never closes`);
}

/**
 * Every band element the run can take away, by class.
 *
 * DERIVED: an element written behind a `&&` or a `?` is one the markup renders
 * on some steps and not on others. Listing "the queue chip" here would be the
 * card-312 defect — the next conditional chip somebody adds would sail past a
 * hand list, and it is a conditional chip that broke this band in the first
 * place.
 */
function conditionalBandClasses(file: string): string[] {
  const markup = bandMarkup(file);
  const out = new Set<string>();
  for (const m of markup.matchAll(/className="(lab-now-[^"]*)"/g)) {
    const before = markup.slice(Math.max(0, m.index - 120), m.index);
    if (!/(&&|\?)\s*(\(\s*)?<[^<>]*$/.test(before)) continue;
    // Only the band's own classes: `mono` and `tabular` ride along on the same
    // element and are typography, not a box in this layout.
    for (const c of m[1].split(/\s+/)) if (c.startsWith("lab-now-")) out.add(c);
  }
  return [...out].sort();
}

/** Whether an element carrying `token` sits inside the shrinkable group. */
function insideTheGroup(file: string, token: string): boolean {
  const markup = bandMarkup(file);
  const open = markup.indexOf('className="lab-now-say"');
  if (open === -1) return false;
  // The group holds spans and nothing else, so its own first `</div>` ends it.
  const close = markup.indexOf("</div>", open);
  const at = markup.search(new RegExp(`className="[^"]*\\b${token}\\b`));
  return at > open && at < close;
}

describe("nothing the run can take away decides how many lines the band has", () => {
  // The derivation, before it is believed — from both sides. A rule that found
  // nothing would make the containment case below vacuously green, and a rule
  // that found everything would demand the tag and the dot move too.
  it.each(BANDS)("%s: finds the chip the run takes away, and not the fixtures", (file) => {
    const found = conditionalBandClasses(file);
    expect(found, `${file} has no conditional band element at all`).not.toEqual([]);
    expect(found).toContain("lab-now-queue");
    expect(found).not.toContain("lab-now-tag");
    expect(found).not.toContain("lab-now-dot");
    expect(found).not.toContain("lab-now-label");
  });

  it.each(BANDS)("%s: every one of them shares the label's group", (file) => {
    for (const token of conditionalBandClasses(file)) {
      expect(
        insideTheGroup(file, token),
        `.${token} comes and goes as a direct child of .lab-now, so its arrival ` +
          `re-decides how many lines the band takes and the map moves under it`,
      ).toBe(true);
    }
  });

  it.each(BANDS)("%s: and the label is in there with them", (file) => {
    expect(insideTheGroup(file, "lab-now-label"), `${file}`).toBe(true);
  });

  // `insideTheGroup` ends the group at its first `</div>`, which is only right
  // while the group holds spans and nothing else. Said out loud and checked,
  // because a silent premise is how a containment check starts answering about
  // the wrong span.
  it.each(BANDS)("%s: the group holds spans, which is what lets this be read", (file) => {
    const markup = bandMarkup(file);
    const open = markup.indexOf('className="lab-now-say"');
    expect(open, `${file} must render the group`).toBeGreaterThan(-1);
    expect(markup.slice(open, markup.indexOf("</div>", open))).not.toContain("<div");
  });

  // The group is only worth anything if line-breaking cannot see what is inside
  // it — the same `flex: … 0` lesson the label learned above, one level up.
  it("the group starts from no width at all", () => {
    const group = rules().find((r) => r.selector === ".lab-now-say");
    expect(group, ".lab-now-say must exist").toBeDefined();
    expect(group!.body, "the group claims a line off its content").toMatch(/flex:\s*\d+\s+\d+\s+0(?![.\d])/);
  });

  // And a floor, or the fix trades a still band for a band with no command in
  // it: at 1100x700 an unfloored group renders the label 0 px wide. Measured
  // with the floor: 81 px, which is what the band gave it before this card.
  it("the group keeps room for the command it exists to show", () => {
    const group = rules().find((r) => r.selector === ".lab-now-say")!;
    expect(group.body, "the group may shrink to nothing").toMatch(/min-width:\s*\d/);
  });
});

describe("a truncated command is still reachable", () => {
  // The rule this file already states — "losing it is worse than the flicker:
  // the owner steps through this run to read what is running" — and the
  // ellipsis IS losing it. Measured on the owner's own command string at three
  // windows, before this case existed:
  //
  //   1600x900   61 of 119 characters      1440x900   39      1280x800   17
  //
  // ToolCallPanel.tsx recovers its own clipped label into a `title` for exactly
  // this reason; the band, which carries the string he is actually reading, did
  // not. DERIVED from the stylesheet: whatever truncates has to hand the whole
  // string back.
  const truncating = () => bandRules().filter((r) => /text-overflow:\s*ellipsis/.test(r.body));

  it("finds the segment that truncates", () => {
    expect(truncating().map((r) => r.selector)).toContain(".lab-now-label");
  });

  it.each(BANDS)("%s: every truncating segment hands the whole string back", (file) => {
    const markup = bandMarkup(file);
    for (const rule of truncating()) {
      const token = rule.selector.replace(/^\./, "");
      const at = markup.search(new RegExp(`className="[^"]*\\b${token}\\b`));
      if (at === -1) continue;
      const tag = markup.slice(markup.lastIndexOf("<", at), markup.indexOf(">", at));
      expect(tag, `.${token} clips the text and offers no way to read the rest`).toMatch(/\btitle=/);
    }
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
