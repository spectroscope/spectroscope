// Card 481, changed by card 483 (Task 11): the playbook drawn by a renderer of
// its own over the state graph's layout engine. The graph now takes the
// editor's document and draws it through the editor's projection, so every end
// is a box of its own (the server's topology folded them into __end__) and each
// outcome label comes from placeLabels. Rendered statically from a step
// `write`, a decision `ok` with a ceiling of two rounds, and two ends.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PlaybookDoc } from "./editor/doc";
import { PlaybookGraph } from "./PlaybookGraph";

const MINIMAL: PlaybookDoc = {
  schema_version: 1,
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
      permission: "inherit",
      consumes: [],
      produces: ["spec"],
      nod: false,
    },
    { kind: "decision", id: "ok", name: "Spec ok", check: "spec_ok", max_rounds: 2 },
    { kind: "end", id: "done", result: "done" },
    { kind: "end", id: "stop", result: "stopped" },
  ],
  arrows: [
    { from: "write", to: "ok" },
    { from: "ok", to: "done", on: "pass" },
    { from: "ok", to: "write", on: "fail" },
    { from: "ok", to: "stop", on: "exhausted" },
  ],
  models: { fast: { primary: { provider: "ollama", model: "qwen3:8b" }, fallbacks: [] } },
  documents: { spec: { name: "Spec", purpose: "design", location: "docs/{slug}.md", sections: ["Goal"] } },
  checks: {},
  vars: {},
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
};

const html = renderToStaticMarkup(<PlaybookGraph doc={MINIMAL} />);

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

  it("draws the start as a rounded box and each end as a rounded box of its own", () => {
    expect(nodeGroup("__start__")).toContain('class="pb-terminal"');
    expect(html.match(/<rect class="pb-end"/g)).toHaveLength(2);
    expect(nodeGroup("done")).toContain('<rect class="pb-end"');
    expect(nodeGroup("done")).toContain(">done</text>");
    expect(nodeGroup("stop")).toContain('<rect class="pb-end"');
    expect(nodeGroup("stop")).toContain(">stopped</text>");
  });

  it("marks the arrow from ok back to write as a loop and labels it fail", () => {
    const back = edgeGroups("ok", "write");
    expect(back).toHaveLength(1);
    expect(back[0]).toMatch(/<path class="pb-edge[^"]*\bpb-edge--back\b/);
    expect(back[0]).toContain(">fail</text>");
  });

  it("keeps the forward arrows unmarked and labels each outcome on its own arrow to its own end", () => {
    const forward = edgeGroups("write", "ok");
    expect(forward).toHaveLength(1);
    expect(forward[0]).toContain('class="pb-edge"');
    expect(forward[0]).not.toContain("pb-edge--back");
    const pass = edgeGroups("ok", "done");
    expect(pass).toHaveLength(1);
    expect(pass[0]).not.toContain("pb-edge--back");
    expect(pass[0]).toContain(">pass</text>");
    const exhausted = edgeGroups("ok", "stop");
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toContain(">exhausted</text>");
  });

  it("draws every node the document names, the start, and no other", () => {
    const ids = [...html.matchAll(/data-node="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.sort()).toEqual(["__start__", "done", "ok", "stop", "write"]);
  });

  it("draws an arrow to a node that is not there as a marked arrow and a marked ghost, never drops it", () => {
    const broken: PlaybookDoc = {
      ...MINIMAL,
      arrows: [...MINIMAL.arrows, { from: "write", to: "nowhere", on: "skip" }],
    };
    const out = renderToStaticMarkup(<PlaybookGraph doc={broken} />);
    const edges = [...out.matchAll(/<g class="pb-edge-g" data-from="write" data-to="([^"]+)">/g)].map(
      (m) => m[1],
    );
    expect(edges).toHaveLength(2);
    expect(out).toContain("pb-edge--dangling");
    expect(out).toMatch(/<g class="pb-node pb-node--ghost"[^>]*>[\s\S]*?nowhere/);
  });
});
