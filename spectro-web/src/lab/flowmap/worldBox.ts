// Card 306: world coordinates, once, for everything that needs them.
//
// The map's positions were world positions for its whole life, and two things
// read them as such: the rail router's obstacle set (FlowMap's `railBoxes`)
// and the seat-collision report. The workflow box makes its member agents
// React Flow CHILD nodes — `parentId` plus `extent: "parent"` — and a child's
// position is measured from its parent's top-left.
//
// That is the failure this file exists to stop, and its whole danger is that
// it is quiet: a relative 14 and a world 14 are the same number. The rail
// would route to a point 600px left of the card it is drawn from and nothing
// would say so; the collision check would compare a member against the user
// card and either report a collision that is not there or miss one that is.
//
// So the conversion is a function, it is the only way either consumer reaches
// a rectangle, and it is pinned.

/** The least a node has to be for either helper to work. */
export interface Parented {
  id: string;
  position: { x: number; y: number };
  parentId?: string;
}

/**
 * Every node's WORLD origin, keyed by id.
 *
 * Order-independent on purpose: this must not become a second place where the
 * parents-first rule is assumed. A parent outside the set, or a cycle, resolves
 * to the node's own position rather than dropping it — a card at the wrong
 * place is visible, a card that vanished is not.
 */
export function worldBoxes(nodes: readonly Parented[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out = new Map<string, { x: number; y: number }>();
  for (const node of nodes) {
    let x = node.position.x;
    let y = node.position.y;
    // The guard is the node count: a chain longer than the set has a cycle in
    // it, and the walk stops with what it has instead of spinning.
    const seen = new Set<string>([node.id]);
    let at = node.parentId;
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      const parent = byId.get(at);
      if (parent === undefined) break;
      x += parent.position.x;
      y += parent.position.y;
      at = parent.parentId;
    }
    out.set(node.id, { x, y });
  }
  return out;
}

/**
 * The same nodes, with every parent in front of its children.
 *
 * React Flow REQUIRES it, and today's push order satisfies it by accident:
 * the box happens to be pushed before its members. An ordering that happens to
 * hold is not a guarantee — the next card that moves a push moves it silently
 * — so the array is put in order on the way out and the rule is pinned rather
 * than hoped for.
 *
 * Everything else keeps the order it arrived in: the map's node order is its
 * own reading (zones first, then the cards) and this must not reshuffle it.
 */
export function orderParentsFirst<T extends Parented>(nodes: readonly T[]): T[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: T[] = [];
  const done = new Set<string>();
  const emit = (node: T, seen: Set<string>): void => {
    if (done.has(node.id) || seen.has(node.id)) return;
    seen.add(node.id);
    const parent = node.parentId === undefined ? undefined : byId.get(node.parentId);
    if (parent !== undefined) emit(parent, seen);
    if (done.has(node.id)) return;
    done.add(node.id);
    out.push(node);
  };
  for (const node of nodes) emit(node, new Set());
  return out;
}
