// Card 482: a playbook run writes its plan under the agent id "playbook". A
// chat step that ends while later steps are still open is not an unfinished
// chat run, so the footer and the export grade such a session as having no
// plan; the playbook pane grades the playbook run itself.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { runStatusLine } from "../components/UsageFooter";
import { PLAYBOOK_AGENT, gradedPlan, planVerdict } from "./planVerdict";
import { initialState, reduceAll } from "./reducer";

const planBy = (agentId: string): RunEvent => ({
  type: "plan",
  agentId,
  steps: [{ text: "[build] Build", status: "pending" }],
  ts: 1100,
});

describe("the plan a playbook writes", () => {
  it("does not grade a playbook's plan as an unfinished chat run", () => {
    const plan = [{ text: "[build] Build", status: "pending" }];
    expect(planVerdict("end_turn", gradedPlan(plan, PLAYBOOK_AGENT))).toBe("unknown");
    expect(planVerdict("end_turn", gradedPlan(plan, "main"))).toBe("unfinished");
  });

  it("keeps the agent of the latest plan in the state", () => {
    expect(initialState.planAgent).toBeNull();
    expect(reduceAll(initialState, [planBy("main")]).planAgent).toBe("main");
    expect(reduceAll(initialState, [planBy("main"), planBy(PLAYBOOK_AGENT)]).planAgent).toBe(PLAYBOOK_AGENT);
  });

  it("lets the footer call a chat step that ended between playbook steps ready without a plan", () => {
    const after = (agentId: string) =>
      reduceAll(initialState, [
        planBy(agentId),
        { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 2000 },
      ]);
    expect(runStatusLine(after(PLAYBOOK_AGENT), "en").key).toBe("footer.readyNoPlan");
    expect(runStatusLine(after("main"), "en").key).toBe("footer.stoppedUnfinished");
  });
});
