// Card 483: what React Flow reports, read as a selection or as one command.
// React Flow moves nothing and removes nothing itself; every change to the
// document goes through the store as a command.

import type { Connection, Edge as FlowEdge, EdgeChange, Node as FlowNode, NodeChange } from "@xyflow/react";
import type { Command } from "./commands";
import { arrowKey, type PlaybookDoc, type Selection } from "./doc";
import { DUPLICATE, MISSING, START } from "./projection";

const ARROW = "arrow:";

function synthetic(id: string): boolean {
  return id === START || id.startsWith(MISSING) || id.startsWith(DUPLICATE);
}

/** The selection a drawn id stands for, or null for the start box, a ghost or an unknown id. */
function selectionOf(id: string, doc: PlaybookDoc): Selection {
  if (id.startsWith(ARROW)) {
    const a = doc.arrows[Number(id.slice(ARROW.length))];
    return a === undefined ? null : { kind: "arrow", key: arrowKey(a) };
  }
  if (synthetic(id) || !doc.nodes.some((n) => n.id === id)) return null;
  return { kind: "node", id };
}

function same(a: Selection, b: Selection): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind === "node") return b.kind === "node" && a.id === b.id;
  return b.kind === "arrow" && a.key === b.key;
}

/**
 * The selection a batch of changes asks for. Only `select` changes count. A
 * deselect clears only the present selection: React Flow sends the node batch
 * before the edge batch, so the old arrow's deselect arrives after a node was
 * picked and must not undo the pick.
 *
 * @param changes one batch from onNodesChange or onEdgesChange
 * @param doc the present document
 * @param current the store's present selection
 * @return the new selection, or undefined when the batch changes nothing
 */
export function selectionFromChanges(
  changes: (NodeChange | EdgeChange)[],
  doc: PlaybookDoc,
  current: Selection,
): Selection | undefined {
  let cleared = false;
  for (const c of changes) {
    if (c.type !== "select") continue;
    const sel = selectionOf(c.id, doc);
    if (sel === null) continue;
    if (c.selected) return sel;
    if (same(sel, current)) cleared = true;
  }
  return cleared ? null : undefined;
}

/**
 * A drag from a handle to a box as one connect command. A step's handle is
 * `out` and carries no outcome; a decision's handle is the outcome itself.
 *
 * @param c the connection React Flow reports
 * @return the command, or null for a connection that names no real box
 */
export function commandFromConnect(c: Connection): Command | null {
  if (c.sourceHandle === null || c.sourceHandle === undefined) return null;
  if (synthetic(c.source) || synthetic(c.target)) return null;
  return {
    kind: "connect",
    from: c.source,
    on: c.sourceHandle === "out" ? null : c.sourceHandle,
    to: c.target,
  };
}

/**
 * The delete key as one command. A node takes its arrows along, so the edges
 * React Flow adds to a deleted node are ignored.
 *
 * @param nodes the nodes React Flow would remove
 * @param edges the edges React Flow would remove
 * @param doc the present document
 * @return the command, or null when nothing deletable is in the set
 */
export function commandFromDelete(nodes: FlowNode[], edges: FlowEdge[], doc: PlaybookDoc): Command | null {
  for (const n of nodes) {
    const sel = selectionOf(n.id, doc);
    if (sel?.kind === "node") return { kind: "deleteNode", id: sel.id };
  }
  for (const e of edges) {
    const sel = selectionOf(e.id, doc);
    if (sel?.kind === "arrow") return { kind: "deleteArrow", key: sel.key };
  }
  return null;
}
