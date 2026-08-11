// House test style: pure logic only, no DOM (the repo has none). The belt is
// the agent hub's one always-visible statement about what the agent can do, so
// what it lists — and what it refuses to claim — is logic, not decoration.

import { describe, expect, it } from "vitest";
import { agentBelt, declaredPhases, LAUNCH_CHIPS, TOOL_CHIPS } from "./belt";
import { toolCategory } from "../../components/TraceView";

const names = (activeTool: string | null) => agentBelt(activeTool).map((c) => c.name);
const lit = (activeTool: string | null) =>
  agentBelt(activeTool)
    .filter((c) => c.on)
    .map((c) => c.name);

describe("the agent hub's chip belt (card 146)", () => {
  // Measured over ~/.claude/projects on 2026-08-11: 408 `"name":"Workflow"`
  // lines across 82 of 5686 transcripts, and 86 Monitor. The belt listed seven
  // names and none of them was either one, so the map's one standing statement
  // about the agent's reach had nothing to say about the launch that fans a
  // session across a dozen agents.
  it("lists the launch the corpus is full of", () => {
    expect(names(null)).toContain("Workflow");
  });

  it("keeps the seven the harness's own belt always had", () => {
    expect(names(null)).toEqual(expect.arrayContaining(TOOL_CHIPS));
  });

  it("marks a launch as a launch, not as another tool the agent runs itself", () => {
    const chip = agentBelt(null).find((c) => c.name === "Workflow");
    expect(chip?.kind).toBe("launch");
    expect(agentBelt(null).find((c) => c.name === "run_command")?.kind).toBe("tool");
  });

  it("lights the launch chip while the launch is in flight", () => {
    expect(lit("Workflow")).toEqual(["Workflow"]);
  });

  it("still lights an ordinary tool, and nothing else with it", () => {
    expect(lit("run_command")).toEqual(["run_command"]);
  });

  it("lights nothing when no tool is running", () => {
    expect(lit(null)).toEqual([]);
  });

  // One rule, two views. The trace already decided which names are background
  // launches and wrote down why both belong (TraceView BACKGROUND_TASK_TOOLS:
  // Monitor alone carried 17 of 196 launch receipts). A belt that answered a
  // second, narrower rule would draw a Monitor launch as an ordinary tool while
  // the trace beside it drew it as a workflow.
  it("agrees with the trace about what a launch is", () => {
    for (const name of LAUNCH_CHIPS) expect(toolCategory(name)).toBe("workflow");
    for (const name of TOOL_CHIPS) expect(toolCategory(name)).toBe("tool");
  });
});

describe("the phases a launch declares", () => {
  const script = [
    "export const meta = {",
    '  name: "review-diff",',
    '  phases: ["scan", "verify", "report"],',
    "};",
  ].join("\n");

  it("reads them off the script, in the order the script wrote them", () => {
    expect(declaredPhases({ name: "Workflow", input: { script } })).toEqual(["scan", "verify", "report"]);
  });

  // The honesty the whole card turns on. A workflow called by saved name or by
  // path is a reference to a script the map never sees; a phase list invented
  // for it would be the map describing content that is not there.
  it("says nothing when the script is elsewhere", () => {
    expect(declaredPhases({ name: "Workflow", input: { name: "review-diff" } })).toEqual([]);
  });

  it("says nothing for a tool that is not a launch", () => {
    expect(declaredPhases({ name: "run_command", input: { command: "ls" } })).toEqual([]);
  });

  it("says nothing when no tool is in flight", () => {
    expect(declaredPhases(null)).toEqual([]);
  });
});
