// House test style: pure logic only, no DOM (the repo has none). The belt is
// the agent hub's one always-visible statement about what the agent can do, so
// what it lists — and what it refuses to claim — is logic, not decoration.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { agentBelt, launchScript, LAUNCH_SCRIPT_NOTE, LAUNCH_CHIPS, TOOL_CHIPS } from "./belt";
import { toolCategory } from "../../components/TraceView";

const names = (activeTool: string | null) => agentBelt(activeTool).map((c) => c.name);
const lit = (activeTool: string | null) =>
  agentBelt(activeTool)
    .filter((c) => c.on)
    .map((c) => c.name);

describe("the agent hub's chip belt (card 146)", () => {
  // Measured over ~/.claude/projects on 2026-08-11 by parsing tool_use blocks:
  // 409 Workflow and 86 Monitor across 109 of 5695 transcripts. The belt listed
  // seven names and none of them was either one, so the map's one standing
  // statement about the agent's reach had nothing to say about the launch that
  // fans a session across a dozen agents.
  //
  // The count that stood here said "408 lines containing `"name":"Workflow"`",
  // which is a grep of lines and not a count of calls.
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

// Measured over ~/.claude/projects on 2026-08-11 by running THIS module's
// reader across every launch in the corpus: 495 launches, 358 of them a
// Workflow with the script inline (all 358 declare phases), 45 Workflow
// by-path, 6 Workflow by-name — and 86 Monitor. So 137 launches get an empty
// phase list, and the split inside that 137 is the whole point: only 51 are
// the by-name/by-path case. The other 86 are Monitors, which carry a shell
// `command` and no script field of any kind. describeTool routes Monitor into
// the Bash/command case (toolViews.ts:1295), so its view is never `workflow`
// and the empty list arrives by a different road entirely.
describe("what an empty phase list MEANS (card 146)", () => {
  const script = [
    "export const meta = {",
    '  name: "review-diff",',
    '  phases: ["scan", "verify", "report"],',
    "};",
  ].join("\n");

  it("reads the phases off the script, in the order the script wrote them", () => {
    expect(launchScript({ name: "Workflow", input: { script } })).toEqual({
      state: "declared",
      phases: ["scan", "verify", "report"],
    });
  });

  it("a script that exists but not in this call is `elsewhere`", () => {
    expect(launchScript({ name: "Workflow", input: { name: "review-diff" } }).state).toBe("elsewhere");
    expect(launchScript({ name: "Workflow", input: { scriptPath: "/w/x.ts" } }).state).toBe("elsewhere");
  });

  // The 86. A Monitor waits on a shell loop; there is no script to be missing,
  // so telling the reader it is "not in this call" sends them looking for a
  // file that was never written.
  it("a Monitor has no script to be missing", () => {
    expect(
      launchScript({ name: "Monitor", input: { command: "until grep -q done f; do sleep 5; done" } }).state,
    ).toBe("scriptless");
  });

  // Zero in the corpus today, reachable by writing a workflow without a
  // `phases:` header. The script IS here; it just declares nothing.
  it("a script that is here and declares nothing is `silent`, not missing", () => {
    expect(
      launchScript({ name: "Workflow", input: { script: 'export const meta = { name: "x" };' } }).state,
    ).toBe("silent");
  });

  it("says `unknown` rather than guessing when no call is in view", () => {
    expect(launchScript(null).state).toBe("unknown");
    expect(launchScript({ name: "run_command", input: { command: "ls" } }).state).toBe("unknown");
  });

  it("gives every non-declared state its own sentence, and no two the same", () => {
    const notes = Object.values(LAUNCH_SCRIPT_NOTE);
    expect(notes.every((n) => n.length > 0)).toBe(true);
    expect(new Set(notes).size).toBe(notes.length);
  });
});

describe("the note reaches the render, not just the map", () => {
  // A refuter reintroduced the defect this card fixed — nodes.tsx going back to
  // one hardcoded sentence for every non-declared state — and vitest, tsc and
  // eslint ALL stayed green. tsc only catches the sloppy variant that leaves an
  // orphan import; a clean reintroduction is invisible to every gate the card
  // cited. So the wiring is asserted here, by reading the file: the render must
  // look the note up per state rather than spell one out.
  const nodes = readFileSync(new URL("./nodes.tsx", import.meta.url).pathname, "utf8");

  it("looks the note up by state instead of hardcoding one sentence", () => {
    expect(nodes).toContain("LAUNCH_SCRIPT_NOTE[script.state]");
  });

  it("does not spell any note out at the render site", () => {
    // Each note lives in exactly one place. A copy in the JSX is the drift that
    // made three states share one wrong sentence in the first place.
    for (const note of Object.values(LAUNCH_SCRIPT_NOTE)) {
      expect(nodes, note).not.toContain(note);
    }
  });
});
