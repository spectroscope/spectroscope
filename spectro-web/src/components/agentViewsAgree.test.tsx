// Card 593: one selection, three views. The popover, the Plan panel and the
// System context panel render from the same resolved choice and name the same agent.
import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo } from "../state/reducer";
import { initialState } from "../state/reducer";
import {
  __resetShownAgentForTests,
  figuresOf,
  setShownAgent,
  shownAgentOf,
  useShownAgent,
} from "../state/shownAgent";
import { ContextPopover } from "./ContextRing";
import { contextGauge, ringFrame } from "./contextRingMath";
import { PlanTab } from "./PlanTab";
import { SystemContextTab } from "./SystemContextTab";

afterEach(() => __resetShownAgentForTests());

const row = (id: string, parentId: string | null): AgentInfo => ({
  id,
  parentId,
  label: null,
  task: "",
  state: "working",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
});
const state = {
  ...initialState,
  rootAgentId: "main",
  agents: [row("main", null), row("explore-1", "main")],
  lastInputTokens: 100,
};

/** What App does once per render: read the store by the view key, resolve, hand the same choice to every view. */
function Views({ viewKey }: { viewKey: string }) {
  const shown = shownAgentOf(state, useShownAgent(viewKey));
  const picker = { agents: state.agents, shown, onPick: () => {} };
  const figures = figuresOf(state, shown);
  const frame = ringFrame(figures.context, figures.announcedWindow);
  const gauge = contextGauge(frame.threshold, frame.contextWindow, frame.thresholdSource);
  return (
    <>
      <section id="popover">
        <ContextPopover
          lastInputTokens={figures.lastInputTokens}
          context={figures.context}
          frame={frame}
          gauge={gauge}
          shownPct={0}
          onWindowOverride={undefined}
          aiCredits={null}
          picker={picker}
        />
      </section>
      <section id="plan">
        <PlanTab
          plans={{}}
          shown={shown}
          agents={state.agents}
          onPickAgent={() => {}}
          runs={[]}
          live={false}
          wide={false}
          onToggleWide={() => {}}
          onJump={() => {}}
          onOpenPath={() => {}}
        />
      </section>
      <section id="context">
        <SystemContextTab
          selected={shown.row}
          shown={shown}
          agents={state.agents}
          onPickAgent={() => {}}
          thinking={false}
        />
      </section>
    </>
  );
}

const views = (viewKey: string): string[] =>
  renderToStaticMarkup(<Views viewKey={viewKey} />)
    .split("<section")
    .slice(1);

it("the three views name the picked helper, once each, and another record still shows the root", () => {
  setShownAgent("live:k", "explore-1");
  const picked = views("live:k");
  expect(picked).toHaveLength(3);
  for (const html of picked) expect(html.split("Showing: explore-1").length - 1).toBe(1);
  for (const html of views("live:other")) expect(html.split("Showing: Main agent").length - 1).toBe(1);
});
