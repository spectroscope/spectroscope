// Card 306: what the box SAYS, and what its switch does.
//
// The box takes the run's own card off the map, so everything that card said
// has to be readable here: what the run is called, how far through its phases
// it got, how many agents stand in it, and how it is doing. The phase bands
// are drawn as bands — separated, in order — because the owner asked for the
// flow with its stages visible, not a bag of agents.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkflowBoxNode } from "./nodes";
import { BOX_HEADER_H, boxSwitchKey, toggleBox } from "./workflowBox";
import { dict } from "../../i18n/i18n";

const BANDS = [
  { title: "survey", detail: "look around", unplaced: false, y: 60, h: 180, count: 1 },
  { title: "fan out", detail: null, unplaced: false, y: 252, h: 180, count: 5 },
  { title: "fold", detail: null, unplaced: false, y: 444, h: 74, count: 0 },
];

const DATA = {
  boxId: "wfbox-wf1",
  title: "board sweep",
  phasesTotal: 3,
  phasesEntered: 2,
  agents: 6,
  state: "working",
  stateLabel: "working",
  stateColor: "var(--accent)",
  expanded: false,
  bands: BANDS,
  onToggle: undefined as ((boxId: string) => void) | undefined,
  w: 1200,
  h: 540,
};

const html = (over: Partial<typeof DATA> = {}): string =>
  renderToStaticMarkup(<WorkflowBoxNode {...({ data: { ...DATA, ...over } } as any)} />);

describe("the workflow box", () => {
  it("names the run", () => {
    expect(html()).toContain("board sweep");
  });

  it("says how far through its phases the run got, and how many agents stand in it", () => {
    const out = html();
    expect(out).toContain("2/3");
    expect(out).toContain("6");
  });

  it("says how the run is doing, in words and not only in colour", () => {
    expect(html()).toContain("working");
  });

  it("draws one band per phase, in the declared order", () => {
    const out = html();
    expect(out.indexOf("survey")).toBeLessThan(out.indexOf("fan out"));
    expect(out.indexOf("fan out")).toBeLessThan(out.indexOf("fold"));
  });

  it("seats each band at the y the geometry gave it, so the bands cannot drift", () => {
    const out = html();
    for (const b of BANDS) expect(out).toContain(`top:${b.y - BOX_HEADER_H}px`);
  });

  it("says a phase the run never entered is empty, rather than looking broken", () => {
    expect(html()).toContain(dict["map.wf.empty"].en);
  });

  it("carries the column's own detail where the strip cut it", () => {
    expect(html()).toContain("look around");
  });

  it("offers the switch when a handler is there, and says which way it goes", () => {
    // The words ON the button, not only in its tooltip: a switch whose label
    // lives in a `title` is a switch nobody can read without hovering it.
    expect(html({ onToggle: () => {} })).toContain(`>${dict["map.wf.expand"].en}</button>`);
    expect(html({ onToggle: () => {}, expanded: true })).toContain(`>${dict["map.wf.collapse"].en}</button>`);
  });

  it("offers no switch at all when nothing can answer it", () => {
    expect(html()).not.toContain(dict["map.wf.expand"].en);
  });

  it("puts the box's OWN id on the switch — that is what makes it per box", () => {
    expect(html({ onToggle: () => {} })).toContain('data-box="wfbox-wf1"');
  });
});

describe("the switch itself, as a fold", () => {
  it("throws a box that was not thrown", () => {
    expect([...toggleBox(new Set(), "a")]).toEqual(["a"]);
  });

  it("throws it back when it is thrown again", () => {
    expect([...toggleBox(new Set(["a"]), "a")]).toEqual([]);
  });

  it("leaves its neighbours alone — five boxes, five switches", () => {
    expect([...toggleBox(new Set(["a", "b"]), "c")].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not mutate the set it was given", () => {
    const before = new Set(["a"]);
    toggleBox(before, "b");
    expect([...before]).toEqual(["a"]);
  });

  it("spells a set the same way however it was built, so the layout key cannot lie", () => {
    expect(boxSwitchKey(new Set(["b", "a"]))).toBe(boxSwitchKey(new Set(["a", "b"])));
    expect(boxSwitchKey(new Set(["a"]))).not.toBe(boxSwitchKey(new Set(["b"])));
  });
});
