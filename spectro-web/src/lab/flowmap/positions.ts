// Position bookkeeping for the Lab's FlowMap: as the folded scene is re-mapped to
// nodes on every step, we must NOT snap the user's dragged cards back. These two
// pure helpers hold that rule so it can be unit-tested without React Flow.

import type { Node, NodeChange } from "@xyflow/react";

/**
 * Merge freshly folded `next` nodes with the `prev` (currently rendered) ones,
 * preserving positions across a step:
 *  - a main card keeps its previous position by default;
 *  - a subagent takes its freshly computed position so a newly spawned worker
 *    re-centres the group instead of stranding earlier cards — UNLESS the user
 *    dragged it (its id is in `pinned`), in which case it keeps its position too;
 *  - a `relayout` (a local/remote flip re-places the whole map) drops every card
 *    to its fresh position and ignores pins.
 */
export function mergeNodePositions(
  prev: Node[],
  next: Node[],
  pinned: Set<string>,
  relayout: boolean,
): Node[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  return next.map((node) => {
    const old = byId.get(node.id);
    const keep = old !== undefined && !relayout && (pinned.has(node.id) || !node.id.startsWith("sub-"));
    return keep ? { ...node, position: old.position } : node;
  });
}

/** Record every node the user dragged this batch (a position change) into
 *  `pinned`. setNodes (the scene sync) never emits node changes, so a position
 *  change reaching here is always a real user drag. */
export function collectDraggedIds(changes: NodeChange<Node>[], pinned: Set<string>): void {
  for (const c of changes) if (c.type === "position") pinned.add(c.id);
}
