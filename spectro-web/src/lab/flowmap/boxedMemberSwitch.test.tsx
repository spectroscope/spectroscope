// Card 306: inside a box, the box's switch is the switch.
//
// Measured in the running app, on the shipped scenario with the map expanded
// and one box thrown minimal:
//
//   the reserve per member  216 x 132   (BOX_MEMBER_H_COMPACT)
//   what the card rendered  216 x 227
//
// and the last band's row was 88px above where the box seated it, because
// React Flow's `extent: "parent"` CLAMPS a child that would stick out of its
// parent. So the audit row came to rest on top of the draft row, and every
// other row bled over its own band's floor. Nothing threw: a clamp is what
// `extent: "parent"` is FOR.
//
// The cause is not the constant. A minimal worker card renders 133 in a
// compact map — the constant is right — and 227 in an expanded one, because
// the card's own disclosure opens off `ExpandAllContext`, the MAP's switch.
// A boxed member has its own switch, and it was reading the wrong one: two
// switches disagreeing, with the geometry following one and the markup the
// other.

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

  it("stays shut inside a box the reader threw minimal, expanded map or not", () => {
    expect(open(markup(true, { boxExpanded: false }))).toBe(false);
    expect(open(markup(false, { boxExpanded: false }))).toBe(false);
  });
});
