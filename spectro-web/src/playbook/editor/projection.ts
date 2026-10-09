// Card 483: the editor's projection of a playbook onto the layout engine.
//
// P2's server topology folds every end into `__end__`; the editor keeps each
// end as its own box so an arrow still shows which end it reaches. An endpoint
// that names no node becomes a ghost box, and so does a second node with a
// taken id, so the layout never drops an edge: drawn edge k is projected edge
// k, and `assertJoined` holds the layout to that.

import type {
  NodeSize,
  StateGraphLayout,
  Topology,
  TopologyEdge,
  TopologyNode,
} from "../../stategraph/layout";
import type { PlaybookDoc } from "./doc";
import { gapFor } from "./labels";

export const START = "__start__";
export const MISSING = "__missing__:";
export const DUPLICATE = "__duplicate__:";

const STEP: NodeSize = { w: 180, h: 64 };
const DECISION: NodeSize = { w: 140, h: 64 };
const END: NodeSize = { w: 120, h: 46 };
const GHOST: NodeSize = { w: 120, h: 46 };

export interface Projection {
  /** Entry START, the nodes, the edges, the sizes and gapAlong. */
  topo: Topology;
  /** Per projected edge: the index of its arrow in doc.arrows, null for the start edge. */
  edgeArrow: (number | null)[];
  ghosts: Map<string, { name: string; why: "missing" | "duplicate" }>;
  /** A drawn id to its index in doc.nodes; a missing ghost has none. */
  nodeIndex: Map<string, number>;
}

function synthetic(id: string): boolean {
  return id === START || id.startsWith(MISSING) || id.startsWith(DUPLICATE);
}

export function project(doc: PlaybookDoc): Projection {
  const nodes: TopologyNode[] = [{ id: START, label: START }];
  const sizes = new Map<string, NodeSize>();
  const ghosts: Projection["ghosts"] = new Map();
  const nodeIndex = new Map<string, number>();
  const kindOf = new Map<string, "step" | "decision" | "end">();

  doc.nodes.forEach((n, i) => {
    if (nodeIndex.has(n.id) || synthetic(n.id)) {
      const id = `${DUPLICATE}${i}`;
      nodes.push({ id, label: n.id });
      sizes.set(id, GHOST);
      ghosts.set(id, { name: n.id, why: "duplicate" });
      nodeIndex.set(id, i);
      return;
    }
    nodes.push({ id: n.id, label: n.kind === "end" ? n.result : n.name });
    sizes.set(n.id, n.kind === "step" ? STEP : n.kind === "decision" ? DECISION : END);
    nodeIndex.set(n.id, i);
    kindOf.set(n.id, n.kind);
  });

  const missing: TopologyNode[] = [];
  const endpoint = (id: string): string => {
    if (kindOf.has(id)) return id;
    const ghost = `${MISSING}${id}`;
    if (!ghosts.has(ghost)) {
      missing.push({ id: ghost, label: id });
      sizes.set(ghost, GHOST);
      ghosts.set(ghost, { name: id, why: "missing" });
    }
    return ghost;
  };

  const edges: TopologyEdge[] = [{ from: START, to: endpoint(doc.start), kind: "direct" }];
  const edgeArrow: (number | null)[] = [null];
  doc.arrows.forEach((a, j) => {
    const from = endpoint(a.from);
    edges.push({
      from,
      to: endpoint(a.to),
      kind: kindOf.get(from) === "decision" ? "conditional" : "direct",
    });
    edgeArrow.push(j);
  });

  return {
    topo: { entry: START, nodes: [...nodes, ...missing], edges, sizes, gapAlong: gapFor(doc) },
    edgeArrow,
    ghosts,
    nodeIndex,
  };
}

/** Throws when the layout drew a different number of edges than it was given. */
export function assertJoined(p: Projection, laid: StateGraphLayout): void {
  if (laid.edges.length !== p.topo.edges.length) {
    throw new Error(
      `playbook projection: the layout drew ${laid.edges.length} edges for ${p.topo.edges.length} projected`,
    );
  }
}
