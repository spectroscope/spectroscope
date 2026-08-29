// Card 302: what a phase box SHOWS. The phase is the node, so the fan-out has
// to be readable inside it — "survey holds five" — with each agent's label,
// its state and its model, the way the workflow panel lists a run's phase.
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// This mock RENDERS THE NODES, unlike the lens's other suites, which only
// needed the overlay. Without that, "the agents are inside the phase box"
// could only be pinned on the card in isolation, and the lens would be free
// to hand it nothing at all.
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
import { WorkflowLens, WorkflowNode } from "./WorkflowLens";
import { advanceScene, initialScene } from "../labScene";
import { t } from "../../i18n/i18n";
import { currentLang } from "../../state/lang";
import type { WorkflowDeclaration } from "../workflowGraph";
import type { WfData } from "./WorkflowNode";

const data = (over: Partial<WfData> = {}): WfData => ({
  label: "survey",
  agentType: null,
  model: null,
  state: "active",
  stateLabel: "running",
  phase: true,
  members: [],
  w: 132,
  h: 90,
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

describe("a phase box", () => {
  it("lists every agent it holds, with label and model", () => {
    const html = render(
      data({
        members: [
          { agentId: "p1", label: "probe the panel", model: "some-model", state: "done", stateLabel: "done" },
          {
            agentId: "p2",
            label: "probe the profile",
            model: "some-model",
            state: "active",
            stateLabel: "running",
          },
        ],
      }),
    );
    expect(html).toContain("probe the panel");
    expect(html).toContain("probe the profile");
    expect(html).toContain("some-model");
  });

  it("says each agent's own state, so five rows are not one colour", () => {
    const html = render(
      data({
        members: [
          { agentId: "p1", label: "one", model: null, state: "done", stateLabel: "done" },
          { agentId: "p2", label: "two", model: null, state: "failed", stateLabel: "failed" },
        ],
      }),
    );
    expect(html).toContain("wf-agent--done");
    expect(html).toContain("wf-agent--failed");
  });

  it("stays a plain card for a node that is not a phase", () => {
    const html = render(data({ phase: false, agentType: "app-scout", model: "some-model" }));
    expect(html).not.toContain("wf-agents");
    expect(html).toContain("app-scout");
  });

  it("draws an empty declared phase as a box with nothing in it", () => {
    const html = render(data({ state: "pending", stateLabel: "pending", members: [] }));
    expect(html).toContain("wf-node--pending");
    expect(html).not.toContain("wf-agent ");
  });
});

describe("the assembled lens draws the phases, not the agents", () => {
  const EVENTS: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    { type: "agent_spawn", agentId: "one", parentId: "main", task: "scope the pass", ts: 20 },
    { type: "text_delta", agentId: "one", text: "…", ts: 90 },
    { type: "agent_spawn", agentId: "two", parentId: "main", task: "probe the panel", ts: 30 },
    { type: "text_delta", agentId: "two", text: "…", ts: 95 },
  ];
  const DECL: WorkflowDeclaration = new Map([
    [
      "main",
      {
        phases: [
          {
            title: "scope",
            detail: null,
            members: [
              {
                agentId: "one",
                label: "",
                model: null,
                state: "pending" as const,
                startedAt: null,
                endedAt: null,
              },
            ],
          },
          {
            title: "probe",
            detail: null,
            members: [
              {
                agentId: "two",
                label: "",
                model: null,
                state: "pending" as const,
                startedAt: null,
                endedAt: null,
              },
            ],
          },
        ],
        unplaced: [],
      },
    ],
  ]);
  const scene = EVENTS.reduce((s, e) => advanceScene(s, e), initialScene());

  it("puts each agent's task inside the phase box that holds it", () => {
    const html = renderToStaticMarkup(
      <WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} declared={DECL} />,
    );
    expect(html).toContain("wf-agents");
    expect(html).toContain("scope the pass");
    expect(html).toContain("probe the panel");
    // Two phase boxes and the root — the two agents are rows, not boxes.
    expect((html.match(/class="wf-node /g) ?? []).length).toBe(3);
  });

  it("names the picture it drew, in the viewer's language", () => {
    const html = renderToStaticMarkup(
      <WorkflowLens events={EVENTS} applied={EVENTS} scene={scene} declared={DECL} />,
    );
    expect(html).toContain(t(currentLang(), "lab.lens.sourceDeclared"));
  });
});

describe("the box for agents the file could not place", () => {
  const EV: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "go", ts: 0 },
    { type: "agent_spawn", agentId: "one", parentId: "main", task: "scope the pass", ts: 20 },
    { type: "text_delta", agentId: "one", text: "…", ts: 90 },
  ];
  const STRAY: WorkflowDeclaration = new Map([
    [
      "main",
      {
        phases: [{ title: "scope", detail: null, members: [] }],
        unplaced: [
          { agentId: "one", label: "", model: null, state: "done" as const, startedAt: 1, endedAt: 2 },
        ],
      },
    ],
  ]);

  it("is named rather than left blank — a box with no heading says nothing at all", () => {
    const scene = EV.reduce((s, e) => advanceScene(s, e), initialScene());
    const html = renderToStaticMarkup(
      <WorkflowLens events={EV} applied={EV} scene={scene} declared={STRAY} />,
    );
    expect(html).toContain(t(currentLang(), "lab.lens.unplaced"));
  });
});
