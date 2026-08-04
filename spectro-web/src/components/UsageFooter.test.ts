// House test style: pure logic only, no DOM/testing-library (the repo has none).
//
// Card 167, finding 1. The session total used to mean "what the main agent
// spent", because a subagent's tokens never became a frame. It now means "what
// the session spent", and the two numbers are far apart: measured over the 230
// completed Agent launches in ~/.claude/projects, the children carry 842,802
// output tokens their parents' totals never showed. A total that changes
// meaning without saying so is the thing to avoid, so the footer says when
// subagents are in it — and says nothing at all when none are.

import { describe, expect, it } from "vitest";
import { runShare, subagentShare } from "./UsageFooter";
import type { AgentInfo } from "../state/reducer";

const agent = (p: Partial<AgentInfo> & { id: string }): AgentInfo => ({
  parentId: null,
  label: null,
  task: "",
  state: "completed",
  lastStatus: null,
  inTokens: 0,
  outTokens: 0,
  ...p,
});

describe("subagentShare", () => {
  it("says nothing about a session that never spawned anything", () => {
    expect(subagentShare([agent({ id: "main", inTokens: 900, outTokens: 100 })])).toBeNull();
  });

  it("says nothing about a subagent whose tokens the file never recorded", () => {
    // Every transcript written before the launch record carried a usage object,
    // and every live spawn before its first usage frame. A "incl. 0 subagents"
    // chip would claim a breakdown that does not exist.
    expect(
      subagentShare([agent({ id: "main", outTokens: 100 }), agent({ id: "t1", parentId: "main" })]),
    ).toBeNull();
  });

  it("counts only the children that actually contributed", () => {
    expect(
      subagentShare([
        agent({ id: "main", inTokens: 900, outTokens: 100 }),
        agent({ id: "t1", parentId: "main", inTokens: 2, outTokens: 2779 }),
        agent({ id: "t2", parentId: "main", inTokens: 5, outTokens: 11 }),
        agent({ id: "t3", parentId: "main" }),
      ]),
    ).toEqual({ count: 2, inTokens: 7, outTokens: 2790 });
  });

  it("counts a nested child too — it is in the total the same way", () => {
    expect(
      subagentShare([
        agent({ id: "main", outTokens: 100 }),
        agent({ id: "t1", parentId: "main", outTokens: 10 }),
        agent({ id: "t2", parentId: "t1", outTokens: 5 }),
      ])?.count,
    ).toBe(2);
  });
});

// The same disclosure on the other figure. The run total counts a child's
// tokens exactly the way the session total does, and said nothing about it.
describe("runShare", () => {
  it("says nothing about a run that spent everything itself", () => {
    expect(runShare({ ids: [], inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("says nothing when the children that billed billed nothing", () => {
    expect(runShare({ ids: ["t1"], inputTokens: 0, outputTokens: 0 })).toBeNull();
  });

  it("counts the agents in the run figure, not their responses", () => {
    // t1 billed twice; it is one subagent.
    expect(runShare({ ids: ["t1", "t2"], inputTokens: 10, outputTokens: 2811 })).toEqual({
      count: 2,
      inTokens: 10,
      outTokens: 2811,
    });
  });
});
