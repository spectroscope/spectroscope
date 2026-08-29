// Card 303, defect A — the half the truncation owed back.
//
// The caption is cut at its column's pitch, and what gets cut FIRST is the
// detail: measured in a browser on the shipped `Declared workflow` scenario at
// the fit zoom the lens opens on, four of five captions were already clipped
// (scrollWidth 208/186/215/215 against a 180 box), and the words lost were
// "decide what to look at", "one picture out of five", "every claim, on its
// own". The phase box under the caption carried `title · state` and nothing
// else, so those words had nowhere left to be read.
//
// The recovery path is the box's own tooltip rather than one on the caption:
// the overlay is `pointer-events: none` by card 293 — it swallowed pans and
// node clicks near the graph origin — and a 180x14 strip that takes the
// pointer back is a strip the reader can no longer grab to drag the canvas.
// The box's heading is already a hover target, already carries the title, and
// sits directly under the words it completes — see the measured note beside
// the two pins below for which band of the box answers, and which does not.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

vi.mock("@xyflow/react", () => ({
  ReactFlow: ({
    children,
    nodes,
    nodeTypes,
  }: {
    children?: ReactNode;
    nodes?: { id: string; type: string; data: unknown }[];
    nodeTypes?: Record<string, (p: { data: unknown; id: string }) => ReactNode>;
  }) => (
    <div>
      {(nodes ?? []).map((n) => (
        <div key={n.id}>{nodeTypes?.[n.type]?.({ data: n.data, id: n.id })}</div>
      ))}
      {children}
    </div>
  ),
  Background: () => null,
  Controls: () => null,
  ViewportPortal: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Handle: () => null,
  Position: { Left: "left", Right: "right", Top: "top", Bottom: "bottom" },
  useReactFlow: () => ({ fitView: () => {} }),
}));

import type { RunEvent } from "../../events";
import { WorkflowLens } from "./WorkflowLens";
import { WorkflowNode, type WfData } from "./WorkflowNode";
import { advanceScene, initialScene } from "../labScene";
import type { WorkflowDeclaration } from "../workflowGraph";

const data = (over: Partial<WfData> = {}): WfData => ({
  label: "scope",
  agentType: null,
  model: null,
  state: "done",
  stateLabel: "done",
  phase: true,
  detail: null,
  members: [],
  w: 132,
  h: 46,
  ...over,
});

const render = (d: WfData) =>
  renderToStaticMarkup(
    <WorkflowNode
      data={d}
      id="x"
      type="wfNode"
      dragging={false}
      zIndex={0}
      isConnectable={false}
      positionAbsoluteX={0}
      positionAbsoluteY={0}
      selectable={false}
      deletable={false}
      draggable={false}
      selected={false}
    />,
  );

describe("the box gives the cut caption somewhere to be read", () => {
  it("carries the column's detail in its own tooltip", () => {
    expect(render(data({ detail: "decide what to look at" }))).toContain(
      'title="scope · done\ndecide what to look at"',
    );
  });

  it("stays the two-part tooltip when the column stated no detail", () => {
    const html = render(data({ detail: null }));
    expect(html).toContain('title="scope · done"');
    // No dangling separator and no empty second line for a column that said
    // nothing — the bite that tells "carries the detail" from "always appends".
    expect(html).not.toContain("scope · done\n");
  });

  // WHICH PART OF THE BOX ANSWERS, measured rather than assumed. A `title`
  // resolves to the NEAREST ancestor carrying one, and every member row of a
  // phase box carries its own — so over a member row the reader gets that
  // agent's two words, not the column's. Measured on the shipped `Declared
  // workflow` scenario by walking elementFromPoint over each box: the phase's
  // own tooltip answers on 74% of a one-member box and 40% of a five-member
  // one, and in both cases the whole heading band — the ten rows under the box
  // top, directly beneath the caption whose words they complete. "Hover the
  // box" would be the loose version of that sentence; these two pin the exact
  // one, and they are separate because they can fail apart.
  const withMember = (over: Partial<WfData> = {}) =>
    data({
      members: [{ agentId: "a", label: "one", model: null, state: "done", stateLabel: "done" }],
      ...over,
    });

  it("leaves the heading band to the box, with nothing titled in between", () => {
    const html = render(withMember({ detail: "decide what to look at" }));
    const open = /<div class="wf-node wf-node--phase[^>]*>/.exec(html);
    expect(open, "the phase box must render").not.toBeNull();
    const label = html.indexOf('<span class="wf-node-label">');
    expect(label).toBeGreaterThan(-1);
    expect(html.slice(open!.index + open![0].length, label)).not.toContain("title=");
  });

  it("lets a member row shadow it, which is why the band above is load-bearing", () => {
    // Not a defect — an agent's own state is the right answer over its own
    // row. It is the reason the claim is about the heading and not the box.
    expect(render(withMember())).toContain('<li class="wf-agent wf-agent--done" title="one · done">');
  });

  it("gives a plain agent card the same recovery, so the rule is one rule", () => {
    // A caption only ever survives over a column of declared boxes, so this
    // is defence rather than a shipped case — but a card that silently
    // dropped a detail it was handed would be the same defect again.
    expect(render(data({ phase: false, detail: "the words of a column" }))).toContain(
      '\nthe words of a column"',
    );
  });
});

describe("the lens hands each box the detail of the column it stands in", () => {
  const EVENTS: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    { type: "agent_spawn", agentId: "one", parentId: "main", task: "scope the pass", ts: 20 },
    { type: "text_delta", agentId: "one", text: "…", ts: 90 },
    { type: "agent_spawn", agentId: "two", parentId: "main", task: "probe the panel", ts: 30 },
    { type: "text_delta", agentId: "two", text: "…", ts: 95 },
  ];
  const member = (agentId: string) => ({
    agentId,
    label: "",
    model: null,
    state: "pending" as const,
    startedAt: null,
    endedAt: null,
  });
  const decl = (scopeDetail: string | null): WorkflowDeclaration =>
    new Map([
      [
        "main",
        {
          phases: [
            { title: "scope", detail: scopeDetail, members: [member("one")] },
            { title: "probe", detail: null, members: [member("two")] },
          ],
          unplaced: [],
        },
      ],
    ]);
  const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());
  const html = (d: WorkflowDeclaration) =>
    renderToStaticMarkup(<WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} declared={d} />);

  it("reaches the box from the caption, not from the phase title alone", () => {
    expect(html(decl("decide what to look at"))).toContain('\ndecide what to look at"');
  });

  it("leaves the neighbouring column's box alone — one detail per column", () => {
    const drawn = html(decl("decide what to look at"));
    expect(drawn.match(/decide what to look at/g) ?? []).toHaveLength(2); // caption + one box
  });

  it("adds nothing when the declaration itself stated no detail", () => {
    expect(html(decl(null))).not.toMatch(/title="[^"]*\n/);
  });
});
