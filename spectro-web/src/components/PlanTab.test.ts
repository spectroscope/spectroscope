// House test style: no DOM/testing-library (the repo has none). The pure
// status→label mapping is tested as a function; card 586 renders the tab on
// React's server renderer to pin that a session without a run shows the plan
// as before, and that a run takes the tab with the model's plan under it.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import type { PlanStep } from "../state/reducer";
import { foldRun, type RunTrack } from "../state/runView";
import { drive } from "../testkit/driveComponent";
import { PlanTab, statusLabel } from "./PlanTab";
import { RunPanel } from "./RunPanel";
import { AgentPicker } from "./AgentPicker";
import { shownAgentOf } from "../state/shownAgent";

describe("PlanTab statusLabel", () => {
  it("translates the three wire statuses to English labels (the default)", () => {
    expect(statusLabel("pending")).toBe("open");
    expect(statusLabel("in_progress")).toBe("running …");
    expect(statusLabel("completed")).toBe("done");
  });

  it("translates to German when the chrome language is de", () => {
    expect(statusLabel("pending", "de")).toBe("offen");
    expect(statusLabel("in_progress", "de")).toBe("läuft …");
    expect(statusLabel("completed", "de")).toBe("fertig");
  });

  it("passes unknown statuses through unchanged (forward compatibility)", () => {
    expect(statusLabel("blocked")).toBe("blocked");
    expect(statusLabel("blocked", "de")).toBe("blocked");
  });
});

const PLAN: PlanStep[] = [
  { text: "read the spec", status: "completed" },
  { text: "write the code", status: "in_progress" },
  { text: "ship it", status: "pending" },
];

/** The markup PlanTab rendered for PLAN before card 586, captured from that code. */
const PLAN_MARKUP =
  '<ul class="agents-list" aria-label="Plan">' +
  '<li><div class="agent-card agent-card--completed"><span class="agent-card-head"><span class="agent-dot agent-dot--completed" aria-hidden="true"></span><span class="agent-badge agent-badge--completed">done</span></span><span class="agent-card-task">read the spec</span></div></li>' +
  '<li><div class="agent-card agent-card--in_progress"><span class="agent-card-head"><span class="agent-dot agent-dot--in_progress" aria-hidden="true"></span><span class="agent-badge agent-badge--in_progress">running …</span></span><span class="agent-card-task">write the code</span></div></li>' +
  '<li><div class="agent-card agent-card--pending"><span class="agent-card-head"><span class="agent-dot agent-dot--pending" aria-hidden="true"></span><span class="agent-badge agent-badge--pending">open</span></span><span class="agent-card-task">ship it</span></div></li>' +
  "</ul>";

const RUNS: RunTrack[] = [
  {
    type: "run_step",
    agentId: "playbook",
    runId: "r1",
    runKind: "playbook",
    phase: "run_start",
    name: "spectro",
    nodes: [{ id: "a", name: "A", kind: "step" }],
    ts: 1,
  },
  {
    type: "run_step",
    agentId: "playbook",
    runId: "r1",
    runKind: "playbook",
    phase: "step_start",
    node: "a",
    name: "A",
    kind: "step",
    entry: 1,
    performer: "chat",
    ts: 2,
  },
].reduce((runs, e) => foldRun(runs, e as unknown as RunEvent), [] as RunTrack[]);

/** Card 593: the selection the tab needs, the root of an empty roster shown. */
const SHOWN = shownAgentOf({ rootAgentId: "main", agents: [] }, null);
const BASE = { plans: {}, shown: SHOWN, agents: [], onPickAgent: () => {} };
/** The picker that heads the plan since card 593; closed, so its markup is fixed. */
const PICKER = renderToStaticMarkup(
  createElement(AgentPicker, { agents: [], shown: SHOWN, onPick: () => {} }),
);

const render = (props: Record<string, unknown>): string =>
  renderToStaticMarkup(createElement(PlanTab, { ...BASE, ...props } as Parameters<typeof PlanTab>[0]));

describe("PlanTab with and without a run (card 586)", () => {
  it("renders the plan exactly as before, under the picker, while the session has no run", () => {
    expect(PICKER).toMatch(/^<div class="agent-pick">.*<\/div>$/);
    expect(render({ plans: { main: PLAN } })).toBe(PICKER + PLAN_MARKUP);
    expect(render({ plans: { main: PLAN }, runs: [] })).toBe(PICKER + PLAN_MARKUP);
    expect(render({ plans: { playbook: PLAN }, runs: [] })).toBe(PICKER + PLAN_MARKUP);
    expect(render({ plans: {}, runs: [] }).startsWith(PICKER + '<p class="agents-empty">No plan yet.')).toBe(
      true,
    );
  });

  it("renders the run, and the model's plan under it with its heading", () => {
    const out = render({ plans: { main: PLAN }, runs: RUNS });
    expect(out).toContain("Run: spectro");
    expect(out).toContain('<h3 class="run-model-plan">Plan of the model</h3>');
    expect(out.indexOf("Run: spectro")).toBeLessThan(out.indexOf("Plan of the model"));
    expect(out).toContain(PLAN_MARKUP);
  });

  it("leaves out the plan the playbook runner wrote, and an empty plan", () => {
    for (const props of [
      { plans: { playbook: PLAN }, runs: RUNS },
      { plans: { main: [] }, runs: RUNS },
      { plans: {}, runs: RUNS },
    ]) {
      const out = render(props);
      expect(out).toContain("Run: spectro");
      expect(out).not.toContain("Plan of the model");
      expect(out).not.toContain("agents-list");
      expect(out).not.toContain("No plan yet");
    }
  });
});

describe("a run picked in one session does not carry over to another (card 586)", () => {
  // React keeps a component's state while its type and key stay the same and
  // starts it fresh when the key changes. RunPanel holds the operator's pick
  // in its own state, so the tab keys it by the session: another session is
  // another key, and its panel opens on its newest run. There is no DOM here
  // to watch a remount; the key the tab hands React is what is pinned.
  const keyOf = (sessionId: string | null): string | null => {
    const tree = drive(
      createElement(PlanTab, { ...BASE, plans: {}, runs: RUNS, sessionId } as Parameters<typeof PlanTab>[0]),
      [PlanTab],
      [() => {}],
    );
    const panels = tree.filter((el) => el.type === RunPanel);
    expect(panels).toHaveLength(1);
    return panels[0].key;
  };

  it("keys the run panel by the shown session", () => {
    expect(keyOf("20261013-090000-aaaa")).toBe("20261013-090000-aaaa");
    expect(keyOf("20261013-090000-bbbb")).toBe("20261013-090000-bbbb");
    expect(keyOf("20261013-090000-aaaa")).not.toBe(keyOf("20261013-090000-bbbb"));
  });

  it("keys it by the empty string before the session has an id", () => {
    expect(keyOf(null)).toBe("");
  });
});
