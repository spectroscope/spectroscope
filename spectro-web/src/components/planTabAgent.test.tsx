// Card 593: the Plan panel names its agent, keeps the root's plan apart from a
// playbook's rows, and says that a helper keeps no plan.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentInfo, PlanStep } from "../state/reducer";
import type { RunTrack } from "../state/runView";
import { shownAgentOf } from "../state/shownAgent";
import { PlanTab, rootPlanRows } from "./PlanTab";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

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
const agents = [row("main", null), row("explore-1", "main")];
const state = { rootAgentId: "main", agents };
const steps: PlanStep[] = [
  { text: "read the files", status: "completed" },
  { text: "write the tool", status: "in_progress" },
];
const playbook: PlanStep[] = [{ text: "[a] Brainstorm", status: "pending" }];
const run: RunTrack = {
  runId: "abcdefabcdef",
  kind: "playbook",
  name: "spectro",
  task: null,
  nodes: [],
  startedTs: 1,
  endedTs: 2,
  durationMs: 1,
  stopReason: "done",
  result: "done",
  detail: null,
  waitingOn: null,
  entries: [],
};

const tab = (plans: Record<string, PlanStep[]>, id: string | null, runs: RunTrack[] = []): string =>
  renderToStaticMarkup(
    <PlanTab
      plans={plans}
      shown={shownAgentOf(state, id)}
      agents={agents}
      onPickAgent={() => {}}
      runs={runs}
      live={false}
      wide={false}
      onToggleWide={() => {}}
      onJump={() => {}}
      onOpenPath={() => {}}
    />,
  );

describe("rootPlanRows", () => {
  it("prefers the root's plan, falls back to the playbook's rows only without a run, else nothing", () => {
    expect(rootPlanRows({ main: steps, playbook }, "main", false)).toBe(steps);
    expect(rootPlanRows({ playbook }, "main", false)).toBe(playbook);
    expect(rootPlanRows({ playbook }, "main", true)).toBeNull();
    expect(rootPlanRows({}, "main", false)).toBeNull();
    expect(rootPlanRows({ "worker-3": steps }, "worker-3", false)).toBe(steps);
  });
});

describe("the Plan panel", () => {
  it("heads the root's plan with the picker and lists its steps", () => {
    const html = tab({ main: steps, playbook }, null);
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("write the tool");
    expect(html).not.toContain("Brainstorm");
  });

  it("shows the playbook's rows when the root has no plan and no run is on screen, as before", () => {
    expect(tab({ playbook }, null)).toContain("Brainstorm");
  });

  it("shows the empty text with the picker when nobody wrote a plan", () => {
    const html = tab({}, null);
    expect(html).toContain("Showing: Main agent");
    expect(html).toContain("No plan yet");
  });

  it("with a run draws the run panel first, then the picker and the model's plan under its heading", () => {
    const html = tab({ main: steps }, null, [run]);
    expect(html.indexOf("Run:")).toBeGreaterThan(-1);
    expect(html.indexOf("Run:")).toBeLessThan(html.indexOf("agent-pick"));
    expect(html).toContain("Plan of the model");
    expect(html).toContain("write the tool");
  });

  it("with a run and only a playbook plan draws no playbook rows and no heading", () => {
    const html = tab({ playbook }, null, [run]);
    expect(html).not.toContain("Brainstorm");
    expect(html).not.toContain("Plan of the model");
    expect(html).toContain("agent-pick");
  });

  it("says that a helper keeps no plan and lists nothing", () => {
    const html = tab({ main: steps }, "explore-1");
    expect(html).toContain("Showing: explore-1");
    expect(html).toContain(
      "explore-1 keeps no plan. Helpers work from their task; the main agent keeps the plan.",
    );
    expect(html).not.toContain("agents-list");
    expect(html).not.toContain("write the tool");
  });

  it("with a run says the same for a helper, under the run panel, and draws no model plan", () => {
    const html = tab({ main: steps }, "explore-1", [run]);
    expect(html.indexOf("Run:")).toBeLessThan(html.indexOf("explore-1 keeps no plan."));
    expect(html).not.toContain("Plan of the model");
    expect(html).not.toContain("write the tool");
  });

  it("speaks German", () => {
    setLang("de");
    expect(tab({ main: steps }, "explore-1")).toContain("explore-1 führt keinen Plan.");
  });
});
