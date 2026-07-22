// The shared top-down dagre layout, lifted out of the fleet canvas and the
// graph tab (which had byte-identical copies). Pure: same nodes + edges +
// options in, same positions out. Callers that need extra positioning (the
// graph tab's parallel-lane shift) run their own pass on top of this result.

import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import * as dagre from "dagre"; // namespace import: @types/dagre has NO default export

export interface DagreOptions {
  /** Fixed node box dagre lays out against; the rendered CSS must match. */
  nodeW: number;
  nodeH: number;
  /** Rank direction (default top-to-bottom). */
  rankdir?: "TB" | "LR";
  /** Gap between nodes in the same rank. */
  nodesep?: number;
  /** Gap between ranks. */
  ranksep?: number;
}

/**
 * Lay out `nodes`/`edges` with dagre and return the nodes with their
 * top-left `position` set (dagre reports centres; React Flow wants top-left).
 * The input array is not mutated — each node is shallow-copied with its new
 * position.
 */
export function layoutDagre(nodes: FlowNode[], edges: FlowEdge[], opts: DagreOptions): FlowNode[] {
  const { nodeW, nodeH, rankdir = "TB", nodesep = 40, ranksep = 56 } = opts;
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir, nodesep, ranksep });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: nodeW, height: nodeH });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);
  return nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: p.x - nodeW / 2, y: p.y - nodeH / 2 } };
  });
}
