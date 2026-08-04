// The agent tree: the fleet's spawn parentage flattened into indented rows —
// the LEFT column of the control room, langfuse's trace tree in fleet
// vocabulary. Parentage comes from buildFleetGraph's `spawnedBy`, which reads
// the RunEvent PAYLOADS (agent_spawn.parentId, run_start.parentId) and never
// the bus envelope's parentId (that one is the sender's own who-sent-last
// chain, and threading a tree on it would draw a fiction).
//
// Two shapes the wire really produces and the fold must survive: a parent whose
// card was evicted from the hub ring (its child is then a root, not a ghost),
// and a parentage cycle (two nodes each naming the other, which no honest
// stream should contain but a replayed or corrupted one can).

import { buildFleetGraph, type FleetGraphNode } from "./fleetGraph";
import type { FleetModel } from "./fleetModel";

export interface FleetTreeRow {
  id: string;
  role: string;
  /** How deep under a root, 0-based — the rail's indent. */
  depth: number;
  /** True for the last sibling of its parent, so the rail can draw an elbow. */
  last: boolean;
  /** The graph node this row stands for, for the state dot and the counts. */
  node: FleetGraphNode;
}

/**
 * Flatten a fleet into depth-first tree rows: every parent immediately before
 * its children, siblings ordered by first act then id. Pure.
 */
export function buildFleetTree(model: FleetModel): FleetTreeRow[] {
  const graph = buildFleetGraph(model);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const node of graph.nodes) {
    // A parent nobody ever saw is no parent: the child is a root, so an evicted
    // card can never make an agent disappear from the rail.
    const parent = node.spawnedBy !== null && byId.has(node.spawnedBy) ? node.spawnedBy : null;
    if (parent === null || parent === node.id) {
      roots.push(node.id);
    } else {
      const list = children.get(parent);
      if (list) list.push(node.id);
      else children.set(parent, [node.id]);
    }
  }

  const order = (ids: string[]): string[] =>
    [...ids].sort((a, b) => {
      const at = byId.get(a)?.firstTs ?? Number.POSITIVE_INFINITY;
      const bt = byId.get(b)?.firstTs ?? Number.POSITIVE_INFINITY;
      return at !== bt ? at - bt : a.localeCompare(b);
    });

  const rows: FleetTreeRow[] = [];
  const placed = new Set<string>();
  const walk = (id: string, depth: number, last: boolean): void => {
    if (placed.has(id)) return; // a cycle reaching back, or a duplicate parent claim
    placed.add(id);
    const node = byId.get(id);
    if (node === undefined) return;
    rows.push({ id, role: node.role, depth, last, node });
    const kids = order(children.get(id) ?? []);
    kids.forEach((kid, i) => walk(kid, depth + 1, i === kids.length - 1));
  };

  const topLevel = order(roots);
  topLevel.forEach((id, i) => walk(id, 0, i === topLevel.length - 1));

  // A pure cycle has no root at all. Break in at the first unplaced node (by
  // the same stable order) and keep going until everyone is listed exactly
  // once — the rail's job is to show the fleet, not to judge its shape.
  for (const id of order(graph.nodes.map((n) => n.id))) {
    if (!placed.has(id)) walk(id, 0, true);
  }

  return rows;
}
