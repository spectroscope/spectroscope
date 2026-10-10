// Card 483: the editor's own projection of a playbook onto the layout engine.
// Ends stay their own boxes, and a missing or duplicate endpoint becomes a
// ghost box, so the layout drops nothing and drawn edge k is arrow k.

import { describe, expect, it } from "vitest";
import { layoutStateGraph } from "../../stategraph/layout";
import type { DocStep, PlaybookDoc } from "./doc";
import { assertJoined, DUPLICATE, MISSING, project, START } from "./projection";

const WRITE: DocStep = {
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
};

/** The spec's MINIMAL shape as the file holds it. */
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
    WRITE,
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

describe("the editor projection", () => {
  it("projects MINIMAL as a start box, its nodes in order, and one edge per arrow after the start edge", () => {
    const p = project(MINIMAL);
    expect(p.topo.entry).toBe(START);
    expect(p.topo.nodes.map((n) => n.id)).toEqual([START, "write", "ok", "done"]);
    expect(p.topo.edges).toEqual([
      { from: START, to: "write", kind: "direct" },
      { from: "write", to: "ok", kind: "direct" },
      { from: "ok", to: "done", kind: "conditional" },
      { from: "ok", to: "write", kind: "conditional" },
      { from: "ok", to: "done", kind: "conditional" },
    ]);
    expect(p.edgeArrow).toEqual([null, 0, 1, 2, 3]);
    expect(p.ghosts.size).toBe(0);
    expect([...p.nodeIndex]).toEqual([
      ["write", 0],
      ["ok", 1],
      ["done", 2],
    ]);
    expect(p.topo.sizes?.get("write")).toEqual({ w: 180, h: 64 });
    expect(p.topo.sizes?.get("ok")).toEqual({ w: 140, h: 64 });
    expect(p.topo.sizes?.get("done")).toEqual({ w: 120, h: 46 });
    expect(p.topo.gapAlong).toBe(80);
  });

  it("keeps the loop a loop and draws both arrows into the one end", () => {
    const p = project(MINIMAL);
    const laid = layoutStateGraph(p.topo, "horizontal");
    assertJoined(p, laid);
    const back = laid.edges.find((e) => e.from === "ok" && e.to === "write");
    expect(back?.back).toBe(true);
    expect(laid.edges.filter((e) => e.from === "ok" && e.to === "done").map((e) => e.id)).toEqual([
      "ok->done",
      "ok->done#2",
    ]);
  });

  it("draws an arrow to a node that is not there into a ghost, and drops nothing", () => {
    const doc: PlaybookDoc = {
      ...MINIMAL,
      arrows: MINIMAL.arrows.map((a) => (a.on === "fail" ? { ...a, to: "gone" } : a)),
    };
    const p = project(doc);
    expect(p.ghosts.get(`${MISSING}gone`)).toEqual({ name: "gone", why: "missing" });
    expect(p.topo.sizes?.get(`${MISSING}gone`)).toEqual({ w: 120, h: 46 });
    const laid = layoutStateGraph(p.topo, "horizontal");
    expect(laid.edges.length).toBe(p.topo.edges.length);
    expect(() => assertJoined(p, laid)).not.toThrow();
    const k = p.edgeArrow.indexOf(2);
    expect(laid.edges[k].from).toBe("ok");
    expect(laid.edges[k].to).toBe(`${MISSING}gone`);
  });

  it("makes a second node with a taken id a ghost and binds the arrows to the first", () => {
    const doc: PlaybookDoc = {
      ...MINIMAL,
      nodes: [...MINIMAL.nodes, { ...WRITE, name: "Write again" }, { ...WRITE, id: START }],
    };
    const p = project(doc);
    expect(p.topo.nodes.map((n) => n.id)).toEqual([
      START,
      "write",
      "ok",
      "done",
      `${DUPLICATE}3`,
      `${DUPLICATE}4`,
    ]);
    expect(p.ghosts.get(`${DUPLICATE}3`)).toEqual({ name: "write", why: "duplicate" });
    expect(p.ghosts.get(`${DUPLICATE}4`)).toEqual({ name: START, why: "duplicate" });
    expect(p.nodeIndex.get("write")).toBe(0);
    expect(p.nodeIndex.get(`${DUPLICATE}3`)).toBe(3);
    expect(p.topo.edges.slice(1).map((e) => [e.from, e.to])).toEqual([
      ["write", "ok"],
      ["ok", "done"],
      ["ok", "write"],
      ["ok", "done"],
    ]);
    assertJoined(p, layoutStateGraph(p.topo, "horizontal"));
  });

  it("ends the start edge at a ghost when start names no node", () => {
    const p = project({ ...MINIMAL, start: "nowhere" });
    expect(p.topo.edges[0]).toEqual({ from: START, to: `${MISSING}nowhere`, kind: "direct" });
    expect(p.ghosts.get(`${MISSING}nowhere`)).toEqual({ name: "nowhere", why: "missing" });
  });

  it("refuses a layout that drew one edge fewer than it was given", () => {
    const p = project(MINIMAL);
    const laid = layoutStateGraph(p.topo, "horizontal");
    expect(() => assertJoined(p, { ...laid, edges: laid.edges.slice(1) })).toThrow();
  });
});
