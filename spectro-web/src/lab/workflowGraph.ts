// Card 302: a workflow run, read as a state graph.
//
// A workflow run and a state graph are the same PATTERN and not the same
// TOOL. A state graph is an artefact somebody DECLARED; a workflow DAG is a
// by-product of execution. So this file shares the ENGINE — the same
// `layoutStateGraph`, the same `lifecycleAt` fold — and touches nothing on the
// state graph's own surface.
//
// THE ONE PRECISION that shapes the picture: a workflow run is a HYBRID. Its
// fan-out is EXECUTED — how many agents a phase got is only knowable
// afterwards — but its PHASES are DECLARED: `phases` sits in the script before
// a token flows. Declared columns, executed occupancy. That is why the columns
// carry the script's own words and the boxes carry the run's.
//
// Pure on purpose: no DOM, no React, no IO. The caller hands in the text of a
// run's `workflows/wf_<runId>.json`; this hands back exactly what the engine
// eats.

import type { Topology, TopologyEdge } from "../stategraph/layout";
import type { LifecycleTypes, TimelineRecord } from "../stategraph/artifact";

/**
 * What THIS producer calls the three moments — deliberately not the graph
 * dialect's `node_start`. An agent in a phase is not a node in a compiled
 * graph, and a record that borrowed the other file's word would invite a
 * reader to fold the two files together.
 */
export const WORKFLOW_LIFECYCLE: LifecycleTypes = {
  start: "wf_agent_start",
  end: "wf_agent_end",
  error: "wf_agent_error",
};

/** One phase exactly as the script declared it, before the run began. */
export interface DeclaredPhase {
  title: string;
  detail: string | null;
}

/** One agent as the run's own state file recorded it. */
export interface WorkflowAgent {
  /** The id the state file knows it by. "" when the file named none. */
  agentId: string;
  label: string;
  /** The phase the file says it belongs to, in the FILE's numbering — which
   *  is ONE-based: measured over a real run, five phases carried `index` 1..5
   *  and thirteen agents carried `phaseIndex` 1..5, never 0. Nothing here
   *  assumes that; the join goes through the declared `index`, so a file that
   *  counted from zero would land in the same columns. */
  phaseIndex: number | null;
  phaseTitle: string | null;
  model: string | null;
  /** The run's own word for the agent's lifecycle. The vocabulary is
   *  MEASURED, not assumed: `done`, `error`, `progress`, `start` (counted over
   *  the store in `import/claudeCodeRun.ts`), and it has no word for "queued"
   *  at all — a queued agent is one with a `queuedAt` and no start. */
  state: string | null;
  queuedAt: number | null;
  startedAt: number | null;
  durationMs: number | null;
  lastProgressAt: number | null;
}

/** A run's state file, as far as this module reads it. */
export interface WorkflowState {
  name: string | null;
  phases: DeclaredPhase[];
  /** The declared number each phase carries, positionally — `phases[i]` is
   *  the phase whose `workflow_phase` entry said `index: declaredIndex[i]`.
   *  Absent entries fall back to the array position, which is the only
   *  honest guess and is never mixed with a number the file did state. */
  declaredIndex: number[];
  agents: WorkflowAgent[];
}

/** The picture, ready for `layoutStateGraph` and `lifecycleAt`. */
export interface WorkflowGraph {
  topo: Topology;
  /** Sorted by time, in `WORKFLOW_LIFECYCLE`'s vocabulary. */
  records: TimelineRecord[];
  /** Node ids that stand for a DECLARED phase no agent ever occupied. They
   *  are drawn — a phase the script promised and the run skipped is a fact,
   *  and an absent box would hide it — and they carry no records, so the
   *  shared fold reports them `pending`: the "never entered" the state graph
   *  already says in that word. */
  emptyPhases: Set<string>;
  /** Agents whose `phaseIndex` named no declared phase. They are drawn in one
   *  column past the declared ones, and that column stays uncaptioned. */
  undeclared: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The node id of a declared phase nobody occupied. Namespaced so it can
 *  never collide with an agent id the run handed out. */
export function phaseNodeId(rank: number): string {
  return `phase:${rank}`;
}

/**
 * A run's state, or null for text that is not a JSON object.
 *
 * Every field is optional. A state file written mid-run has fewer of them,
 * and a missing one degrades to "not known" — never to a guess.
 */
export function readWorkflowState(json: string): WorkflowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const d = parsed as Record<string, unknown>;

  const rawPhases = Array.isArray(d.phases) ? d.phases : [];
  const phases: DeclaredPhase[] = [];
  for (const p of rawPhases) {
    if (p === null || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    phases.push({ title: str(o.title) ?? "", detail: str(o.detail) });
  }

  const progress = Array.isArray(d.workflowProgress) ? d.workflowProgress : [];
  const declaredIndex = phases.map((_, i) => i);
  let seenPhaseEntries = 0;
  const agents: WorkflowAgent[] = [];
  for (const entry of progress) {
    if (entry === null || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (o.type === "workflow_phase") {
      const at = seenPhaseEntries++;
      const idx = num(o.index);
      if (at < declaredIndex.length && idx !== null) declaredIndex[at] = idx;
      continue;
    }
    if (o.type !== "workflow_agent") continue;
    agents.push({
      agentId: str(o.agentId) ?? "",
      label: str(o.label) ?? "",
      phaseIndex: num(o.phaseIndex),
      phaseTitle: str(o.phaseTitle),
      model: str(o.model),
      state: str(o.state),
      queuedAt: num(o.queuedAt),
      startedAt: num(o.startedAt),
      durationMs: num(o.durationMs),
      lastProgressAt: num(o.lastProgressAt),
    });
  }
  return { name: str(d.workflowName) ?? str(d.summary), phases, declaredIndex, agents };
}

/** When an agent that started can honestly be said to have stopped: its own
 *  duration where the file gave one, else the last progress it reported,
 *  else the moment it started — never a number this module invented. */
function endStamp(a: WorkflowAgent, started: number): number {
  if (a.durationMs !== null) return started + a.durationMs;
  return a.lastProgressAt ?? started;
}

/**
 * (a run's declared phases + its agents) → the topology and records the
 * state-graph engine eats.
 *
 * NODES ARE AGENTS, not phases: the fan-out is the interesting half, and a
 * five-agent phase drawn as one "Survey" box would hide exactly the thing
 * worth seeing. RANKS ARE PHASES, handed to the layout as its authoritative
 * `ranks` override, so the columns are the script's and not a longest path
 * through edges this module made up.
 */
export function workflowGraph(state: WorkflowState): WorkflowGraph {
  // The file's own phase numbering → the drawing's 0-based rank.
  const rankOfDeclared = new Map<number, number>();
  state.declaredIndex.forEach((declared, at) => {
    if (!rankOfDeclared.has(declared)) rankOfDeclared.set(declared, at);
  });
  const declaredRanks = state.phases.length;
  // One column past the declared ones for anything the file could not place.
  const strayRank = declaredRanks;

  const nodes: Topology["nodes"] = [];
  const ranks = new Map<string, number>();
  const records: TimelineRecord[] = [];
  const occupied = new Set<number>();
  let undeclared = 0;

  state.agents.forEach((a, i) => {
    const id = a.agentId !== "" ? a.agentId : `wf-agent-${i}`;
    const declared = a.phaseIndex === null ? undefined : rankOfDeclared.get(a.phaseIndex);
    const rank = declared ?? strayRank;
    if (declared === undefined) undeclared += 1;
    else occupied.add(rank);
    nodes.push({ id, label: a.label !== "" ? a.label : id });
    ranks.set(id, rank);

    // The records. An agent with no start has none at all, which the shared
    // fold reads as `pending` — a queued agent has not been entered, and a
    // synthesized start would say it had.
    const started = a.startedAt;
    if (started === null) return;
    records.push({ type: WORKFLOW_LIFECYCLE.start, ts: started, node: id });
    if (a.state === "done")
      records.push({ type: WORKFLOW_LIFECYCLE.end, ts: endStamp(a, started), node: id });
    else if (a.state === "error")
      records.push({ type: WORKFLOW_LIFECYCLE.error, ts: endStamp(a, started), node: id });
    // `progress` and `start` are NOT endings, and neither is a word this file
    // has never used. They stop at the start record, and the fold says active.
  });

  // A declared phase no agent occupied still gets a box: the script promised
  // that column, and a picture that simply skipped it would quietly rewrite
  // the plan to match what happened.
  const emptyPhases = new Set<string>();
  for (let r = 0; r < declaredRanks; r++) {
    if (occupied.has(r)) continue;
    const id = phaseNodeId(r);
    emptyPhases.add(id);
    nodes.push({ id, label: state.phases[r].title });
    ranks.set(id, r);
  }

  // Phase N to phase N+1, every box to every box: the script declares the
  // ORDER of the phases and nothing finer, so an edge between two particular
  // agents would be a claim the file never made. Solid, because that order
  // was declared before the run — see the lens's legend.
  const byRank = new Map<number, string[]>();
  for (const [id, r] of ranks) {
    const at = byRank.get(r);
    if (at === undefined) byRank.set(r, [id]);
    else at.push(id);
  }
  const edges: TopologyEdge[] = [];
  const lastRank = Math.max(declaredRanks - 1, undeclared > 0 ? strayRank : -1);
  for (let r = 0; r < lastRank; r++) {
    for (const from of byRank.get(r) ?? []) {
      for (const to of byRank.get(r + 1) ?? []) edges.push({ from, to, kind: "direct" });
    }
  }

  const rankCaptions = new Map<number, { title: string; detail: string | null }>();
  state.phases.forEach((p, r) => rankCaptions.set(r, { title: p.title, detail: p.detail }));

  records.sort((a, b) => a.ts - b.ts);
  return {
    topo: {
      entry: nodes.length > 0 ? nodes[0].id : null,
      nodes,
      edges,
      ranks,
      rankCaptions,
    },
    records,
    emptyPhases,
    undeclared,
  };
}
