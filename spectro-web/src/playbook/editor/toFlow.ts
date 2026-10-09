// Card 483: the document as React Flow nodes and edges. The layout is the
// only source of positions; React Flow gets them as given and moves nothing.
// Every edge hangs on the hidden anchor handles, because React Flow renders an
// edge only when its handles exist, and an arrow whose outcome the decision
// does not have must stay on screen.

import type { Edge as FlowEdge, Node as FlowNode } from "@xyflow/react";
import type { PlacedNode, StateGraphLayout } from "../../stategraph/layout";
import { arrowKey, type DocNode, type PlaybookDoc, type Selection } from "./doc";
import type { PlacedLabel } from "./labels";
import { START, type Projection } from "./projection";

export type PbNodeType = "pbStep" | "pbDecision" | "pbEnd" | "pbStart" | "pbGhost";

export interface PbNodeData extends Record<string, unknown> {
  placed: PlacedNode;
  /** The document's node; null for the start box and the ghosts. */
  node: DocNode | null;
  /** The outcomes the node leaves by, one source handle each on a decision. */
  outcomes: string[];
  ghost: "missing" | "duplicate" | null;
  /** For a ghost, the id it stands for. */
  name: string;
}

export interface PbEdgeData extends Record<string, unknown> {
  path: string;
  label: PlacedLabel | null;
  /** An end of the arrow is a ghost. */
  dangling: boolean;
  back: boolean;
}

export type PbFlowNode = FlowNode<PbNodeData, PbNodeType>;
export type PbFlowEdge = FlowEdge<PbEdgeData, "pbArrow">;

/**
 * @param doc the present document
 * @param p its projection
 * @param laid the layout of that projection
 * @param labels the placed outcome labels
 * @param sel the store's selection
 * @param outcomes the outcomes a node leaves by
 * @return the nodes and edges React Flow draws
 */
export function toFlow(
  doc: PlaybookDoc,
  p: Projection,
  laid: StateGraphLayout,
  labels: PlacedLabel[],
  sel: Selection,
  outcomes: (n: DocNode) => string[],
): { nodes: PbFlowNode[]; edges: PbFlowEdge[] } {
  const nodes: PbFlowNode[] = laid.nodes.map((placed) => {
    const ghost = p.ghosts.get(placed.id) ?? null;
    const index = p.nodeIndex.get(placed.id);
    const node = ghost === null && index !== undefined ? (doc.nodes[index] ?? null) : null;
    const type: PbNodeType =
      placed.id === START
        ? "pbStart"
        : ghost !== null || node === null
          ? "pbGhost"
          : node.kind === "step"
            ? "pbStep"
            : node.kind === "decision"
              ? "pbDecision"
              : "pbEnd";
    const real = node !== null;
    return {
      id: placed.id,
      type,
      position: { x: placed.x, y: placed.y },
      width: placed.w,
      height: placed.h,
      draggable: false,
      selectable: real,
      deletable: real,
      selected: real && sel?.kind === "node" && sel.id === placed.id,
      data: {
        placed,
        node,
        outcomes: node === null ? [] : outcomes(node),
        ghost: ghost?.why ?? null,
        name: ghost?.name ?? placed.label,
      },
    };
  });

  const labelOf = new Map(labels.map((l) => [l.edgeIndex, l]));
  const edges: PbFlowEdge[] = laid.edges.map((e, k) => {
    const j = p.edgeArrow[k] ?? null;
    const arrow = j === null ? undefined : doc.arrows[j];
    const real = arrow !== undefined;
    return {
      id: j === null ? "start" : `arrow:${j}`,
      source: e.from,
      target: e.to,
      sourceHandle: "anchor-out",
      targetHandle: "anchor-in",
      type: "pbArrow",
      selectable: real,
      deletable: real,
      selected: real && sel?.kind === "arrow" && sel.key === arrowKey(arrow),
      data: {
        path: e.path,
        label: labelOf.get(k) ?? null,
        dangling: p.ghosts.has(e.from) || p.ghosts.has(e.to),
        back: e.back,
      },
    };
  });
  return { nodes, edges };
}
