// Card 483, Task 10: the pure option lists behind the panels. The outcome
// rules are asserted against the document, never against a typed list.

import { describe, expect, it } from "vitest";
import { apply } from "./commands";
import { arrowKey, type PlaybookDoc } from "./doc";
import {
  CHECK_FIELDS,
  findingTarget,
  modelOptions,
  outcomeOptions,
  skillOptions,
  splitLines,
} from "./options";

const MINIMAL: PlaybookDoc = {
  schema_version: 1,
  id: "p",
  name: "P",
  description: "d",
  models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
  documents: { spec: { name: "Spec", purpose: "design", location: "docs/{slug}.md", sections: ["Goal"] } },
  checks: { spec_ok: { kind: "sections", documents: ["spec"] } },
  vars: {},
  start: "write",
  nodes: [
    {
      kind: "step",
      id: "write",
      name: "Write",
      performer: "chat",
      skills: [],
      model: "fast",
      privacy: "cheap",
      permission: "inherit",
      consumes: [],
      produces: ["spec"],
      nod: false,
    },
    { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", max_rounds: 2 },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [
    { from: "write", to: "ok" },
    { from: "ok", to: "done", on: "pass" },
    { from: "ok", to: "write", on: "fail" },
    { from: "ok", to: "done", on: "exhausted" },
  ],
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
};

describe("skillOptions", () => {
  it("lists the installed names and keeps a named skill that is not installed, marked", () => {
    const out = skillOptions([{ name: "a:one" }, { name: "a:two" }], ["a:two", "a:gone"]);
    expect(out).toEqual([
      { name: "a:one", installed: true },
      { name: "a:two", installed: true },
      { name: "a:gone", installed: false },
    ]);
  });

  it("lists a missing name once however often it is named", () => {
    const out = skillOptions([], ["x", "x"]);
    expect(out).toEqual([{ name: "x", installed: false }]);
  });
});

describe("modelOptions", () => {
  it("makes one option per choice with the provider's state and reason", () => {
    const out = modelOptions([
      { choice: "fast", provider: "ollama", model: "qwen3:8b", state: "ready", reason: null },
      { choice: "judge", provider: "anthropic", model: "m", state: "no key", reason: "no key set" },
    ]);
    expect(out.map((o) => o.value)).toEqual(["fast", "judge"]);
    expect(out[1]).toMatchObject({ state: "no key", reason: "no key set" });
    expect(out[0].label).toContain("fast");
  });
});

describe("outcomeOptions", () => {
  it("offers only the outcomes no other arrow of the source uses, plus its own", () => {
    expect(outcomeOptions(MINIMAL, "ok|fail")).toEqual(["fail"]);
  });

  it("offers a freed outcome in the decision's own order after its arrow is gone", () => {
    const cut = apply(MINIMAL, null, { kind: "deleteArrow", key: "ok|pass" }).doc;
    expect(outcomeOptions(cut, "ok|fail")).toEqual(["pass", "fail"]);
  });

  it("offers nothing for the arrow of a step, which has no outcome", () => {
    expect(outcomeOptions(MINIMAL, "write|")).toEqual([]);
    expect(outcomeOptions(MINIMAL, "nowhere|x")).toEqual([]);
  });
});

describe("findingTarget", () => {
  it("maps a node path to that node and an arrow path to that arrow's key", () => {
    expect(findingTarget("nodes[1].check", MINIMAL)).toEqual({ kind: "node", id: "ok" });
    expect(findingTarget("arrows[2]", MINIMAL)).toEqual({ kind: "arrow", key: arrowKey(MINIMAL.arrows[2]) });
    expect(arrowKey(MINIMAL.arrows[2])).toBe("ok|fail");
  });

  it("has no target for a path outside the nodes and arrows, or past their end", () => {
    expect(findingTarget("checks.x.run", MINIMAL)).toBeNull();
    expect(findingTarget("nodes[9]", MINIMAL)).toBeNull();
    expect(findingTarget("arrows[9].to", MINIMAL)).toBeNull();
  });
});

describe("CHECK_FIELDS", () => {
  it("names the fields each check kind uses besides its kind", () => {
    expect(CHECK_FIELDS.command).toEqual(["run"]);
    expect(CHECK_FIELDS.sections).toEqual(["documents", "forbid"]);
    expect(Object.keys(CHECK_FIELDS).sort()).toEqual([
      "command",
      "human",
      "open_items",
      "review",
      "sections",
    ]);
  });
});

describe("splitLines", () => {
  it("makes one entry per non-empty trimmed line", () => {
    expect(splitLines(" a \n\n b\r\nc ")).toEqual(["a", "b", "c"]);
    expect(splitLines("")).toEqual([]);
  });
});
