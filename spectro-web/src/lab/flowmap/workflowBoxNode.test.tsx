// Card 306: what the box SAYS, and what its switch does.
//
// The box takes the run's own card off the map, so everything that card said
// has to be readable here: what the run is called, how far through its phases
// it got, how many agents stand in it, and how it is doing. The phase bands
// are drawn as bands — separated, in order — because the owner asked for the
// flow with its stages visible, not a bag of agents.

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The box carries the same eight connection points every other card does
// (card 306, after the running map dropped every rail into it), and a real
// `Handle` wants the canvas store no server render has. Stubbed exactly the
// way `nodeCards.test.tsx` stubs it: these pins are about OUR markup. What the
// handles themselves have to be is pinned in `workflowBoxHandles.test.tsx`.
vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { WorkflowBoxNode } from "./WorkflowBoxNode";
import { BOX_PAD, boxSwitchKey, toggleBox, workflowBoxLayout } from "./workflowBox";
import type { PhaseMember, RunPhases } from "../workflowGraph";
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

// ---------------------------------------------------------------------------
// THE ONE CLAIM THE WHOLE CARD RESTS ON: "its agents stand IN it, lined up
// ALONG the phases". Nothing pinned it.
//
// What stood here was `expect(out).toContain(`top:${b.y - BOX_HEADER_H}px`)` —
// the source expression copied into the assertion, green for any header value
// and green for the wrong containing block, which is what it was. Measured in
// the running app: bands at 15/199/383/567/751 in box-local px with their own
// members at 90/274/458/642/826, so every card was printed 46px into the NEXT
// phase's title and the last 59px of the box carried no band at all.
//
// So the pin compares RECTANGLES: the band the geometry drew, against the
// members the same geometry seated in it. Both are box-local — a member is a
// React Flow child of the box, and the band's `top` is measured from the
// frame, which the CSS pin below is what makes true.
// ---------------------------------------------------------------------------
const memberOf = (agentId: string): PhaseMember => ({
  agentId,
  label: agentId,
  model: null,
  state: "done",
  startedAt: 1,
  endedAt: 2,
});

const RUN: RunPhases = {
  phases: [
    { title: "survey", detail: "look around", members: [memberOf("a1")] },
    { title: "fan out", detail: null, members: [memberOf("b1"), memberOf("b2")] },
    { title: "fold", detail: null, members: [] },
  ],
  unplaced: [memberOf("stray")],
};

describe("every agent stands inside its own phase band", () => {
  const layout = workflowBoxLayout(RUN, { expanded: false, present: null, unplacedTitle: "unplaced" });
  const drawn = (): { top: number; h: number }[] => {
    const out = renderToStaticMarkup(
      <WorkflowBoxNode
        {...({
          data: {
            ...DATA,
            w: layout.w,
            h: layout.h,
            bands: layout.bands.map((b) => ({
              title: b.title,
              detail: b.detail,
              unplaced: b.unplaced,
              y: b.y,
              h: b.h,
              count: b.members.length,
            })),
          },
        } as any)}
      />,
    );
    return [...out.matchAll(/style="top:(-?[\d.]+)px;height:(-?[\d.]+)px"/g)].map((m) => ({
      top: Number(m[1]),
      h: Number(m[2]),
    }));
  };

  it("draws one band rectangle per phase, in order", () => {
    expect(drawn()).toHaveLength(layout.bands.length);
  });

  it("draws each band AROUND the members the geometry seated in it", () => {
    const rects = drawn();
    layout.bands.forEach((band, i) => {
      const rect = rects[i];
      for (const m of band.members) {
        expect(m.y, `${band.title}/${m.agentId} top`).toBeGreaterThanOrEqual(rect.top);
        expect(m.y + m.h, `${band.title}/${m.agentId} bottom`).toBeLessThanOrEqual(rect.top + rect.h);
      }
    });
  });

  it("keeps every band clear of the header, and of the band before it", () => {
    const rects = drawn();
    expect(rects[0].top).toBeGreaterThanOrEqual(layout.headerH);
    for (let i = 1; i < rects.length; i++) {
      expect(rects[i].top, `band ${i}`).toBeGreaterThanOrEqual(rects[i - 1].top + rects[i - 1].h);
    }
  });

  it("leaves no band-less strip at the foot of the box", () => {
    const rects = drawn();
    const last = rects[rects.length - 1];
    expect(layout.h - (last.top + last.h)).toBeLessThanOrEqual(BOX_PAD);
  });

  // The frame of reference the three pins above are measured in, held in the
  // CSS itself: a band's `top` counts from `.pf-wfbox`'s own top-left — the
  // same origin a child node's position counts from — and nothing between the
  // two may be positioned, or the numbers would silently mean something else.
  it("measures a band's top from the frame, which is what the members' y is measured from", () => {
    const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");
    const block = (sel: string): string => {
      const at = css.indexOf(`${sel} {`);
      expect(at, sel).toBeGreaterThan(-1);
      return css.slice(at, css.indexOf("}", at));
    };
    expect(block(".pf-wfbox")).toContain("position: relative");
    expect(block(".pf-wfband")).toContain("position: absolute");
    // Static, so it displaces nothing: the header's height is already inside
    // the geometry's numbers and must not be applied a second time by CSS.
    expect(block(".pf-wfbox__head")).not.toContain("position:");
  });
});
