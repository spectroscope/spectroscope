// One parsed-selector locator, and the decoy that keeps it parsed (card 360).
//
// WHY THIS FILE EXISTS BEFORE THREE STYLESHEET CARDS, not after. On 2026-08-30
// three reviewers found the same hole from three directions: one locator took
// `selector.split(/\s+/).pop()` so the last compound won and the scope was
// lost; another anchored on the literal `".pf-tools {"`, which
// `.pf-agent--wide .pf-tools {` contains as a substring. Both attributed a
// SCOPED rule to the UNSCOPED element. The proof that this is not theoretical
// is unpleasant: the mutation left that suite 24/24 green.
//
// Measured again 2026-09-01, and it is worse than that card knew — FOUR
// hand-rolled locators, three substring-based:
//   · dockNarrow.drift.test.ts:22    `css.indexOf(sel)`
//   · composerFold.drift.test.ts:28  a byte-identical body, same hole
//   · agentRamp.drift.test.ts:23     `indexOf(`${selector} {`)` — still matches
//                                    `.foo .bar {` when asked for `.bar {`
//   · scrollChaining.drift.test.ts:46 `rules()`, the only one that keeps full
//                                    selectors, and even it computes no subject
//
// THE DECOY IS THE POINT OF THIS FILE. A parser is easy; a parser that stays
// parsed through the next red merge is not. The synthesis of the measuring
// workflow named this as the single thing most likely to go wrong: after two
// stylesheet cards merge, the shared guard goes red on a rule neither card
// intended, and the fastest green is to soften the subject match back to a
// substring. It will not look like a regression. It will look like tidying a
// fussy test. So the decoy below fails LOUDLY for exactly that softening.

import { describe, expect, it } from "vitest";
import { blockOf, rules, subjectOf } from "./source";

describe("subjectOf: the element a rule is ABOUT", () => {
  it("takes the last compound of a descendant selector", () => {
    expect(subjectOf(".foo .bar")).toBe(".bar");
    expect(subjectOf(".a .b .c")).toBe(".c");
  });

  it("leaves an unscoped selector alone", () => {
    expect(subjectOf(".bar")).toBe(".bar");
  });

  it("handles every combinator, not just the space", () => {
    // A child, sibling or adjacent combinator scopes exactly as a space does.
    // A parser that split on /\s+/ alone would return ">" for the first.
    expect(subjectOf(".foo > .bar")).toBe(".bar");
    expect(subjectOf(".foo + .bar")).toBe(".bar");
    expect(subjectOf(".foo ~ .bar")).toBe(".bar");
    expect(subjectOf(".foo>.bar")).toBe(".bar");
  });

  it("keeps a compound whole", () => {
    expect(subjectOf(".foo .bar.baz")).toBe(".bar.baz");
    expect(subjectOf("section.dock-panel[data-panel='files']")).toBe(
      "section.dock-panel[data-panel='files']",
    );
  });
});

describe("rules: every selector/body pair, with its full selector", () => {
  it("splits a selector list, so each subject is reachable", () => {
    const parsed = rules("x.css", ".a, .foo .b { color: red }");
    expect(parsed).toHaveLength(2);
    expect(parsed.map((r) => r.selector)).toEqual([".a", ".foo .b"]);
    expect(parsed.map((r) => r.subject)).toEqual([".a", ".b"]);
  });

  it("finds the inner rule of an at-rule, not the prelude", () => {
    const parsed = rules("x.css", "@media (min-width: 900px) { .a { color: red } }");
    expect(parsed.map((r) => r.subject)).toEqual([".a"]);
  });

  it("is not fooled by a selector inside a comment", () => {
    // blankBlockComments already exists in this testkit for card 320's reason;
    // the parser uses it rather than growing its own stripper.
    const parsed = rules("x.css", "/* .ghost { width: 1px } */ .real { width: 2px }");
    expect(parsed.map((r) => r.subject)).toEqual([".real"]);
  });

  it("carries a line number that points at the rule", () => {
    const parsed = rules("x.css", "\n\n.a { color: red }");
    expect(parsed[0].line).toBe(3);
  });
});

describe("blockOf: the UNSCOPED rule, and the decoy that proves it", () => {
  const CSS = `
    .foo .right-panel { width: 1px }
    .right-panel { width: 2px }
    .right-panel--wide .right-panel { width: 3px }
  `;

  it("⚠️ THE DECOY: resolves to the unscoped rule, never a scoped one", () => {
    // THIS IS THE ASSERTION THE CARD EXISTS FOR. Every substring locator in the
    // tree today returns `width: 1px` here — the FIRST textual match, which is
    // the scoped decoy. Soften the subject match back to a substring and this
    // line goes red, loudly, with the wrong width in the message.
    expect(blockOf(CSS, ".right-panel")).toContain("width: 2px");
    expect(blockOf(CSS, ".right-panel")).not.toContain("width: 1px");
    expect(blockOf(CSS, ".right-panel")).not.toContain("width: 3px");
  });

  it("refuses a subject that exists only under an ancestor", () => {
    // The other direction. A locator that fell back to "any rule with this
    // subject" would silently hand back the scoped body and read as a pass.
    expect(() => blockOf(".wrap .only-scoped { color: red }", ".only-scoped")).toThrow(/unscoped/i);
  });

  it("refuses a subject that is not in the sheet at all", () => {
    expect(() => blockOf(".a { color: red }", ".missing")).toThrow(/\.missing/);
  });

  it("refuses an AMBIGUOUS subject rather than picking one", () => {
    // Two unscoped rules for one subject is a real shape (a base rule plus an
    // override). Picking the first silently is how a guard ends up asserting
    // against a value the browser does not use.
    expect(() => blockOf(".a { color: red } .a { color: blue }", ".a")).toThrow(/twice|ambiguous|2/i);
  });
});
