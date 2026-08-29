// The workflow lens's picture: (the run's events, and what it declared) → a
// Topology for the UNCHANGED layoutStateGraph. Pure, DOM-free.
//
// TWO LANGUAGES, and the lens says which one it drew.
//
// RECOVERED (card 293, owner call variant C): for a run that declared nothing
// — every plain Task spawn tree — an edge is the REAL spawn relation, parent →
// child, and the POSITION carries time. Children whose lifetimes overlap share
// a column, handed to the layout as its rank override rather than encoded into
// the edge set. Every one of those edges is a reconstruction from what
// happened, so they are drawn DASHED.
//
// DECLARED (card 302): for a run whose own state file named its phases, THE
// PHASE IS THE NODE and the edge means WHAT FOLLOWS WHAT — run → phase 0 →
// phase 1 → …, one edge per step, solid, and the agents live INSIDE the phase
// box they belong to. A fan-out then reads as "this phase holds five", which
// is how the workflow panel has always shown a run.
//
// THE RULE, AND WHY IT IS THIS WAY ROUND. This file's header used to say the
// waves come from the timestamps and from nothing else, and that where a
// declared phase and a derived wave disagree the picture shows the derived one
// "because that is what the run actually did". That is backwards. A workflow's
// phases sit in its script BEFORE a token flows; a wave is guessed AFTERWARDS
// from stamps that a slow start or a long tail moves. The declaration is the
// earlier and the firmer fact, so it WINS, and the waves are the fallback for
// a run that declared nothing.
//
// AND IT IS PER NODE, NOT PER TREE. One run can hold both: a declared workflow
// and, beside it, plain Task children whose columns are still a guess. So the
// stroke is decided per edge, and a column a guess also stands in loses the
// script's word.
//
// Honesty is counted, not implied: `reported` is the number of children the
// run's agent_spawn events named (M), `resolved` how many of them named a
// parent that actually appears in the run (N). Those two stay statements about
// the EVENTS even where the picture draws phases — a child whose parent never
// appears still counts as unresolved.

import type { RunEvent } from "../events";
import type { RankCaption, Topology } from "../stategraph/layout";
import type { Lifecycle } from "../stategraph/artifact";
import {
  foldPhase,
  phaseHeight,
  phaseNodeId,
  unplacedNodeId,
  type PhaseMember,
  type WorkflowDeclaration,
  type WorkflowPhase,
} from "./workflowGraph";
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
  /** Card 302: what a PHASE box holds, in the state file's own order. Empty
   *  for every node that is an agent — only a phase holds anybody. */
  members: PhaseMemberRow[];
}

/** One agent row inside a phase box. */
export interface PhaseMemberRow {
  agentId: string;
  label: string;
  model: string | null;
  /** What the run's own state file said about this agent. The lens prefers
   *  the CURSOR's answer wherever the event stream carries the agent, and
   *  falls back to this for one no transcript recorded. */
  declared: Lifecycle;
}

export interface SpawnTree {
  /** Ready for layoutStateGraph. A reconstructed edge carries the `spawn`
   *  kind, a declared succession carries `direct`; `ranks` carries the
   *  columns (declared phases, else time-overlap waves) as the layout's rank
   *  override, and `heights` how tall each phase box has to be. */
  topo: Topology;
  /** Per node id, the root included. */
  meta: Record<string, SpawnNodeMeta>;
  /** M — children the run's agent_spawn events reported (distinct ids). */
  reported: number;
  /** N — reported children whose parent edge resolved to a known agent. */
  resolved: number;
  /** The root's node id ("main" unless the root run_start says otherwise). */
  root: string;
  /** True when anything on screen came from a DECLARATION rather than from
   *  the time-overlap guess — the one bit the legend needs to say which of the
   *  two pictures a viewer is looking at. Exactly `declaredNodes.size > 0`. */
  declared: boolean;
  /** The nodes a declaration PLACED — the agents a run's script named, and the
   *  boxes standing for phases it named and never filled. Per node, not per
   *  tree: a workflow can share a run with plain Task children whose columns
   *  are still a guess, and the lens draws the stroke of each edge from THIS
   *  set. Everything outside it keeps card 293's dash. */
  declaredNodes: ReadonlySet<string>;
  /** Every node that is a PHASE BOX rather than an agent — the declared
   *  phases and, where the file could not place somebody, the box past them.
   *  Wider than `declaredNodes` by exactly that last box: it is drawn, but
   *  nothing declared it, so it must not borrow the declared stroke. */
  phaseNodes: ReadonlySet<string>;
  /** Every agent id the event stream named. A phase box lights each of its
   *  rows from the CURSOR when the id is in here, and from the run's own
   *  state file when it is not — a state file names every agent it launched,
   *  an import only carries the ones whose transcript was picked. */
  knownAgents: ReadonlySet<string>;
}

const LABEL_MAX = 28;

/** The node id of one run's declared phase — re-exported from the reader so
 *  the lens and the reader cannot end up with two id schemes for one box. */
export const lensPhaseNodeId = phaseNodeId;

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
  //
  // AND IT IS PER NODE, NOT PER TREE. One run can hold both: a declared
  // workflow and, beside it, plain Task children whose columns are still a
  // guess. `declaredNodes` is therefore the unit the lens draws from — the
  // stroke of every edge, and whether a column may keep the script's word.
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
  /** The nodes a declaration placed — every phase box, and nothing else.
   *  Everything outside this set got its column from the time-overlap guess
   *  and says so in its stroke. */
  const declaredNodes = new Set<string>();
  /** How tall each phase box has to be, for the layout to pack around. */
  const heights = new Map<string, number>();
  /** The phase boxes, in draw order, with what each one holds. */
  const phaseNodes: { id: string; label: string; members: PhaseMemberRow[] }[] = [];
  /** run node → its chain of phase box ids, so the edges can be laid after. */
  const chains = new Map<string, string[]>();
  /** Agents a declaration swallowed: they are rows inside a box now, not
   *  nodes, and no edge may be drawn for them. */
  const absorbed = new Set<string>();
  const claim = (r: number, title: string, detail: string | null): void => {
    if (contested.has(r)) return;
    const had = rankCaptions.get(r);
    if (had === undefined) {
      rankCaptions.set(r, { title, detail });
      return;
    }
    if (had.title === title && had.detail === detail) return;
    rankCaptions.delete(r);
    contested.add(r);
  };
  // A declaration that named no label falls back to the task the STREAM gave
  // that agent, and only then to the raw id. A scenario declares ids and lets
  // the run name them; a state file names them itself.
  const rowsOf = (members: readonly PhaseMember[]): PhaseMemberRow[] =>
    members.map((m) => {
      const seen = children.get(m.agentId);
      const fromStream = seen !== undefined && seen.task !== "" ? clipMiddle(seen.task, LABEL_MAX) : null;
      return {
        agentId: m.agentId,
        label: m.label !== "" ? m.label : (fromStream ?? m.agentId),
        model: m.model ?? seen?.model ?? null,
        declared: m.state,
      };
    });
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
      // THE PHASE IS THE NODE. One box per declared phase, opening at
      // base + 1 in the script's own order, holding the agents that ran in
      // it. A phase the script promised and the run never filled still gets
      // its box: a picture that left the column out would quietly rewrite the
      // plan to match what happened, which is the one thing a declared column
      // is there to stop.
      const chain: string[] = [];
      said.phases.forEach((phase: WorkflowPhase, i: number) => {
        const id = phaseNodeId(parent, i);
        const rows = rowsOf(phase.members);
        ranks.set(id, base + 1 + i);
        declaredNodes.add(id);
        heights.set(id, phaseHeight(rows.length));
        phaseNodes.push({ id, label: phase.title, members: rows });
        chain.push(id);
        claim(base + 1 + i, phase.title, phase.detail);
        for (const m of phase.members) absorbed.add(m.agentId);
      });
      chains.set(parent, chain);
      // Agents the file itself could not place get ONE box past the declared
      // columns, uncaptioned and unattached: an edge would claim a succession
      // nobody declared, an unattached box claims only that they exist.
      if (said.unplaced.length > 0) {
        const id = unplacedNodeId(parent);
        const rows = rowsOf(said.unplaced);
        ranks.set(id, base + 1 + said.phases.length);
        heights.set(id, phaseHeight(rows.length));
        phaseNodes.push({ id, label: "", members: rows });
        for (const m of said.unplaced) absorbed.add(m.agentId);
      }
      // A child of this run the declaration never mentioned at all is NOT
      // absorbed — it keeps its own node and its reconstructed spawn edge,
      // in the wave the stamps put it in, because that is all anybody knows
      // about it.
      let wave = 0;
      let waveEnd = -Infinity;
      for (const c of kids) {
        if (absorbed.has(c.id)) continue;
        if (wave === 0 || c.start > waveEnd) {
          wave += 1;
          waveEnd = c.end;
        } else {
          waveEnd = Math.max(waveEnd, c.end);
        }
        if (!ranks.has(c.id)) ranks.set(c.id, base + wave);
        queue.push(c.id);
      }
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
  // one step off the root, rather than being left without a rank. An ABSORBED
  // child is not one of those: it is a row in a phase box and has no node, so
  // giving it a rank here would put a phantom in column 1 — and (measured on
  // the shipped scenario) strip that column of the script's own word, because
  // an unclaimed node standing in a column is exactly what makes the caption
  // ambiguous.
  for (const c of children.values()) {
    if (!ranks.has(c.id) && !absorbed.has(c.id)) ranks.set(c.id, 1);
  }

  // A COLUMN A GUESS ALSO STANDS IN LOSES THE SCRIPT'S WORD. The declaration
  // governs where its own run's agents go; it says nothing about the root's
  // other children, and their waves land on the very same ranks — measured:
  // main spawning a declared three-phase workflow plus two plain Task
  // siblings put each sibling inside a column captioned with the script's own
  // words. One word over two meanings is the same lie `contested` already
  // refuses between two runs, so it is refused here for the same reason and
  // in the same vocabulary: an unnamed column is only a column.
  // (The walk is over, so this deletes rather than going through `contested`,
  // which is the same refusal applied while the walk is still claiming.)
  for (const [id, r] of ranks) {
    if (!declaredNodes.has(id)) rankCaptions.delete(r);
  }

  // THE EDGES, in two languages.
  //
  // RECONSTRUCTED: the real spawn relation, one dashed edge per child that is
  // still a node — from its parent when that parent appears in the run, from
  // the root when it does not. An agent a declaration swallowed is a ROW in a
  // phase box now, not a node, so it gets none: an edge to a box that is not
  // drawn is the thirteen-arcs defect in another form.
  //
  // DECLARED: the succession, run → phase 0 → phase 1 → …, one `direct` edge
  // per step. This is the whole correction card 302 exists for. The phases
  // come out of one another; the run did not start all of them at once.
  const edges: Topology["edges"] = [...children.values()]
    .filter((c) => !absorbed.has(c.id))
    .map((c) => ({
      from: known.has(c.parentId) ? c.parentId : root,
      to: c.id,
      kind: "spawn" as const,
    }));
  for (const [parent, chain] of chains) {
    chain.forEach((id, i) => {
      edges.push({ from: i === 0 ? parent : chain[i - 1], to: id, kind: "direct" });
    });
  }

  const meta: Record<string, SpawnNodeMeta> = {
    [root]: { label: root, agentType: null, model: null, parentResolved: true, members: [] },
  };
  const nodes: Topology["nodes"] = [{ id: root, label: root }];
  for (const c of children.values()) {
    if (absorbed.has(c.id)) continue;
    const label = c.task !== "" ? clipMiddle(c.task, LABEL_MAX) : c.id;
    meta[c.id] = {
      label,
      agentType: c.agentType,
      model: c.model,
      parentResolved: resolvedOf(c),
      members: [],
    };
    nodes.push({ id: c.id, label });
  }
  for (const p of phaseNodes) {
    // parentResolved is true because there is nothing here that FAILED to
    // resolve: this box is a declaration, not a child whose parent went
    // missing, and it is deliberately absent from `reported`/`resolved`,
    // which stay statements about the events.
    meta[p.id] = {
      label: p.label,
      agentType: null,
      model: null,
      parentResolved: true,
      members: p.members,
    };
    nodes.push({ id: p.id, label: p.label });
  }

  return {
    topo: { entry: root, nodes, edges, ranks, rankCaptions, heights },
    meta,
    declared: declaredNodes.size > 0,
    declaredNodes,
    reported: children.size,
    resolved: [...children.values()].filter(resolvedOf).length,
    root,
    phaseNodes: new Set(phaseNodes.map((p) => p.id)),
    knownAgents: new Set(children.keys()),
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

/** The four words the picture uses ↔ the four the fold uses. `failed` and
 *  `error` are the same fact under two names, one inherited from card 293's
 *  card and one from the state graph's lifecycle. */
const asLifecycle = (s: WorkflowNodeState): Lifecycle => (s === "failed" ? "error" : s);
const asNodeState = (l: Lifecycle): WorkflowNodeState => (l === "error" ? "failed" : l);

/**
 * A PHASE box's state, folded from the agents inside it (card 302).
 *
 * Each row answers from the CURSOR where the event stream carries that agent,
 * and from the run's own state file where it does not — a state file names
 * every agent the run launched, while an import only carries the ones whose
 * transcript came with the pick, and reading those as "pending" forever would
 * be a lie about a finished run.
 *
 * The fold itself is `foldPhase`, shared with the reader, so the lens and the
 * reader cannot disagree about what a phase full of these agents means.
 */
export function phaseStateAt(
  scene: Scene,
  spawned: ReadonlySet<string>,
  terminal: ReadonlyMap<string, "completed" | "failed">,
  tree: SpawnTree,
  id: string,
): WorkflowNodeState {
  const members = tree.meta[id]?.members ?? [];
  return asNodeState(
    foldPhase(
      members.map((m) => ({
        state: tree.knownAgents.has(m.agentId)
          ? asLifecycle(nodeStateAt(scene, spawned, terminal, m.agentId, tree.root))
          : m.declared,
      })),
    ),
  );
}
