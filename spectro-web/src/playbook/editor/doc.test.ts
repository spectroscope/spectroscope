// Card 483: the web twin of PlaybookValidator.outcomesOf, which the editor uses
// to draw one handle per outcome, and the key that names an arrow.

import { describe, expect, it } from "vitest";
import { arrowKey, outcomesOf, type DocDecision, type DocEnd, type DocStep, type PlaybookDoc } from "./doc";

const STEP: DocStep = {
  kind: "step",
  id: "write",
  name: "Write",
  performer: "chat",
  skills: [],
  privacy: "cheap",
  permission: "inherit",
  consumes: [],
  produces: [],
  nod: false,
};
const END: DocEnd = { kind: "end", id: "done", result: "done" };

function docWith(...decisions: DocDecision[]): PlaybookDoc {
  return {
    schema_version: 1,
    id: "p",
    name: "P",
    description: "d",
    models: {},
    documents: {},
    checks: {
      ask_owner: { kind: "human", ask: "Which way?", labels: ["left", "right"] },
      judge_it: { kind: "review", model: "judge", labels: ["good", "bad"] },
      bare_review: { kind: "review", model: "judge" },
      run_tests: { kind: "command", run: "make test", labels: ["ignored"] },
    },
    vars: {},
    start: "write",
    nodes: [STEP, ...decisions, END],
    arrows: [],
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  };
}

function decision(check: string, extra: Partial<DocDecision> = {}): DocDecision {
  return { kind: "decision", id: "d", name: "D", check, ...extra };
}

describe("outcomesOf", () => {
  it("gives a step its one unlabelled outcome", () => {
    expect(outcomesOf(docWith(), STEP)).toEqual([""]);
  });

  it("gives an end no outcome", () => {
    expect(outcomesOf(docWith(), END)).toEqual([]);
  });

  it("takes a decision's declared outcomes before its check", () => {
    const d = decision("ask_owner", { outcomes: ["yes", "no", "later"] });
    expect(outcomesOf(docWith(d), d)).toEqual(["yes", "no", "later"]);
    const capped = { ...d, max_rounds: 2 };
    expect(outcomesOf(docWith(capped), capped)).toEqual(["yes", "no", "later", "exhausted"]);
  });

  it("takes a human check's labels when none are declared", () => {
    const d = decision("ask_owner");
    expect(outcomesOf(docWith(d), d)).toEqual(["left", "right"]);
    const capped = decision("ask_owner", { max_rounds: 3 });
    expect(outcomesOf(docWith(capped), capped)).toEqual(["left", "right", "exhausted"]);
  });

  it("takes a review check's labels when none are declared", () => {
    const d = decision("judge_it");
    expect(outcomesOf(docWith(d), d)).toEqual(["good", "bad"]);
  });

  it("falls back to pass and fail for an unknown check", () => {
    const d = decision("no_such_check");
    expect(outcomesOf(docWith(d), d)).toEqual(["pass", "fail"]);
    const capped = decision("no_such_check", { max_rounds: 1 });
    expect(outcomesOf(docWith(capped), capped)).toEqual(["pass", "fail", "exhausted"]);
  });

  it("falls back to pass and fail for a review without labels and for a command check", () => {
    const bare = decision("bare_review");
    expect(outcomesOf(docWith(bare), bare)).toEqual(["pass", "fail"]);
    const command = decision("run_tests");
    expect(outcomesOf(docWith(command), command)).toEqual(["pass", "fail"]);
  });

  it("treats an empty declared list as none declared", () => {
    const d = decision("ask_owner", { outcomes: [] });
    expect(outcomesOf(docWith(d), d)).toEqual(["left", "right"]);
  });

  it("adds exhausted for a max_rounds of zero, as the Java rule does", () => {
    const d = decision("no_such_check", { max_rounds: 0 });
    expect(outcomesOf(docWith(d), d)).toEqual(["pass", "fail", "exhausted"]);
  });
});

describe("arrowKey", () => {
  it("names a labelled arrow by its source and outcome", () => {
    expect(arrowKey({ from: "review", to: "fix", on: "fail" })).toBe("review|fail");
  });

  it("names an unlabelled arrow by its source and an empty outcome", () => {
    expect(arrowKey({ from: "write", to: "review" })).toBe("write|");
  });
});
