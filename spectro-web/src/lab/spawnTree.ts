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
import type { RankCaption, Topology } from "../stategraph/layout";
import type { DeclaredPhase, WorkflowDeclaration } from "./workflowGraph";
import { foldAgents, type AgentRecord } from "./agentDirectory";
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
  /** True when at least one parent's columns came from a DECLARATION rather
   *  than from the time-overlap guess — the one bit the legend needs to say
   *  which of the two pictures a viewer is looking at. */
  declared: boolean;
}

const LABEL_MAX = 28;

/** The node id standing for a DECLARED phase this run never filled (card
 *  302). Namespaced by its parent as well as its position, so two runs that
 *  each skipped their second phase get two boxes and not one shared one, and
 *  so it can never collide with an agent id the run handed out. */
export function lensPhaseNodeId(parent: string, at: number): string {
  return `phase:${parent}:${at}`;
}

/** The slice of the shared fold this lens keeps: the children an agent_spawn
 *  frame actually reported. Card 298 moved the fold itself into
 *  agentDirectory.ts so the directory and this lens read ONE identity pass;
 *  filtering to `spawned` here is what keeps `reported` meaning exactly what
 *  its doc comment says it means.
 *
 *  ONE THING THE MOVE CHANGED, deliberately and pinned. The shared fold opens a
 *  record at FIRST APPEARANCE, not at the spawn frame, so a task message that
 *  names a child before its spawn arrives now decides that child's position in
 *  `nodes`/`edges` and gives it its label. The old fold dropped such a message
 *  (the child was not in its map yet) and the card printed the opaque id
 *  instead. Both halves are held by "lets a task message that arrives before
 *  the spawn frame name the child". Not reachable from the importer, which
 *  emits the spawn first, but reachable from a hand-built stream. */
type ChildRecord = AgentRecord;

/** Build the reconstructed workflow topology from the FULL event list. */
export function spawnTree(events: RunEvent[], declared?: WorkflowDeclaration): SpawnTree {
  // ONE identity pass, shared with the directory (card 298): the root, and one
  // record per agent the stream named. This lens keeps the reported children.
  const fold = foldAgents(events);
  const root = fold.root;
  const children = new Map<string, ChildRecord>([...fold.agents].filter(([, c]) => c.spawned));

  const known = new Set<string>([root, ...children.keys()]);
  const resolvedOf = (c: ChildRecord): boolean => c.parentId === root || known.has(c.parentId);

  // Position carries time (variant C): a parent's children sit in their
  // time-overlap waves, in start order, and a new wave opens when a child
  // starts after everything in the wave before it has ended.
  //
  // Card 297 widened this from "children of the root" to "children of any one
  // parent". An imported workflow run is a node with its own agents under it,
  // and those agents run in phases; while the grouping admitted only the
  // root's children, every child of a workflow landed flat at
  // rank(workflow) + 1 and four sequential phases drew as one column.
  //
  // THE RULE, INVERTED BY CARD 302. Where a declared phase and a derived wave
  // disagree, the picture now shows the DECLARED one. A workflow's `phases`
  // sit in its script before a token flows; a wave is guessed afterwards from
  // stamps that a slow start or a long tail moves — so the declaration is the
  // earlier and firmer fact, and the guess is the fallback, not the other way
  // round. Card 297 had it backwards in this very comment.
  //
  // The waves stay exactly what they were for a parent nothing declared, which
  // is every Task spawn tree and every workflow whose state file the reader
  // never got. The lens says WHICH of the two a viewer is looking at rather
  // than letting the two look alike.
  const parentOf = (c: ChildRecord): string => (known.has(c.parentId) ? c.parentId : root);
  const byParent = new Map<string, ChildRecord[]>();
  for (const c of children.values()) {
    const p = parentOf(c);
    const kids = byParent.get(p);
    if (kids === undefined) byParent.set(p, [c]);
    else kids.push(c);
  }
  const ranks = new Map<string, number>([[root, 0]]);
  // The columns' words, and whether any run supplied any. A rank two runs
  // claim with DIFFERENT words gets no word at all: one name over two
  // meanings would be a lie, an unnamed column is only a column.
  const rankCaptions = new Map<number, RankCaption>();
  const contested = new Set<number>();
  let anyDeclared = false;
  /** Declared phases nobody filled — drawn, edgeless, never entered. */
  const emptyPhaseNodes: { id: string; title: string }[] = [];
  const claim = (r: number, p: DeclaredPhase): void => {
    if (contested.has(r)) return;
    const had = rankCaptions.get(r);
    if (had === undefined) {
      rankCaptions.set(r, { title: p.title, detail: p.detail });
      return;
    }
    if (had.title === p.title && had.detail === p.detail) return;
    rankCaptions.delete(r);
    contested.add(r);
  };
  // Down the tree from the root, so a parent's rank is settled before its
  // children ask for it. `seen` is the cycle guard.
  const seen = new Set<string>();
  const queue: string[] = [root];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    if (seen.has(parent)) continue;
    seen.add(parent);
    const base = ranks.get(parent) ?? 0;
    const kids = [...(byParent.get(parent) ?? [])].sort(
      (a, b) => a.start - b.start || a.id.localeCompare(b.id),
    );
    const said = declared?.get(parent);
    if (said !== undefined) {
      anyDeclared = true;
      // The declared columns open at base + 1, in the script's own order. An
      // agent the declaration never named goes one column PAST them — the
      // same place `workflowGraph` puts an undeclared agent, so the two
      // readings of the same run cannot disagree about where it belongs.
      const stray = base + 1 + said.phases.length;
      for (const c of kids) {
        const at = said.rankOf.get(c.id);
        if (!ranks.has(c.id)) ranks.set(c.id, at === undefined ? stray : base + 1 + at);
        queue.push(c.id);
      }
      said.phases.forEach((p, i) => claim(base + 1 + i, p));
      // A phase the script promised and the run never filled still gets a
      // box. A picture that simply left the column out would rewrite the plan
      // to match what happened, which is the one thing a declared column is
      // there to stop. It carries no edge — nothing spawned it — and nothing
      // ever appears under its id, so `nodeStateAt` reports it pending: the
      // "never entered" the state graph already says in that word.
      const filled = new Set(kids.map((c) => said.rankOf.get(c.id)));
      said.phases.forEach((p, i) => {
        if (filled.has(i)) return;
        const id = lensPhaseNodeId(parent, i);
        ranks.set(id, base + 1 + i);
        emptyPhaseNodes.push({ id, title: p.title });
      });
      continue;
    }
    let wave = 0;
    let waveEnd = -Infinity;
    for (const c of kids) {
      if (wave === 0 || c.start > waveEnd) {
        wave += 1;
        waveEnd = c.end;
      } else {
        waveEnd = Math.max(waveEnd, c.end);
      }
      if (!ranks.has(c.id)) ranks.set(c.id, base + wave);
      queue.push(c.id);
    }
  }
  // A child the walk never reached is in a parent cycle. It still gets drawn,
  // one step off the root, rather than being left without a rank.
  for (const c of children.values()) if (!ranks.has(c.id)) ranks.set(c.id, 1);

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
  for (const p of emptyPhaseNodes) {
    // parentResolved is true because there is nothing here that FAILED to
    // resolve: this box is a declaration, not a child whose parent went
    // missing, and it is deliberately absent from `reported`/`resolved`.
    meta[p.id] = { label: p.title, agentType: null, model: null, parentResolved: true };
    nodes.push({ id: p.id, label: p.title });
  }

  return {
    topo: { entry: root, nodes, edges, ranks, rankCaptions },
    meta,
    declared: anyDeclared,
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
