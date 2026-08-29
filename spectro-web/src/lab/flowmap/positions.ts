// Position bookkeeping for the Lab's FlowMap: as the folded scene is re-mapped to
// nodes on every step, we must NOT snap the user's dragged cards back. These two
// pure helpers hold that rule so it can be unit-tested without React Flow.

import type { Node, NodeChange } from "@xyflow/react";

/**
 * Merge freshly folded `next` nodes with the `prev` (currently rendered) ones,
 * preserving positions across a step.
 *
 * THE RULE, and why it is the layout's own movement that decides.
 *
 * A card keeps the seat it is on screen at for exactly as long as the layout
 * keeps computing the same seat for it. The moment the layout computes a
 * DIFFERENT one, the card goes there — that is not a re-layout, it is the map
 * doing its job while the reader scrubs. Only a dragged card (`pinned`)
 * overrides it, and only a `relayout` (the seating world itself flipped)
 * overrides the pins.
 *
 * The rule this replaced was "a main card keeps its previous position, a
 * subagent takes its fresh one", and it froze the map's furniture. Card 306's
 * workflow box grows as the run fills it, and everything the box pushes aside
 * — the OS band, the boundary wall, the LLM, the outside stations — carries an
 * id that does not begin with "sub-". Every one of them stayed at the seat it
 * had when the box was one card tall, and the box was drawn straight through
 * them: measured in the running app, box 1172x982 at (610,110) with z-os still
 * at y 668 and the LLM still at x 1432, while the fold had already moved them
 * to 1152 and 2878. Nothing was wrong with the arithmetic; it never reached
 * the screen.
 *
 * @param prev what the canvas currently holds — where each card IS
 * @param next the freshly folded nodes — where the layout says each card goes
 * @param pinned ids the reader dragged; they keep their seat through a move
 * @param relayout the seating world flipped: every card drops to its fresh
 *                 seat and the pins are ignored
 * @param prevFresh the PREVIOUS fold's nodes — where the layout said each card
 *                  went last time. The comparison against `next` is what tells
 *                  "the layout moved this" apart from "the reader moved this".
 */
export function mergeNodePositions(
  prev: Node[],
  next: Node[],
  pinned: Set<string>,
  relayout: boolean,
  prevFresh: readonly Node[],
): Node[] {
  const byId = new Map(prev.map((p) => [p.id, p]));
  const freshBefore = new Map(prevFresh.map((p) => [p.id, p.position]));
  return next.map((node) => {
    const old = byId.get(node.id);
    if (old === undefined || relayout) return node;
    if (pinned.has(node.id)) return { ...node, position: old.position };
    const was = freshBefore.get(node.id);
    const moved = was === undefined || was.x !== node.position.x || was.y !== node.position.y;
    return moved ? node : { ...node, position: old.position };
  });
}

/** Record every node the user dragged this batch (a position change) into
 *  `pinned`. setNodes (the scene sync) never emits node changes, so a position
 *  change reaching here is always a real user drag. */
export function collectDraggedIds(changes: NodeChange<Node>[], pinned: Set<string>): void {
  for (const c of changes) if (c.type === "position") pinned.add(c.id);
}
