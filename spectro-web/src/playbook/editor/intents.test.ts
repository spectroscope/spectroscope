// Card 483: what React Flow reports becomes a selection or one command. React
// Flow removes nothing itself and moves nothing; the store holds the document.

import type { Edge as FlowEdge, EdgeChange, Node as FlowNode, NodeChange } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import type { PlaybookDoc } from "./doc";
import { commandFromConnect, commandFromDelete, selectionFromChanges } from "./intents";
import { MISSING, START } from "./projection";

const DOC: PlaybookDoc = {
  schema_version: 1,
  id: "p",
  name: "P",
  description: "d",
  models: {},
  documents: {},
  checks: {},
  vars: {},
  start: "write",
  nodes: [
    {
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
    },
    { kind: "decision", id: "ok", name: "Ok", check: "", max_rounds: 2 },
    { kind: "end", id: "done", result: "done" },
  ],
  arrows: [
    { from: "write", to: "ok" },
    { from: "ok", to: "done", on: "pass" },
    { from: "ok", to: "write", on: "fail" },
  ],
  contents: { skills: [], agents: [], hooks: [], commands: [], workflows: [] },
};

const nodeSelect = (id: string, selected: boolean): NodeChange => ({ id, type: "select", selected });
const edgeSelect = (id: string, selected: boolean): EdgeChange => ({ id, type: "select", selected });
const flowNode = (id: string): FlowNode => ({ id, position: { x: 0, y: 0 }, data: {} });
const flowEdge = (id: string, source: string, target: string): FlowEdge => ({ id, source, target });

describe("selection from React Flow's changes", () => {
  it("reads a selected node as a node selection and a selected arrow as its key", () => {
    expect(selectionFromChanges([nodeSelect("write", true)], DOC, null)).toEqual({
      kind: "node",
      id: "write",
    });
    expect(selectionFromChanges([edgeSelect("arrow:2", true)], DOC, null)).toEqual({
      kind: "arrow",
      key: "ok|fail",
    });
  });

  it("ignores position and dimension changes", () => {
    const moved: NodeChange = { id: "write", type: "position", position: { x: 4, y: 4 } };
    expect(selectionFromChanges([moved], DOC, null)).toBeUndefined();
    const sized: NodeChange = { id: "write", type: "dimensions", dimensions: { width: 1, height: 1 } };
    expect(selectionFromChanges([sized], DOC, null)).toBeUndefined();
  });

  it("clears when the present selection is deselected, as a click on the empty canvas does", () => {
    expect(selectionFromChanges([nodeSelect("write", false)], DOC, { kind: "node", id: "write" })).toBeNull();
    expect(
      selectionFromChanges([edgeSelect("arrow:2", false)], DOC, { kind: "arrow", key: "ok|fail" }),
    ).toBeNull();
  });

  it("keeps a new selection when React Flow deselects the old one afterwards", () => {
    // React Flow sends the node batch first and the edge batch second
    // (addSelectedNodes), so the arrow's deselect arrives after the node is picked.
    const picked = selectionFromChanges([nodeSelect("ok", true)], DOC, { kind: "arrow", key: "ok|fail" });
    expect(picked).toEqual({ kind: "node", id: "ok" });
    expect(selectionFromChanges([edgeSelect("arrow:2", false)], DOC, picked!)).toBeUndefined();
  });

  it("never selects the start box or a ghost", () => {
    expect(selectionFromChanges([nodeSelect(START, true)], DOC, null)).toBeUndefined();
    expect(selectionFromChanges([nodeSelect(`${MISSING}gone`, true)], DOC, null)).toBeUndefined();
    expect(selectionFromChanges([edgeSelect("start", true)], DOC, null)).toBeUndefined();
  });
});

describe("a connection as one command", () => {
  it("carries the outcome handle as the arrow's outcome", () => {
    expect(
      commandFromConnect({ source: "ok", sourceHandle: "fail", target: "done", targetHandle: "in" }),
    ).toEqual({
      kind: "connect",
      from: "ok",
      on: "fail",
      to: "done",
    });
  });

  it("reads a step's handle out as no outcome", () => {
    expect(
      commandFromConnect({ source: "write", sourceHandle: "out", target: "done", targetHandle: "in" }),
    ).toEqual({
      kind: "connect",
      from: "write",
      on: null,
      to: "done",
    });
  });

  it("refuses a connection without a handle or into the start box or a ghost", () => {
    expect(
      commandFromConnect({ source: "write", sourceHandle: null, target: "done", targetHandle: "in" }),
    ).toBeNull();
    expect(
      commandFromConnect({ source: "write", sourceHandle: "out", target: START, targetHandle: "in" }),
    ).toBeNull();
    expect(
      commandFromConnect({
        source: "write",
        sourceHandle: "out",
        target: `${MISSING}gone`,
        targetHandle: "in",
      }),
    ).toBeNull();
  });
});

describe("a delete as one command", () => {
  it("deletes the node and ignores the arrows React Flow adds to it", () => {
    const cmd = commandFromDelete(
      [flowNode("write")],
      [flowEdge("arrow:0", "write", "ok"), flowEdge("start", START, "write")],
      DOC,
    );
    expect(cmd).toEqual({ kind: "deleteNode", id: "write" });
  });

  it("deletes an arrow by its key", () => {
    expect(commandFromDelete([], [flowEdge("arrow:1", "ok", "done")], DOC)).toEqual({
      kind: "deleteArrow",
      key: "ok|pass",
    });
  });

  it("deletes nothing for the start edge alone or a ghost alone", () => {
    expect(commandFromDelete([], [flowEdge("start", START, "write")], DOC)).toBeNull();
    expect(commandFromDelete([flowNode(`${MISSING}gone`)], [], DOC)).toBeNull();
  });
});
