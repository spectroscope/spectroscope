// Card 306: inside a box, the box's switch is the switch — and the one control
// that could outgrow a band is not drawn there at all.
//
// Measured in the running app, on the shipped scenario with the map expanded
// and one box thrown minimal:
//
//   the reserve per member  216 x 132        (BOX_MEMBER_H_COMPACT, as it was)
//   what the card rendered  216 x 227 .. 244  (it grows with its content)
//
// and the last band's row was 88px above where the box seated it. The first
// cut of this file said React Flow's `extent: "parent"` had put it back, and
// called that the reserve's safety net. Re-measured in Chrome at 141/188: it
// clamps POSITION and never SIZE, and it clamps to the BOX rather than to the
// band — so a member in band 1 that grows just stands on the row below it
// untouched, and the clamp only ever fires at the box's own floor, where it IS
// the damage. There is no net (workflowBox.test.ts carries the numbers).
//
// The first cause was two switches disagreeing: a boxed member's disclosure
// opened off `ExpandAllContext`, the MAP's switch, while its band was reserved
// off the box's. Handing the card its box's switch fixed the disagreement but
// not the reach — a reader can still click the thing. A band reserves a SHUT
// card, and an open body needs about 95px it does not have, so a boxed member
// draws no in-place disclosure at all. Its detail is one click away on the
// box's own switch, which redraws every member as the full instrument.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExpandAllContext } from "./expandContext";

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { SubagentNode } from "./nodes";

const CARD = {
  id: "a1",
  label: null,
  task: "look around",
  state: "working",
  stateLabel: "working",
  stateColor: "var(--warn)",
  lastStatus: "reading the panel",
  activity: { text: "idle", color: "var(--muted)" },
  focus: "agent",
  active: false,
  think: "",
};

const markup = (mapExpanded: boolean, over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(
    <ExpandAllContext.Provider value={mapExpanded}>
      <SubagentNode {...({ data: { ...CARD, ...over } } as any)} />
    </ExpandAllContext.Provider>,
  );

/** The disclosure body only exists in the markup while it is open. */
const open = (html: string): boolean => html.includes("pf-disc__body");

describe("a minimal worker card and the switch that opens it", () => {
  it("stays shut in a compact map — the shape the reserve was measured on", () => {
    expect(open(markup(false))).toBe(false);
  });

  it("opens with the map when the card is a loose one", () => {
    // Unchanged, and it has to be: a loose minimal card in an expanded map is
    // not a thing that happens (the map gives it the full instrument), but
    // nothing here may quietly redefine what the map-wide switch means.
    expect(open(markup(true))).toBe(true);
  });
});

// A band reserves a shut card. Nothing about `extent: "parent"` puts an opened
// one back — measured, see the header — so the reach is closed where it opens.
describe("a boxed member has no in-place disclosure to open", () => {
  it("draws no disclosure at all, not even the shut strip, on a boxed member", () => {
    expect(markup(false, { boxed: true })).not.toContain("pf-disc");
  });

  it("cannot be opened by the map's switch either — the case that first broke the band", () => {
    expect(markup(true, { boxed: true })).not.toContain("pf-disc");
  });

  it("leaves the loose minimal card the control it has always had", () => {
    // Bitten on its own: a change that simply stopped rendering the
    // disclosure for everybody would pass the two above and take a working
    // control off every card on the map.
    expect(markup(false)).toContain("pf-disc__btn");
  });
});

// The caps that make the band's reserve a BOUND only reach a card that says it
// is in a box, and the class is the only thing that says so. Without it every
// cap in flowmap.css misses and the reserve is back to being an observation
// about the thirteen cards somebody happened to measure.
describe("a boxed member says it is boxed, so the caps reach it", () => {
  it("carries the boxed class when the seating put it in a box", () => {
    expect(markup(false, { boxed: true })).toContain("pf-sub--boxed");
  });

  it("leaves a loose card exactly what it was", () => {
    expect(markup(false)).not.toContain("pf-sub--boxed");
  });

  it("keeps the active card's own class beside it, not instead of it", () => {
    const html = markup(false, { boxed: true, active: true });
    expect(html).toContain("pf-sub--boxed");
    expect(html).toContain("pf-card--active");
  });
});
