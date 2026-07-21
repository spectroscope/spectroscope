// Fleet legibility: a FleetGraph -> a LegibleGraph the canvas can actually read
// at scale. Pure transform, no React. Three moves:
//   1. aggregate-by-name — a wide fan-out of same-(parent, role) siblings folds
//      into one group node.
//   2. subtree roll-up — the ungrouped subtree hanging under a collapsed member
//      folds into that group (a nested fan-out that forms its OWN group stays
//      visible, re-parented under the group it lives in).
//   3. clustering + level-of-detail — every node carries its role as a cluster
//      (layout/tint hint) and the graph reports a detail tier from its node
//      count, so the canvas can shrink node bodies as a fleet grows.
// Group ids are deterministic (`group:<parent>:<role>`) so React Flow keeps
// node identity across re-folds.

import type { FleetGraph, FleetGraphEdge, FleetGraphNode } from "./fleetGraph";

export type LegibleKind = "agent" | "group";

export interface LegibleNode {
  id: string;
  kind: LegibleKind;
  role: string;
  /** Layout/tint hint — equal to role; the canvas groups/colours by it. */
  cluster: string;
  /** 1 for an agent, N for a group of collapsed siblings (the fan-out width). */
  count: number;
  /** [id] for an agent; the collapsed sibling ids for a group. */
  members: string[];
  /** Ids of the subtree rolled up under a group (empty for an agent). */
  descendants: string[];
  connected: boolean;
  epoch: number;
  state: FleetGraphNode["state"];
  pendingGate: boolean;
  spawnedBy: string | null;
  inTokens: number;
  outTokens: number;
}

export interface LegibleGraph {
  nodes: LegibleNode[];
  edges: FleetGraphEdge[];
  /** Level-of-detail for the whole canvas, derived from the node count. */
  detail: "full" | "compact" | "dot";
}

export interface CollapseOpts {
  /** Aggregate same-(parent, role) siblings once there are at least this many. */
  minGroup?: number;
  /** Soft budget on rendered nodes; drives the level-of-detail. */
  maxNodes?: number;
}

// A monitor must never hide a red behind a green: `failed` dominates the group
// fold, then `working` (live), then `completed`, then `idle`.
const STATE_RANK: Record<FleetGraphNode["state"], number> = {
  failed: 3, working: 2, completed: 1, idle: 0,
};

const higherState = (
  a: FleetGraphNode["state"],
  b: FleetGraphNode["state"],
): FleetGraphNode["state"] => (STATE_RANK[b] > STATE_RANK[a] ? b : a);

function asAgent(n: FleetGraphNode): LegibleNode {
  return {
    id: n.id, kind: "agent", role: n.role, cluster: n.role,
    count: 1, members: [n.id], descendants: [],
    connected: n.connected, epoch: n.epoch, state: n.state, pendingGate: n.pendingGate,
    spawnedBy: n.spawnedBy, inTokens: n.inTokens, outTokens: n.outTokens,
  };
}

/** Fold one node's aggregates into a group in place (a sibling or a descendant). */
function absorbInto(group: LegibleNode, n: FleetGraphNode): void {
  group.connected = group.connected || n.connected;
  group.epoch = Math.max(group.epoch, n.epoch);
  group.state = higherState(group.state, n.state);
  group.pendingGate = group.pendingGate || n.pendingGate;
  group.inTokens += n.inTokens;
  group.outTokens += n.outTokens;
}

/** Reroute each edge through `rep` (original id -> representative id), dropping
 *  self-edges (both ends inside one group) and duplicates. */
function rerouteEdges(edges: FleetGraphEdge[], rep: Map<string, string>): FleetGraphEdge[] {
  const out: FleetGraphEdge[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const source = rep.get(e.source) ?? e.source;
    const target = rep.get(e.target) ?? e.target;
    if (source === target) continue;
    const id = `${e.kind}:${source}->${target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, source, target, kind: e.kind });
  }
  return out;
}

function detailFor(nodeCount: number, maxNodes: number): LegibleGraph["detail"] {
  if (nodeCount <= maxNodes) return "full";
  if (nodeCount <= maxNodes * 2) return "compact";
  return "dot";
}

export function collapseFleetGraph(graph: FleetGraph, opts: CollapseOpts = {}): LegibleGraph {
  const minGroup = opts.minGroup ?? 3;
  const maxNodes = opts.maxNodes ?? 24;

  const children = new Map<string, FleetGraphNode[]>();
  for (const n of graph.nodes) {
    if (n.spawnedBy == null) continue;
    const bucket = children.get(n.spawnedBy);
    if (bucket) bucket.push(n);
    else children.set(n.spawnedBy, [n]);
  }

  // 1. aggregate-by-name — bucket by (parent, role); a bucket of >= minGroup
  //    roled siblings folds into one group node.
  const byParentRole = new Map<string, FleetGraphNode[]>();
  for (const n of graph.nodes) {
    if (n.role === "") continue; // roleless nodes (roots without a role) never group
    const key = `${n.spawnedBy ?? " root"} ${n.role}`;
    const bucket = byParentRole.get(key);
    if (bucket) bucket.push(n);
    else byParentRole.set(key, [n]);
  }

  const rep = new Map<string, string>();
  const grouped = new Set<string>();
  const groupById = new Map<string, LegibleNode>();

  for (const members of byParentRole.values()) {
    if (members.length < minGroup) continue;
    const first = members[0];
    const gid = `group:${first.spawnedBy ?? "root"}:${first.role}`;
    const group: LegibleNode = {
      id: gid, kind: "group", role: first.role, cluster: first.role,
      count: members.length, members: members.map((m) => m.id), descendants: [],
      connected: false, epoch: 0, state: "idle", pendingGate: false,
      spawnedBy: first.spawnedBy, inTokens: 0, outTokens: 0,
    };
    for (const m of members) {
      absorbInto(group, m);
      rep.set(m.id, gid);
      grouped.add(m.id);
    }
    groupById.set(gid, group);
  }

  // 2. subtree roll-up — walk the subtree under each collapsed member; absorb
  //    every UNGROUPED descendant into the group (a descendant that forms its
  //    own group stays a separate node and just re-parents under this group).
  const absorbed = new Set<string>();
  for (const group of groupById.values()) {
    const queue = [...group.members];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      for (const child of children.get(parentId) ?? []) {
        if (grouped.has(child.id) || absorbed.has(child.id)) continue; // its own group, or already taken
        absorbed.add(child.id);
        rep.set(child.id, group.id);
        group.descendants.push(child.id);
        absorbInto(group, child);
        queue.push(child.id); // transitively absorb its subtree
      }
    }
  }

  // Emit: group nodes + the agents that were neither grouped nor absorbed.
  const outNodes: LegibleNode[] = [...groupById.values()];
  for (const n of graph.nodes) {
    if (grouped.has(n.id) || absorbed.has(n.id)) continue;
    rep.set(n.id, n.id);
    outNodes.push(asAgent(n));
  }

  // Re-parent every emitted node through rep so nested groups point at the
  // group they live under (rep is fully populated by now).
  for (const node of outNodes) {
    if (node.spawnedBy != null) {
      node.spawnedBy = rep.get(node.spawnedBy) ?? node.spawnedBy;
    }
  }

  const edges = rerouteEdges(graph.edges, rep);
  return { nodes: outNodes, edges, detail: detailFor(outNodes.length, maxNodes) };
}
