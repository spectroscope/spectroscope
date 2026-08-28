// The workflow lens's reconstruction (card 293): (the run's events) → a
// Topology for the UNCHANGED layoutStateGraph. Pure, DOM-free.
//
// OWNER CALL, variant C (2026-08-28, decided in chat): an edge is the REAL
// spawn relation — parent → child — and the POSITION carries time. Nodes sit
// in their time-overlap waves (children whose lifetimes overlap share a
// column), handed to the layout as its rank override instead of being
// encoded into the edge set. Both truths live in one picture, neither lies.
// This replaces the earlier wave-edge encoding, which drew synthesized
// precedence edges ("these ended, then this began") while the real parent
// edge went undrawn for every wave past the first.
//
// Every edge is still a reconstruction from what happened, not a declaration
// from before the run — the `spawn` kind, drawn dashed.
//
// Honesty is counted, not implied: `reported` is the number of children the
// run's agent_spawn events named (M), `resolved` how many of them named a
// parent that actually appears in the run (N). A child whose parent never
// appears still shows — attached to the root — and counts as unresolved.

import type { RunEvent } from "../events";
import type { Topology } from "../stategraph/layout";
import { clipMiddle, type Scene } from "./labScene";

export interface SpawnNodeMeta {
  /** Short card label: the task as the requester phrased it, clipped. */
  label: string;
  /** The agent type from the task message's label ("app-scout", …), if any. */
  agentType: string | null;
  /** The child's model, when its own run_start said one. Null = unknown. */
  model: string | null;
  /** False for a child whose reported parent never appeared in the run. */
  parentResolved: boolean;
}

export interface SpawnTree {
  /** Ready for layoutStateGraph — every edge carries the `spawn` kind, and
   *  `ranks` carries the time-overlap waves as the layout's rank override. */
  topo: Topology;
  /** Per node id, the root included. */
  meta: Record<string, SpawnNodeMeta>;
  /** M — children the run's agent_spawn events reported (distinct ids). */
  reported: number;
  /** N — reported children whose parent edge resolved to a known agent. */
  resolved: number;
  /** The root's node id ("main" unless the root run_start says otherwise). */
  root: string;
}

const DEFAULT_ROOT = "main";
const LABEL_MAX = 28;

interface ChildRecord {
  id: string;
  parentId: string;
  task: string;
  start: number;
  end: number;
  agentType: string | null;
  model: string | null;
}

/** Build the reconstructed workflow topology from the FULL event list. */
export function spawnTree(events: RunEvent[]): SpawnTree {
  // The root: the first run_start that reports no parent. Falls back to
  // "main" so an event-less call still yields a drawable lone root.
  let root = DEFAULT_ROOT;
  for (const e of events) {
    if (e.type === "run_start" && e.parentId === undefined) {
      root = e.agentId;
      break;
    }
  }

  // One pass: children in first-spawn order, lifetimes, labels, models.
  const children = new Map<string, ChildRecord>();
  for (const e of events) {
    if (e.type === "agent_spawn" && e.agentId !== root && !children.has(e.agentId)) {
      children.set(e.agentId, {
        id: e.agentId,
        parentId: e.parentId,
        task: e.task,
        start: e.ts,
        end: e.ts,
        agentType: null,
        model: null,
      });
      continue;
    }
    const touched =
      "agentId" in e && typeof e.agentId === "string" && children.has(e.agentId)
        ? children.get(e.agentId)!
        : e.type === "agent_message" && children.has(e.from)
          ? children.get(e.from)!
          : null;
    if (touched !== null) touched.end = Math.max(touched.end, e.ts);
    if (e.type === "agent_message" && e.role === "task" && children.has(e.to)) {
      const c = children.get(e.to)!;
      if (e.label !== undefined) c.agentType = e.label;
      if (c.task === "" && e.text !== "") c.task = e.text;
      c.end = Math.max(c.end, e.ts);
    }
    if (e.type === "run_start" && children.has(e.agentId) && e.model !== undefined) {
      children.get(e.agentId)!.model = e.model;
    }
  }

  const known = new Set<string>([root, ...children.keys()]);
  const resolvedOf = (c: ChildRecord): boolean => c.parentId === root || known.has(c.parentId);

  // Position carries time (variant C): every child drawn off the root — a
  // direct child, or one whose reported parent never appeared — joins the
  // wave grouping, in start order. A new wave opens when a child starts
  // after everything in the wave before it has ended.
  const offRoot = [...children.values()]
    .filter((c) => c.parentId === root || !known.has(c.parentId))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  const ranks = new Map<string, number>([[root, 0]]);
  let wave = 0;
  let waveEnd = -Infinity;
  for (const c of offRoot) {
    if (wave === 0 || c.start > waveEnd) {
      wave += 1;
      waveEnd = c.end;
    } else {
      waveEnd = Math.max(waveEnd, c.end);
    }
    ranks.set(c.id, wave);
  }
  // A nested child overlaps its parent by construction, so a time wave
  // cannot separate them — it ranks one step past its parent instead. The
  // pre-set 1 is the cycle guard: a malformed parent chain stops there
  // instead of recursing forever.
  const rankOf = (c: ChildRecord): number => {
    const got = ranks.get(c.id);
    if (got !== undefined) return got;
    ranks.set(c.id, 1);
    const parent = children.get(c.parentId);
    const r = parent === undefined ? 1 : rankOf(parent) + 1;
    ranks.set(c.id, r);
    return r;
  };
  for (const c of children.values()) rankOf(c);

  // The real spawn relation, one edge per child: from its parent when that
  // parent appears in the run, from the root when it does not.
  const edges: Topology["edges"] = [...children.values()].map((c) => ({
    from: known.has(c.parentId) ? c.parentId : root,
    to: c.id,
    kind: "spawn" as const,
  }));

  const meta: Record<string, SpawnNodeMeta> = {
    [root]: { label: root, agentType: null, model: null, parentResolved: true },
  };
  const nodes: Topology["nodes"] = [{ id: root, label: root }];
  for (const c of children.values()) {
    const label = c.task !== "" ? clipMiddle(c.task, LABEL_MAX) : c.id;
    meta[c.id] = { label, agentType: c.agentType, model: c.model, parentResolved: resolvedOf(c) };
    nodes.push({ id: c.id, label });
  }

  return {
    topo: { entry: root, nodes, edges, ranks },
    meta,
    reported: children.size,
    resolved: [...children.values()].filter(resolvedOf).length,
    root,
  };
}

/** Which agents have APPEARED in this event prefix — the root once its
 *  run_start is applied, a child once its spawn (or own run_start) is. */
export function spawnedIn(events: RunEvent[]): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type === "agent_spawn" || e.type === "run_start") seen.add(e.agentId);
  }
  return seen;
}

export type WorkflowNodeState = "pending" | "active" | "done" | "failed";

/** The last result-message state per child in this event prefix — the same
 *  completed/failed mapping the scene fold applies. Once the root run_end
 *  retires the scene's subagents, this map is what still remembers HOW each
 *  child ended; without it an IMPORTED run (complete, resting cursor at the
 *  end) could never show a failed child. */
export function terminalStatesIn(events: RunEvent[]): ReadonlyMap<string, "completed" | "failed"> {
  const last = new Map<string, "completed" | "failed">();
  for (const e of events) {
    if (e.type === "agent_message" && e.role === "result") {
      last.set(e.from, e.state === "completed" ? "completed" : "failed");
    }
  }
  return last;
}

/** The cursor lights the graph from the ONE scene fold the machine lens
 *  reads — no second scene fold. A node the scene still carries answers from
 *  its lifecycle; one the scene no longer carries (the root run ended)
 *  answers from its terminal state, then from having appeared at all:
 *  failed stays failed, otherwise done if it ever appeared, pending if the
 *  cursor has not reached it yet. */
export function nodeStateAt(
  scene: Scene,
  spawned: ReadonlySet<string>,
  terminal: ReadonlyMap<string, "completed" | "failed">,
  id: string,
  root: string,
): WorkflowNodeState {
  const sub = scene.subagents.find((c) => c.id === id);
  if (sub !== undefined) {
    if (sub.state === "completed") return "done";
    if (sub.state === "failed") return "failed";
    return "active";
  }
  if (id === root && scene.rootRunId !== null) return "active";
  const end = terminal.get(id);
  if (end !== undefined) return end === "failed" ? "failed" : "done";
  return spawned.has(id) ? "done" : "pending";
}
