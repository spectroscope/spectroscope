// Card 481: the playbook drawn by a renderer of its own over the state graph's
// layout engine. Rendered statically from the spec's MINIMAL shape as the load
// route answers it: a step `write`, a decision `ok` with a ceiling of two
// rounds, and an end `done`, which the server's topology folds into __end__.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LoadedPlaybook } from "../state/playbooks";
import { PlaybookGraph } from "./PlaybookGraph";

const MINIMAL: LoadedPlaybook = {
  playbook: {
    id: "p",
    name: "P",
    description: "d",
    start: "write",
    nodes: [
      {
        kind: "step",
        id: "write",
        name: "Write",
        performer: "chat",
        skills: ["spectropowers:brainstorming"],
        model: "fast",
        privacy: "cheap",
        consumes: [],
        produces: ["spec"],
        nod: false,
      },
      { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", outcomes: [], maxRounds: 2 },
      { kind: "end", id: "done", result: "done" },
    ],
    arrows: [
      { from: "write", to: "ok", on: null },
      { from: "ok", to: "done", on: "pass" },
      { from: "ok", to: "write", on: "fail" },
      { from: "ok", to: "done", on: "exhausted" },
    ],
    models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
    documents: { spec: { name: "Spec", purpose: "design", location: "docs/{slug}.md", sections: ["Goal"] } },
    contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
  },
  topology: {
    entry: "write",
    nodes: [
      { id: "__start__", label: "__start__" },
      { id: "write", label: "Write" },
      { id: "ok", label: "Spec ok" },
      { id: "__end__", label: "__end__" },
    ],
    edges: [
      { from: "__start__", to: "write", kind: "direct" },
      { from: "write", to: "ok", kind: "direct" },
      { from: "ok", to: "__end__", kind: "conditional", branch: "ok" },
      { from: "ok", to: "write", kind: "conditional", branch: "ok" },
      { from: "ok", to: "__end__", kind: "conditional", branch: "ok" },
    ],
  },
  findings: [],
  steps: [
    {
      id: "write",
      skills: [{ name: "spectropowers:brainstorming", installed: true, disabled: false }],
      model: { choice: "fast", provider: "ollama", model: "qwen3:8b", state: "local", reason: null },
    },
  ],
  dir: "/p",
};

const html = renderToStaticMarkup(<PlaybookGraph loaded={MINIMAL} />);

/** The markup of one node's group, by the node id it carries. */
function nodeGroup(id: string): string {
  const m = new RegExp(`<g class="pb-node[^"]*" data-node="${id}">(.*?)</g>`).exec(html);
  return m?.[1] ?? "";
}

/** The markup of every edge group between two nodes, in drawing order. */
function edgeGroups(from: string, to: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<g class="pb-edge-g" data-from="${from}" data-to="${to}">(.*?)</g>`, "g")),
  ].map((m) => m[1]);
}

describe("PlaybookGraph", () => {
  it("draws the step write as one card of its stated size, with its model and performer", () => {
    expect(html.match(/<rect class="pb-step"/g)).toHaveLength(1);
    const write = nodeGroup("write");
    expect(write).toContain('<rect class="pb-step"');
    expect(write).toContain('width="180"');
    expect(write).toContain('height="64"');
    expect(write).toContain("Write");
    expect(write).toContain("fast");
    expect(write).toContain("in the chat");
  });

  it("draws the decision ok as one diamond with its ceiling", () => {
    expect(html.match(/<polygon class="pb-decision"/g)).toHaveLength(1);
    const ok = nodeGroup("ok");
    expect(ok).toContain('<polygon class="pb-decision"');
    expect(ok).toContain("Spec ok");
    expect(ok).toContain("up to 2 rounds");
  });

  it("draws the start and the end as rounded boxes", () => {
    expect(nodeGroup("__start__")).toContain('class="pb-terminal"');
    expect(nodeGroup("__end__")).toContain('class="pb-terminal"');
  });

  it("marks the arrow from ok back to write as a loop and labels it fail", () => {
    const back = edgeGroups("ok", "write");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatch(/<path class="pb-edge[^"]*\bpb-edge--back\b/);
    expect(back[0]).toContain(">fail</text>");
  });

  it("keeps the forward arrows unmarked and labels each outcome to the end", () => {
    const forward = edgeGroups("write", "ok");
    expect(forward).toHaveLength(1);
    expect(forward[0]).toContain('class="pb-edge"');
    expect(forward[0]).not.toContain("pb-edge--back");
    const toEnd = edgeGroups("ok", "__end__").join("");
    expect(toEnd).not.toContain("pb-edge--back");
    expect(toEnd).toContain("pass");
    expect(toEnd).toContain("exhausted");
  });

  it("draws every node the topology names and no other", () => {
    const ids = [...html.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["__end__", "__start__", "ok", "write"]);
  });
});
