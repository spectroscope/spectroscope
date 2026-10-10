// Card 483: every editor action is one pure command from a document to a
// document. Each case asserts the whole nodes and arrows arrays, so that a
// command that moves anything it should not move goes red.

import { describe, expect, it } from "vitest";
import { apply, NEW_NAMES, type Command } from "./commands";
import type { DocArrow, DocDecision, DocNode, DocStep, PlaybookDoc, Selection } from "./doc";

function step(id: string, extra: Partial<DocStep> = {}): DocStep {
  return {
    kind: "step",
    id,
    name: id,
    performer: "chat",
    skills: [],
    privacy: "cheap",
    permission: "inherit",
    consumes: [],
    produces: [],
    nod: false,
    ...extra,
  };
}

const IMPLEMENT = step("implement", { consumes: ["spec"], produces: ["code"] });
const REVIEW: DocDecision = {
  kind: "decision",
  id: "review_task",
  name: "Review",
  check: "task_review",
  outcomes: ["pass", "fail"],
  max_rounds: 5,
};
const FIX = step("fix", { consumes: ["code"], produces: ["code"] });
const FINISH = step("finish");
const DONE: DocNode = { kind: "end", id: "done", result: "done" };
const CANCELLED: DocNode = { kind: "end", id: "cancelled", result: "cancelled" };

const A_IMPL: DocArrow = { from: "implement", to: "review_task" };
const A_PASS: DocArrow = { from: "review_task", to: "finish", on: "pass" };
const A_FAIL: DocArrow = { from: "review_task", to: "fix", on: "fail" };
const A_EXH: DocArrow = { from: "review_task", to: "cancelled", on: "exhausted" };
const A_FIX: DocArrow = { from: "fix", to: "review_task" };
const A_FINISH: DocArrow = { from: "finish", to: "done" };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

const CHAIN: PlaybookDoc = deepFreeze({
  schema_version: 1,
  id: "chain",
  name: "Chain",
  description: "Implement, review, fix until it passes.",
  models: { judge: { primary: { provider: "anthropic", model: "m" }, fallbacks: [] } },
  documents: {
    spec: { name: "Spec", purpose: "What to build", location: "docs/spec.md", sections: ["Goal"] },
    code: { name: "Code", purpose: "What was built", location: "src", sections: [] },
  },
  checks: {
    task_review: { kind: "review", model: "judge", reads: ["code"], labels: ["pass", "fail"] },
    code_sections: { kind: "sections", documents: ["code"], forbid: ["TODO"] },
  },
  vars: {},
  start: "implement",
  nodes: [IMPLEMENT, REVIEW, FIX, FINISH, DONE, CANCELLED],
  arrows: [A_IMPL, A_PASS, A_FAIL, A_EXH, A_FIX, A_FINISH],
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
});

function run(doc: PlaybookDoc, selection: Selection, ...cmds: Command[]) {
  let d = doc;
  let s = selection;
  for (const cmd of cmds) {
    const r = apply(d, s, cmd);
    expect(r.refused).toBeNull();
    d = r.doc;
    s = r.selection;
  }
  return { doc: d, selection: s };
}

const NEW_DECISION: DocDecision = { kind: "decision", id: "decision_1", name: NEW_NAMES.decision, check: "" };

describe("the card scenario", () => {
  it("adds a review round after implement with one node and three arrows", () => {
    const sel: Selection = { kind: "node", id: "implement" };
    const { doc, selection } = run(
      CHAIN,
      sel,
      { kind: "add", nodeKind: "decision", after: sel },
      { kind: "editDecision", id: "decision_1", patch: { check: "task_review", max_rounds: 3 } },
      { kind: "connect", from: "decision_1", on: "fail", to: "implement" },
      { kind: "connect", from: "decision_1", on: "exhausted", to: "cancelled" },
    );
    expect(doc.nodes).toEqual([
      IMPLEMENT,
      { ...NEW_DECISION, check: "task_review", max_rounds: 3 },
      REVIEW,
      FIX,
      FINISH,
      DONE,
      CANCELLED,
    ]);
    expect(doc.arrows).toEqual([
      { from: "implement", to: "decision_1" },
      { from: "decision_1", to: "review_task", on: "pass" },
      { from: "decision_1", to: "implement", on: "fail" },
      { from: "decision_1", to: "cancelled", on: "exhausted" },
      A_PASS,
      A_FAIL,
      A_EXH,
      A_FIX,
      A_FINISH,
    ]);
    expect(doc.start).toBe("implement");
    expect(doc.checks).toBe(CHAIN.checks);
    expect(doc.documents).toBe(CHAIN.documents);
    expect(selection).toEqual({ kind: "node", id: "decision_1" });
  });
});

describe("add", () => {
  it("puts a new step on a selected arrow and points the step at the old target", () => {
    const sel: Selection = { kind: "arrow", key: "review_task|fail" };
    const { doc, selection } = run(CHAIN, sel, { kind: "add", nodeKind: "step", after: sel });
    expect(doc.nodes).toEqual([
      IMPLEMENT,
      REVIEW,
      { ...step("step_1"), name: NEW_NAMES.step },
      FIX,
      FINISH,
      DONE,
      CANCELLED,
    ]);
    expect(doc.arrows).toEqual([
      A_IMPL,
      A_PASS,
      { from: "review_task", to: "step_1", on: "fail" },
      A_EXH,
      { from: "step_1", to: "fix" },
      A_FIX,
      A_FINISH,
    ]);
    expect(selection).toEqual({ kind: "node", id: "step_1" });
  });

  it("gives a new decision a decision's free outcome", () => {
    const freed = run(CHAIN, null, { kind: "deleteArrow", key: "review_task|fail" }).doc;
    const sel: Selection = { kind: "node", id: "review_task" };
    const { doc } = run(freed, sel, { kind: "add", nodeKind: "decision", after: sel });
    expect(doc.nodes).toEqual([IMPLEMENT, REVIEW, NEW_DECISION, FIX, FINISH, DONE, CANCELLED]);
    expect(doc.arrows).toEqual([
      A_IMPL,
      A_PASS,
      A_EXH,
      { from: "review_task", to: "decision_1", on: "fail" },
      A_FIX,
      A_FINISH,
    ]);
  });

  it("leaves a new decision unconnected after a decision with no free outcome", () => {
    const sel: Selection = { kind: "node", id: "review_task" };
    const { doc } = run(CHAIN, sel, { kind: "add", nodeKind: "decision", after: sel });
    expect(doc.nodes).toEqual([IMPLEMENT, REVIEW, NEW_DECISION, FIX, FINISH, DONE, CANCELLED]);
    expect(doc.arrows).toEqual(CHAIN.arrows);
  });

  it("puts a new end on a step's arrow without an arrow out of the end", () => {
    const sel: Selection = { kind: "node", id: "finish" };
    const { doc } = run(CHAIN, sel, { kind: "add", nodeKind: "end", after: sel });
    expect(doc.nodes).toEqual([
      IMPLEMENT,
      REVIEW,
      FIX,
      FINISH,
      { kind: "end", id: "end_1", result: "done" },
      DONE,
      CANCELLED,
    ]);
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_FAIL, A_EXH, A_FIX, { from: "finish", to: "end_1" }]);
  });

  it("appends an unconnected node with nothing selected", () => {
    const { doc } = run(CHAIN, null, { kind: "add", nodeKind: "step", after: null });
    expect(doc.nodes).toEqual([...CHAIN.nodes, { ...step("step_1"), name: NEW_NAMES.step }]);
    expect(doc.arrows).toEqual(CHAIN.arrows);
  });

  it("takes the smallest free number for a new id", () => {
    const gapped: PlaybookDoc = { ...CHAIN, nodes: [...CHAIN.nodes, step("step_1"), step("step_3")] };
    const { doc } = run(gapped, null, { kind: "add", nodeKind: "step", after: null });
    expect(doc.nodes.map((n) => n.id)).toEqual([...gapped.nodes.map((n) => n.id), "step_2"]);
  });
});

describe("connect", () => {
  it("retargets the arrow that already carries the outcome, in place", () => {
    const { doc } = run(CHAIN, null, { kind: "connect", from: "review_task", on: "fail", to: "implement" });
    expect(doc.nodes).toEqual(CHAIN.nodes);
    expect(doc.arrows).toEqual([
      A_IMPL,
      A_PASS,
      { from: "review_task", to: "implement", on: "fail" },
      A_EXH,
      A_FIX,
      A_FINISH,
    ]);
  });

  it("retargets a step's unlabelled arrow when on is null", () => {
    const { doc } = run(CHAIN, null, { kind: "connect", from: "fix", on: null, to: "implement" });
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_FAIL, A_EXH, { from: "fix", to: "implement" }, A_FINISH]);
  });

  it("adds an arrow after the last arrow from the same node", () => {
    const freed = run(CHAIN, null, { kind: "deleteArrow", key: "review_task|fail" }).doc;
    const { doc } = run(freed, null, { kind: "connect", from: "review_task", on: "fail", to: "implement" });
    expect(doc.arrows).toEqual([
      A_IMPL,
      A_PASS,
      A_EXH,
      { from: "review_task", to: "implement", on: "fail" },
      A_FIX,
      A_FINISH,
    ]);
  });

  it("appends an arrow from a node that has none", () => {
    const freed = run(CHAIN, null, { kind: "deleteArrow", key: "fix|" }).doc;
    const { doc } = run(freed, null, { kind: "connect", from: "fix", on: null, to: "implement" });
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_FAIL, A_EXH, A_FINISH, { from: "fix", to: "implement" }]);
  });
});

describe("delete", () => {
  it("removes a node with every arrow from or to it", () => {
    const sel: Selection = { kind: "node", id: "fix" };
    const { doc, selection } = run(CHAIN, sel, { kind: "deleteNode", id: "fix" });
    expect(doc.nodes).toEqual([IMPLEMENT, REVIEW, FINISH, DONE, CANCELLED]);
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_EXH, A_FINISH]);
    expect(selection).toBeNull();
  });

  it("removes one arrow by its key", () => {
    const { doc } = run(CHAIN, null, { kind: "deleteArrow", key: "review_task|exhausted" });
    expect(doc.nodes).toEqual(CHAIN.nodes);
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_FAIL, A_FIX, A_FINISH]);
  });
});

describe("renameNode", () => {
  it("carries start and every arrow that named the node", () => {
    const sel: Selection = { kind: "arrow", key: "implement|" };
    const { doc, selection } = run(CHAIN, sel, { kind: "renameNode", from: "implement", to: "build" });
    expect(doc.start).toBe("build");
    expect(doc.nodes).toEqual([{ ...IMPLEMENT, id: "build" }, REVIEW, FIX, FINISH, DONE, CANCELLED]);
    expect(doc.arrows).toEqual([
      { from: "build", to: "review_task" },
      A_PASS,
      A_FAIL,
      A_EXH,
      A_FIX,
      A_FINISH,
    ]);
    expect(selection).toEqual({ kind: "arrow", key: "build|" });
  });

  it("carries arrows that point at the node", () => {
    const { doc } = run(CHAIN, null, { kind: "renameNode", from: "review_task", to: "review" });
    expect(doc.arrows).toEqual([
      { from: "implement", to: "review" },
      { from: "review", to: "finish", on: "pass" },
      { from: "review", to: "fix", on: "fail" },
      { from: "review", to: "cancelled", on: "exhausted" },
      { from: "fix", to: "review" },
      A_FINISH,
    ]);
  });

  it("refuses an id that exists and returns the same document", () => {
    const r = apply(CHAIN, null, { kind: "renameNode", from: "implement", to: "finish" });
    expect(r.refused).toBe("pbe.renameTaken");
    expect(r.doc).toBe(CHAIN);
  });
});

describe("outcomes", () => {
  it("renames an outcome and carries its arrow", () => {
    const sel: Selection = { kind: "arrow", key: "review_task|fail" };
    const { doc, selection } = run(CHAIN, sel, {
      kind: "renameOutcome",
      id: "review_task",
      from: "fail",
      to: "rework",
    });
    expect(doc.nodes).toEqual([
      IMPLEMENT,
      { ...REVIEW, outcomes: ["pass", "rework"] },
      FIX,
      FINISH,
      DONE,
      CANCELLED,
    ]);
    expect(doc.arrows).toEqual([
      A_IMPL,
      A_PASS,
      { from: "review_task", to: "fix", on: "rework" },
      A_EXH,
      A_FIX,
      A_FINISH,
    ]);
    expect(selection).toEqual({ kind: "arrow", key: "review_task|rework" });
  });

  it("removes an outcome and its arrow", () => {
    const { doc } = run(CHAIN, null, { kind: "removeOutcome", id: "review_task", outcome: "fail" });
    expect(doc.nodes).toEqual([IMPLEMENT, { ...REVIEW, outcomes: ["pass"] }, FIX, FINISH, DONE, CANCELLED]);
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, A_EXH, A_FIX, A_FINISH]);
  });

  it("adds an outcome and refuses one that exists", () => {
    const { doc } = run(CHAIN, null, { kind: "addOutcome", id: "review_task", outcome: "skip" });
    expect(doc.nodes[1]).toEqual({ ...REVIEW, outcomes: ["pass", "fail", "skip"] });
    const r = apply(CHAIN, null, { kind: "addOutcome", id: "review_task", outcome: "fail" });
    expect(r.refused).toBe("pbe.renameTaken");
    expect(r.doc).toBe(CHAIN);
  });

  it("sets an arrow's outcome and moves the selected key with it", () => {
    const freed = run(CHAIN, null, { kind: "deleteArrow", key: "review_task|fail" }).doc;
    const sel: Selection = { kind: "arrow", key: "review_task|exhausted" };
    const { doc, selection } = run(freed, sel, {
      kind: "setOutcome",
      key: "review_task|exhausted",
      on: "fail",
    });
    expect(doc.arrows).toEqual([A_IMPL, A_PASS, { ...A_EXH, on: "fail" }, A_FIX, A_FINISH]);
    expect(selection).toEqual({ kind: "arrow", key: "review_task|fail" });
  });
});

describe("documents and checks", () => {
  it("carries consumes, produces, check documents and check reads on a document rename", () => {
    const { doc } = run(CHAIN, null, { kind: "renameDocument", from: "code", to: "source" });
    expect(Object.keys(doc.documents)).toEqual(["spec", "source"]);
    expect(doc.documents.source).toBe(CHAIN.documents.code);
    expect(doc.nodes).toEqual([
      { ...IMPLEMENT, produces: ["source"] },
      REVIEW,
      { ...FIX, consumes: ["source"], produces: ["source"] },
      FINISH,
      DONE,
      CANCELLED,
    ]);
    expect(doc.checks).toEqual({
      task_review: { kind: "review", model: "judge", reads: ["source"], labels: ["pass", "fail"] },
      code_sections: { kind: "sections", documents: ["source"], forbid: ["TODO"] },
    });
    expect(doc.arrows).toEqual(CHAIN.arrows);
  });

  it("leaves the references when a document is deleted", () => {
    const { doc } = run(CHAIN, null, { kind: "deleteDocument", id: "code" });
    expect(Object.keys(doc.documents)).toEqual(["spec"]);
    expect(doc.nodes).toEqual(CHAIN.nodes);
    expect(doc.checks).toEqual(CHAIN.checks);
  });

  it("refuses a document rename onto a name that exists", () => {
    const r = apply(CHAIN, null, { kind: "renameDocument", from: "code", to: "spec" });
    expect(r.refused).toBe("pbe.renameTaken");
    expect(r.doc).toBe(CHAIN);
  });

  it("drops the fields a new check kind does not use", () => {
    const { doc } = run(CHAIN, null, {
      kind: "putCheck",
      id: "task_review",
      value: { ...CHAIN.checks.task_review, kind: "command", run: "make test" },
    });
    expect(doc.checks).toEqual({
      task_review: { kind: "command", run: "make test" },
      code_sections: CHAIN.checks.code_sections,
    });
    expect(Object.keys(doc.checks)).toEqual(["task_review", "code_sections"]);
  });

  it("keeps every field when the kind does not change", () => {
    const value = { ...CHAIN.checks.task_review, labels: ["ok", "redo"] };
    const { doc } = run(CHAIN, null, { kind: "putCheck", id: "task_review", value });
    expect(doc.checks.task_review).toEqual(value);
  });

  it("carries every decision's check on a check rename and keeps the map order", () => {
    const { doc } = run(CHAIN, null, { kind: "renameCheck", from: "task_review", to: "code_review" });
    expect(Object.keys(doc.checks)).toEqual(["code_review", "code_sections"]);
    expect(doc.nodes).toEqual([IMPLEMENT, { ...REVIEW, check: "code_review" }, FIX, FINISH, DONE, CANCELLED]);
  });

  it("leaves the decision's check when a check is deleted", () => {
    const { doc } = run(CHAIN, null, { kind: "deleteCheck", id: "task_review" });
    expect(Object.keys(doc.checks)).toEqual(["code_sections"]);
    expect(doc.nodes).toEqual(CHAIN.nodes);
  });

  it("adds a new document at the end of the map", () => {
    const value = { name: "Plan", purpose: "Tasks", location: "docs/plan.md", sections: [] };
    const { doc } = run(CHAIN, null, { kind: "putDocument", id: "plan", value });
    expect(Object.keys(doc.documents)).toEqual(["spec", "code", "plan"]);
    expect(doc.documents.plan).toEqual(value);
  });
});

describe("node fields", () => {
  it("edits a step and removes a field set to undefined", () => {
    const withGoal = run(CHAIN, null, {
      kind: "editStep",
      id: "fix",
      patch: { goal: "Fix it", nod: true },
    }).doc;
    expect(withGoal.nodes[2]).toEqual({ ...FIX, goal: "Fix it", nod: true });
    const { doc } = run(withGoal, null, { kind: "editStep", id: "fix", patch: { goal: undefined } });
    expect(doc.nodes[2]).toEqual({ ...FIX, nod: true });
    expect("goal" in doc.nodes[2]).toBe(false);
  });

  it("edits an end's result and sets the start", () => {
    const { doc } = run(
      CHAIN,
      null,
      { kind: "editEnd", id: "cancelled", result: "abandoned" },
      { kind: "setStart", id: "fix" },
    );
    expect(doc.nodes[5]).toEqual({ kind: "end", id: "cancelled", result: "abandoned" });
    expect(doc.start).toBe("fix");
  });
});

describe("a command with nothing to do", () => {
  // The history skips a command only when the document object is the same,
  // and the panels commit on blur, so an unchanged commit must not be a step.
  function unchanged(cmd: Command) {
    const r = apply(CHAIN, null, cmd);
    expect(r.refused).toBeNull();
    expect(r.doc).toBe(CHAIN);
  }

  it("returns the same document for a step patch that changes nothing", () => {
    unchanged({ kind: "editStep", id: "fix", patch: { name: "fix", nod: false, consumes: ["code"] } });
    unchanged({ kind: "editStep", id: "fix", patch: { goal: undefined } });
  });

  it("returns the same document for a decision patch that changes nothing", () => {
    unchanged({ kind: "editDecision", id: "review_task", patch: { check: "task_review", max_rounds: 5 } });
  });

  it("returns the same document for an end's unchanged result", () => {
    unchanged({ kind: "editEnd", id: "cancelled", result: "cancelled" });
  });

  it("returns the same document for the current start", () => {
    unchanged({ kind: "setStart", id: "implement" });
  });

  it("returns the same document for a document type put back unchanged", () => {
    const { sections, location, purpose, name } = CHAIN.documents.spec;
    unchanged({
      kind: "putDocument",
      id: "spec",
      value: { sections: [...sections], location, purpose, name },
    });
  });

  it("returns the same document for a check put back unchanged", () => {
    unchanged({
      kind: "putCheck",
      id: "task_review",
      value: { ...CHAIN.checks.task_review, labels: ["pass", "fail"] },
    });
  });
});

describe("refusals", () => {
  it("refuses an outcome another arrow of the node already carries", () => {
    const r = apply(CHAIN, null, { kind: "setOutcome", key: "review_task|fail", on: "pass" });
    expect(r.refused).toBe("pbe.outcomeTaken");
    expect(r.doc).toBe(CHAIN);
  });

  it("refuses an outcome rename onto a derived outcome", () => {
    const r = apply(CHAIN, null, { kind: "renameOutcome", id: "review_task", from: "fail", to: "exhausted" });
    expect(r.refused).toBe("pbe.renameTaken");
    expect(r.doc).toBe(CHAIN);
  });
});

describe("purity", () => {
  it("never mutates its input", () => {
    const cmds: Command[] = [
      { kind: "add", nodeKind: "step", after: { kind: "node", id: "implement" } },
      { kind: "add", nodeKind: "decision", after: { kind: "arrow", key: "review_task|fail" } },
      { kind: "add", nodeKind: "end", after: null },
      { kind: "connect", from: "review_task", on: "fail", to: "implement" },
      { kind: "connect", from: "implement", on: "x", to: "fix" },
      { kind: "setOutcome", key: "review_task|fail", on: "maybe" },
      { kind: "deleteNode", id: "fix" },
      { kind: "deleteArrow", key: "implement|" },
      { kind: "setStart", id: "fix" },
      { kind: "renameNode", from: "implement", to: "build" },
      { kind: "editStep", id: "implement", patch: { skills: ["a"] } },
      { kind: "editDecision", id: "review_task", patch: { max_rounds: undefined } },
      { kind: "editEnd", id: "done", result: "x" },
      { kind: "addOutcome", id: "review_task", outcome: "skip" },
      { kind: "renameOutcome", id: "review_task", from: "pass", to: "ok" },
      { kind: "removeOutcome", id: "review_task", outcome: "pass" },
      { kind: "putDocument", id: "code", value: { name: "C", purpose: "p", location: "l", sections: ["s"] } },
      { kind: "renameDocument", from: "code", to: "source" },
      { kind: "deleteDocument", id: "spec" },
      { kind: "putCheck", id: "task_review", value: { kind: "human", ask: "?" } },
      { kind: "renameCheck", from: "task_review", to: "t" },
      { kind: "deleteCheck", id: "code_sections" },
    ];
    const snapshot = JSON.stringify(CHAIN);
    for (const cmd of cmds) {
      expect(() => apply(CHAIN, { kind: "node", id: "implement" }, cmd)).not.toThrow();
    }
    expect(JSON.stringify(CHAIN)).toBe(snapshot);
  });
});
