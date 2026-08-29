// Card 306: the box needs the same eight handles every other card has, and
// nothing in this repo would have said so.
//
// Measured in the running app, on the shipped scenario, before this file
// existed:
//
//   [React Flow]: Couldn't create edge for target handle id: "rt",
//   edge id: e-sub-scope-agent
//
// and the rendered edge list held no rail from any member to its box at all.
// A member's leg home targets the box on handle "rt" — the box IS the run that
// launched it — and React Flow drops an edge whose handle does not exist. It
// warns and carries on, so the map simply draws agents with no line home:
// exactly the floating cards card 295 was written to end, back again for every
// boxed agent.
//
// The seating suite already pins that the EDGE is emitted. That pin is over
// `sceneToFlow`'s output, which cannot see a handle — the rail was in the
// array and absent from the screen at the same time. So this is the other
// half, and it is over the component.

import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The canvas package needs its own store, which no server render has. Stubbed
// so the handle ids stay VISIBLE in the markup — the point of this file.
vi.mock("@xyflow/react", () => ({
  Handle: ({ id, type }: { id: string; type: string }) => <i data-h={`${type}:${id}`} />,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
}));

import { WorkflowBoxNode } from "./WorkflowBoxNode";
import { SubagentNode } from "./nodes";

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
  bands: [{ title: "survey", detail: null, unplaced: false, y: 60, h: 180, count: 1 }],
  w: 1200,
  h: 540,
};

const WORKER = {
  id: "a1",
  label: null,
  task: "look around",
  state: "working",
  stateLabel: "working",
  stateColor: "var(--warn)",
  lastStatus: null,
  focus: "agent",
  active: false,
  think: "",
  activity: { text: "idle", color: "var(--muted)" },
};

/** Every handle the markup carries, as "type:id", in document order. */
const handlesOf = (markup: string): string[] => [...markup.matchAll(/data-h="([^"]+)"/g)].map((m) => m[1]);

const boxMarkup = (): string => renderToStaticMarkup(<WorkflowBoxNode {...({ data: DATA } as any)} />);
const workerMarkup = (): string => renderToStaticMarkup(<SubagentNode {...({ data: WORKER } as any)} />);

describe("the box is a node the rails can reach", () => {
  it("carries the handle a member's leg home arrives on", () => {
    // sceneToFlow writes E(`e-sub-<id>-agent`, id, boxId, "ls", "rt"): the
    // member leaves on its left side and the box takes it on its right.
    expect(handlesOf(boxMarkup())).toContain("target:rt");
  });

  it("carries the same set a worker card does, so the box cannot drift from the map", () => {
    // What this bites is DIVERGENCE, and only that — measured: shrink the
    // shared set and both cards shrink together and this stays green. That is
    // the honest reading, because both take the set from one module. The set
    // itself is the next pin's job.
    expect([...handlesOf(boxMarkup())].sort()).toEqual([...handlesOf(workerMarkup())].sort());
  });

  it("offers each side as both source and target — the set itself, spelled out", () => {
    const got = handlesOf(boxMarkup()).sort();
    expect(got).toEqual(["l", "r", "t", "b"].flatMap((k) => [`source:${k}s`, `target:${k}t`]).sort());
  });
});
