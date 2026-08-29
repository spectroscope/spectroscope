// Card 302: a workflow run, read as a state graph.
//
// A workflow run and a state graph are the same PATTERN and not the same
// TOOL. A state graph is an artefact somebody DECLARED; a workflow run is a
// script plus what happened to it. So this file shares the ENGINE — the same
// `layoutStateGraph`, the same `lifecycleAt` fold — and touches nothing on the
// state graph's own surface.
//
// THE SHAPE, and the one thing the first attempt got wrong. THE PHASE IS THE
// NODE. The declared phases are the boxes, and the EDGE MEANS WHAT FOLLOWS
// WHAT: main → phase 1 → phase 2 → …, a straight chain, one edge per step.
// The agents live INSIDE their phase box, listed with their label, their
// state and their model — so a fan-out reads as "this phase holds five", the
// way the workflow panel already shows a run.
//
// The first attempt made every AGENT a node and hung each one off the root.
// Thirteen arcs flew across the canvas in nested loops and said something
// false: that the root started all thirteen at once, and that no phase led to
// any other. The spawn relation is the right edge for a Task tree (card 293),
// where the root genuinely did spawn each child. For a workflow it is not:
// the phases come out of one another, and that succession is the whole point.
//
// Pure on purpose: no DOM, no React, no IO. The caller hands in the text of a
// run's `workflows/wf_<runId>.json`; this hands back exactly what the engine
// eats.

import type { RankCaption, Topology, TopologyEdge } from "../stategraph/layout";
import type { Lifecycle, LifecycleTypes, TimelineRecord } from "../stategraph/artifact";

/**
 * What THIS producer calls the three moments — deliberately not the graph
 * dialect's `node_start`. A phase of a workflow is not a node in a compiled
 * graph, and a record that borrowed the other file's word would invite a
 * reader to fold the two files together.
 */
export const WORKFLOW_LIFECYCLE: LifecycleTypes = {
  start: "wf_phase_start",
  end: "wf_phase_end",
  error: "wf_phase_error",
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
   *  counted from zero would land in the same phases. */
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
  /** The number the FILE STATED for `phases[i]`, or null where it never said.
   *  Null is the honest answer for a file written mid-run: it has fewer phase
   *  markers than phases, and a position standing in for one of the missing
   *  numbers would be MIXED with the numbers it did state. What to do with a
   *  null is `rankOfDeclared`'s decision, in one place. */
  declaredIndex: (number | null)[];
  agents: WorkflowAgent[];
}

/** One agent as its phase box lists it. */
export interface PhaseMember {
  agentId: string;
  label: string;
  model: string | null;
  /** The file's own word, folded to the four the picture knows. */
  state: Lifecycle;
  startedAt: number | null;
  /** When it can honestly be said to have stopped, or null while it has not. */
  endedAt: number | null;
}

/** One declared phase, and who ran inside it. */
export interface WorkflowPhase {
  title: string;
  detail: string | null;
  /** In the file's own order. Empty for a phase the run never entered — which
   *  is a fact worth drawing, not a reason to leave the box out. */
  members: PhaseMember[];
}

/** What ONE run declared about itself, and what happened inside it. */
export interface RunPhases {
  phases: WorkflowPhase[];
  /** Agents whose `phaseIndex` named no declared phase. Never dropped: they
   *  get a box of their own past the declared columns, and that box carries no
   *  edge, because nothing declared where they belong. */
  unplaced: PhaseMember[];
}

/** Every run whose state file the reader got, keyed by the node that run
 *  hangs on in the lens's picture — for the importer, the `Workflow` tool_use
 *  id the receipt came back on. */
export type WorkflowDeclaration = ReadonlyMap<string, RunPhases>;

/** The picture, ready for `layoutStateGraph` and `lifecycleAt`. */
export interface WorkflowGraph {
  topo: Topology;
  /** Sorted by time, in `WORKFLOW_LIFECYCLE`'s vocabulary, one pair per phase
   *  that was entered. A phase nobody entered has none at all, which the
   *  shared fold reads as `pending` — the "never entered" the state graph
   *  already says in that word. */
  records: TimelineRecord[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The node id of one run's phase at position `at`. Namespaced by the node the
 *  run hangs on as well as by position, so two runs that both have a second
 *  phase get two boxes, and so it can never collide with an agent id a run
 *  handed out. */
export function phaseNodeId(parent: string, at: number): string {
  return `phase:${parent}:${at}`;
}

/** The node id of one run's box for agents its own file could not place. */
export function unplacedNodeId(parent: string): string {
  return `phase:${parent}:unplaced`;
}

/** How tall a phase box has to be to hold `members` agent rows.
 *
 *  Stated here rather than left to CSS because the LAYOUT needs it: a column
 *  is packed around the heights its producer states, and a box that grew past
 *  the height it declared would be drawn through its neighbour. The renderer
 *  reads the same function, so the two cannot drift. */
export function phaseHeight(members: number): number {
  const HEADER = 22;
  const ROW = 15;
  const PAD = 10;
  return Math.max(46, HEADER + PAD + Math.max(members, 1) * ROW);
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

  // WHICH NUMBER THE FILE STATED FOR WHICH PHASE — joined through the TITLE,
  // because the title is what the file itself puts on both sides: a
  // `workflow_phase` marker carries {index, title}, a `workflow_agent`
  // carries {phaseIndex, phaseTitle}, and both titles name an entry in
  // `phases`. Measured over a real recording: five markers and thirteen
  // agents, every one of those titles matching its phase exactly.
  //
  // THE ARRAY POSITION NEVER PLACES A STATED NUMBER. A file written mid-run
  // has fewer markers than phases — a run interrupted, still going, or failed
  // on its way through — and seeding the positions and overwriting only the
  // reached ones mixes stated numbers with positional ones. Where a title
  // cannot place a number, the number stays unknown and `rankOfDeclared`
  // decides what unknown means.
  const posOfTitle = new Map<string, number | "ambiguous">();
  phases.forEach((p, i) => {
    if (p.title === "") return;
    posOfTitle.set(p.title, posOfTitle.has(p.title) ? "ambiguous" : i);
  });
  const declaredIndex: (number | null)[] = phases.map(() => null);
  const refused = new Set<number>();
  /** The file says "the phase called T is numbered N". */
  const stated = (title: string | null, index: number | null): void => {
    if (title === null || index === null) return;
    const pos = posOfTitle.get(title);
    if (pos === undefined || pos === "ambiguous" || refused.has(pos)) return;
    const had = declaredIndex[pos];
    if (had === null) {
      declaredIndex[pos] = index;
      return;
    }
    // Two different numbers for one phase: the file contradicts itself, and
    // picking one of them would be this module's guess, not the file's word.
    if (had !== index) {
      declaredIndex[pos] = null;
      refused.add(pos);
    }
  };

  const progress = Array.isArray(d.workflowProgress) ? d.workflowProgress : [];
  const agents: WorkflowAgent[] = [];
  for (const entry of progress) {
    if (entry === null || typeof entry !== "object") continue;
    const o = entry as Record<string, unknown>;
    if (o.type === "workflow_phase") {
      stated(str(o.title), num(o.index));
      continue;
    }
    if (o.type !== "workflow_agent") continue;
    stated(str(o.phaseTitle), num(o.phaseIndex));
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

/**
 * The file's own phase numbering → the phase's 0-based position.
 *
 * Built ONLY from numbers the file stated. When it stated none at all, and
 * only then, each phase's array position stands in for its number: a uniform
 * fallback, never mixed with a number the file did state. A number two
 * different phases both claim is refused rather than resolved — an agent
 * standing under a borrowed word is worse than an agent in the box past the
 * declared ones, where nothing is claimed about it at all.
 */
function positionOfStated(state: WorkflowState): ReadonlyMap<number, number> {
  const at = new Map<number, number>();
  const contested = new Set<number>();
  let anyStated = false;
  state.declaredIndex.forEach((stated, pos) => {
    if (stated === null) return;
    anyStated = true;
    if (contested.has(stated)) return;
    const had = at.get(stated);
    if (had === undefined) {
      at.set(stated, pos);
      return;
    }
    if (had !== pos) {
      at.delete(stated);
      contested.add(stated);
    }
  });
  if (!anyStated) state.phases.forEach((_, pos) => at.set(pos, pos));
  return at;
}

/** When an agent that started can honestly be said to have stopped: its own
 *  duration where the file gave one, else the last progress it reported,
 *  else the moment it started — never a number this module invented. */
function endStamp(a: WorkflowAgent, started: number): number {
  if (a.durationMs !== null) return started + a.durationMs;
  return a.lastProgressAt ?? started;
}

/**
 * One agent's own word, folded to the four the picture knows.
 *
 * An agent with no `startedAt` is PENDING whatever else the file says: it was
 * queued and never entered, and the file has no word of its own for that. A
 * word this file has never used is pending too, not a guess.
 */
export function agentLifecycle(a: WorkflowAgent): Lifecycle {
  if (a.startedAt === null) return "pending";
  if (a.state === "done") return "done";
  if (a.state === "error") return "error";
  return "active";
}

/**
 * A phase's lifecycle, folded from its agents.
 *
 * ERROR FIRST, and deliberately: a failure is the fact a viewer must not lose
 * while a neighbour runs on. After that the reading is the obvious one — all
 * still queued (or none at all) is pending, all finished is done, anything in
 * between has been entered and is running.
 */
export function foldPhase(members: readonly { state: Lifecycle }[]): Lifecycle {
  if (members.some((m) => m.state === "error")) return "error";
  if (members.every((m) => m.state === "pending")) return "pending";
  if (members.every((m) => m.state === "done")) return "done";
  return "active";
}

/** One run's state file → its phases with their agents inside them. */
export function declarationFor(state: WorkflowState): RunPhases {
  const positionOf = positionOfStated(state);
  const phases: WorkflowPhase[] = state.phases.map((p) => ({
    title: p.title,
    detail: p.detail,
    members: [],
  }));
  const unplaced: PhaseMember[] = [];
  for (const a of state.agents) {
    const started = a.startedAt;
    const member: PhaseMember = {
      agentId: a.agentId,
      label: a.label !== "" ? a.label : a.agentId,
      model: a.model,
      state: agentLifecycle(a),
      startedAt: started,
      endedAt: started === null ? null : endStamp(a, started),
    };
    const at = a.phaseIndex === null ? undefined : positionOf.get(a.phaseIndex);
    if (at === undefined || phases[at] === undefined) unplaced.push(member);
    else phases[at].members.push(member);
  }
  return { phases, unplaced };
}

/**
 * (one run's phases) → the topology and records the state-graph engine eats.
 *
 * NODES ARE PHASES and EDGES ARE SUCCESSION: `parent → phase 0 → phase 1 → …`,
 * one edge per step and nothing else out of the parent. `direct`, because the
 * order was declared before the run started — the lens draws that solid, and
 * keeps its dash for the spawn relations it had to reconstruct.
 *
 * @param run what the state file declared and recorded
 * @param parent the node the run hangs on ("main" for a run read on its own)
 */
export function workflowGraph(run: RunPhases, parent: string): WorkflowGraph {
  const nodes: Topology["nodes"] = [{ id: parent, label: parent }];
  const edges: TopologyEdge[] = [];
  const ranks = new Map<string, number>([[parent, 0]]);
  const heights = new Map<string, number>();
  const rankCaptions = new Map<number, RankCaption>();
  const records: TimelineRecord[] = [];

  run.phases.forEach((p, i) => {
    const id = phaseNodeId(parent, i);
    nodes.push({ id, label: p.title });
    ranks.set(id, i + 1);
    heights.set(id, phaseHeight(p.members.length));
    rankCaptions.set(i + 1, { title: p.title, detail: p.detail });
    edges.push({ from: i === 0 ? parent : phaseNodeId(parent, i - 1), to: id, kind: "direct" });

    // The records are the fold's own answer, expressed in this producer's
    // three words — one truth, two readings, and `workflowGraph.test.ts` pins
    // that `lifecycleAt` and `foldPhase` agree on all four.
    const life = foldPhase(p.members);
    if (life === "pending") return;
    const started = p.members
      .map((m) => m.startedAt)
      .filter((t): t is number => t !== null)
      .reduce((a, b) => Math.min(a, b), Infinity);
    if (!Number.isFinite(started)) return;
    records.push({ type: WORKFLOW_LIFECYCLE.start, ts: started, node: id });
    if (life === "active") return;
    const ended = p.members
      .map((m) => m.endedAt)
      .filter((t): t is number => t !== null)
      .reduce((a, b) => Math.max(a, b), started);
    records.push({
      type: life === "done" ? WORKFLOW_LIFECYCLE.end : WORKFLOW_LIFECYCLE.error,
      ts: ended,
      node: id,
    });
  });

  // The agents the file could not place get a box past the declared columns
  // and NO edge into it. An edge would claim a succession the script never
  // declared; an unattached box claims only that these agents exist and that
  // the file did not say where they belong.
  if (run.unplaced.length > 0) {
    const id = unplacedNodeId(parent);
    nodes.push({ id, label: "" });
    ranks.set(id, run.phases.length + 1);
    heights.set(id, phaseHeight(run.unplaced.length));
  }

  records.sort((a, b) => a.ts - b.ts);
  return { topo: { entry: parent, nodes, edges, ranks, rankCaptions, heights }, records };
}
