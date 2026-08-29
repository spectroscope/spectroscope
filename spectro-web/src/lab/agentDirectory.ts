// Card 298. Every agent gets a handle.
//
// THE GAP THIS CLOSES. Nothing in the canon carried a stable short name per
// agent. `agentAccent` in format.ts collapses every id that is not "main" and
// does not start with "explore"/"worker" onto ONE token, so seven children of a
// real run all render as --agent-extra and cannot be told apart; and the one
// place that did print a short tag derived it locally from a live array index
// (stationUsers' `w${i + 1}`), which is a position in the CURRENT scene, not an
// identity. A handle has to survive scrubbing, so it is folded from the event
// prefix instead.
//
// WHY THIS DOES NOT WRITE A SECOND IDENTITY FOLD. spawnTree.ts already folded
// parents, tasks, agent types and models out of the stream. Rather than copy
// that, the fold MOVED here as `foldAgents` and spawnTree now imports it and
// keeps exactly the slice it always had (`spawned` records only) — one fold,
// two readers. spawnTree's own suite is the proof that nothing about it moved.
// The directory reads the wider slice, because a child can appear without an
// agent_spawn frame ever naming it and still has to be nameable.
//
// THE PROPERTY THAT MATTERS. A tag never moves once assigned: children are
// numbered by FIRST APPEARANCE in the prefix, and a prefix only ever grows, so
// w2 is w2 at every later cursor. That is the same promise the seat pool makes
// about a card's seat — with one deliberate difference: a seat is RECYCLED when
// a child ends (seats say what was concurrent), a tag never is (a handle says
// who, and "who" does not come back as somebody else).

import type { RunEvent } from "../events";
import { clipMiddle } from "./labScene";

/** What a person may read for one agent, plus what a panel may join on. */
export interface AgentHandle {
  /** The stable short handle: "main" for the root, "w1".."wN" for children in
   *  order of first appearance. Assigned once, never reassigned. */
  tag: string;
  /** The display name, clipped to NAME_MAX: the task as the spawner phrased it,
   *  then the agent type, then the tag. NEVER the opaque agent id. */
  name: string;
  /** The parent's agent id; null for the root. An id the run never showed is
   *  still reported here — the directory does not resolve, it reports. */
  parentId: string | null;
  /**
   * Whether the RUN named that parent, or the directory defaulted it.
   *
   * `parentId` is filled in for every child, and for one that nothing spawned
   * the fill is the root — a placeholder, not a claim. A consumer that reads
   * the placeholder back as a fact about the spawn tree is stating a guess as
   * a measurement, so the difference is reported rather than left to be
   * guessed at from `parentId` alone. False for the root: it has no parent to
   * record.
   */
  parentRecorded: boolean;
  /** The task as the spawner phrased it, unclipped; null when nothing named one. */
  title: string | null;
  /** The model the agent's OWN run_start named. Absent = the run never said. */
  model?: string;
  /** Index in the prefix of the first event naming this agent, and the basis of
   *  the tag order. -1 for a root the prefix has not named yet. */
  firstSeen: number;
}

export type AgentDirectory = ReadonlyMap<string, AgentHandle>;

/** The display width of `name` — the same 24 the OS stations already clip to,
 *  so reading the name from here instead of deriving it changes no pixel. */
const NAME_MAX = 24;

const DEFAULT_ROOT = "main";
const ROOT_TAG = "main";

// ---------------------------------------------------------------------------
// The shared fold (moved here from spawnTree.ts, card 293 → 298).
// ---------------------------------------------------------------------------

/** One agent as the stream described it. `spawned` marks the records spawnTree
 *  keeps: the ones an agent_spawn frame actually reported. */
export interface AgentRecord {
  id: string;
  parentId: string;
  task: string;
  start: number;
  end: number;
  agentType: string | null;
  model: string | null;
  spawned: boolean;
  /** Whether `parentId` came from a frame (an agent_spawn, or a child run_start
   *  carrying one) or is still the default the record opened with. Wider than
   *  `spawned` on purpose: a run_start is a record of a parent even where no
   *  spawn frame exists, and spawnTree's slice is unaffected either way. */
  parentRecorded: boolean;
  firstSeen: number;
}

export interface AgentFold {
  /** The first run_start that reports no parent; "main" when none does. */
  root: string;
  /** Every agent but the root, in order of first appearance. */
  agents: Map<string, AgentRecord>;
  /** Index of the first event naming the root; -1 when none did. */
  rootFirstSeen: number;
}

/** Which agent ids one event CREATES a record for. The parent of a spawn is NOT
 *  named by it: a parent that never shows up on its own must stay unknown,
 *  which is exactly what spawnTree counts as unresolved. This is the creation
 *  rule and nothing else — it decides tag order, so widening it renumbers every
 *  handle. Lifetime is a separate question and answered separately below. */
function namedBy(e: RunEvent): string[] {
  if (e.type === "agent_message") return e.role === "task" ? [e.to] : [e.from];
  return "agentId" in e && typeof e.agentId === "string" ? [e.agentId] : [];
}

/**
 * Fold the stream into one record per agent. Pure, order-preserving, and
 * deterministic over the prefix it is given.
 */
export function foldAgents(events: readonly RunEvent[]): AgentFold {
  let root = DEFAULT_ROOT;
  for (const e of events) {
    if (e.type === "run_start" && e.parentId === undefined) {
      root = e.agentId;
      break;
    }
  }

  const agents = new Map<string, AgentRecord>();
  let rootFirstSeen = -1;
  const open = (id: string, at: number): AgentRecord | null => {
    if (id === root) {
      if (rootFirstSeen < 0) rootFirstSeen = at;
      return null;
    }
    const had = agents.get(id);
    if (had !== undefined) return had;
    const fresh: AgentRecord = {
      id,
      parentId: root,
      task: "",
      start: 0,
      end: 0,
      agentType: null,
      model: null,
      spawned: false,
      parentRecorded: false,
      firstSeen: at,
    };
    agents.set(id, fresh);
    return fresh;
  };

  events.forEach((e, at) => {
    for (const id of namedBy(e)) open(id, at);
    if (e.type === "agent_spawn" && e.agentId !== root) {
      const rec = agents.get(e.agentId)!;
      // The spawn frame is the authority on parent, task and start — whether or
      // not an earlier frame had already opened the record.
      if (!rec.spawned) {
        rec.spawned = true;
        rec.parentId = e.parentId;
        rec.parentRecorded = true;
        rec.start = e.ts;
        if (e.task !== "") rec.task = e.task;
      }
      rec.end = Math.max(rec.end, e.ts);
      return;
    }
    const touched = namedBy(e)
      .map((id) => agents.get(id))
      .find((r) => r !== undefined);
    if (touched !== undefined) touched.end = Math.max(touched.end, e.ts);
    // A message is evidence that its SENDER was alive when it was sent, and
    // `namedBy` cannot say so for a task message: it names the receiver,
    // because that is the creation rule (widening it would renumber tags).
    // So the sender's lifetime is extended here, separately. This is not
    // decoration — the importer emits a task message for every dispatch, so a
    // child that dispatches a nested subagent is only ever heard from again as
    // a sender, and spawnTree's wave grouping reads exactly these lifetimes.
    if (e.type === "agent_message") {
      const sender = agents.get(e.from);
      if (sender !== undefined) sender.end = Math.max(sender.end, e.ts);
    }
    if (e.type === "agent_message" && e.role === "task") {
      const c = agents.get(e.to);
      if (c !== undefined) {
        if (e.label !== undefined) c.agentType = e.label;
        if (c.task === "" && e.text !== "") c.task = e.text;
        // A child known only by its task message has no spawn ts to start from.
        if (!c.spawned && c.start === 0) c.start = e.ts;
      }
    }
    if (e.type === "run_start" && e.model !== undefined) {
      const c = agents.get(e.agentId);
      if (c !== undefined) c.model = e.model;
    }
    // A child's own run_start carries a parentId, and that is the run SAYING
    // who the parent is — as good a record as a spawn frame, and the only one
    // some children ever get. The spawn frame still outranks it (it is checked
    // above and sets `parentRecorded` itself), so this only ever fills a gap.
    if (e.type === "run_start" && typeof e.parentId === "string" && e.parentId !== "") {
      const c = agents.get(e.agentId);
      if (c !== undefined && !c.parentRecorded) {
        c.parentId = e.parentId;
        c.parentRecorded = true;
      }
    }
  });

  return { root, agents, rootFirstSeen };
}

// ---------------------------------------------------------------------------
// The directory
// ---------------------------------------------------------------------------

/**
 * The handle of every agent the prefix has named, keyed by agent id.
 *
 * @param events the run's events
 * @param upto   how many of them to read — the scrub cursor. Absent = all.
 *   `agentDirectory(e, k)` is exactly `agentDirectory(e.slice(0, k))`.
 */
export function agentDirectory(events: readonly RunEvent[], upto?: number): AgentDirectory {
  const prefix = upto === undefined ? events : events.slice(0, Math.max(0, upto));
  const { root, agents, rootFirstSeen } = foldAgents(prefix);

  const dir = new Map<string, AgentHandle>();
  // The root is listed even before its own first frame: it is the frame of
  // reference every other handle names as a parent, and a panel that has to ask
  // whether main exists yet has already lost the plot.
  dir.set(root, {
    tag: ROOT_TAG,
    name: ROOT_TAG,
    parentId: null,
    // Nothing to record: the root is the frame of reference, not a child.
    parentRecorded: false,
    title: null,
    firstSeen: rootFirstSeen,
  });

  let n = 0;
  for (const rec of agents.values()) {
    n += 1;
    const tag = `w${n}`;
    // Whitespace is not a name: a task of blanks counts as none at all, here
    // and in `title`, so no consumer has to re-ask the question.
    const title = rec.task.trim() !== "" ? rec.task : null;
    // Exactly the fallback the OS stations already used: task, then agent type,
    // then the tag — so the opaque id has nowhere to leak out.
    const shown = title ?? rec.agentType ?? tag;
    dir.set(rec.id, {
      tag,
      name: clipMiddle(shown, NAME_MAX),
      parentId: rec.parentId,
      parentRecorded: rec.parentRecorded,
      title,
      ...(rec.model === null ? {} : { model: rec.model }),
      firstSeen: rec.firstSeen,
    });
  }
  return dir;
}

// ---------------------------------------------------------------------------
// The colour ramp
// ---------------------------------------------------------------------------

/** How many worker slots the ramp in tokens.css carries. Past it the slots
 *  repeat: five telling-apart colours beat twelve indistinguishable ones. */
export const AGENT_RAMP_SLOTS = 5;

/**
 * The token a tag paints with — a CONSTANT var() name, never session data, so
 * it is safe to interpolate into the exported HTML the way agentAccent is.
 * w1 is the same colour on every surface because the tag, not the position,
 * picks the slot.
 *
 * "Safe to interpolate" is a claim about TWO files, and both are held to it.
 * The name is constant, so no session text can ride into the document — that is
 * this file. And the token has to EXIST in the exported document, which has no
 * stylesheet and carries `export/themes.ts` as literals instead — that is
 * agentRamp.drift.test.ts, which walks each slot into every export theme. The
 * export's own drift guard cannot ask this: it holds the table to the
 * stylesheets, never the stylesheets to the table.
 */
export function agentTagColor(tag: string): string {
  if (tag === ROOT_TAG) return "var(--agent-root)";
  const m = /^w([1-9][0-9]*)$/.exec(tag);
  if (m === null) return "var(--agent-extra)";
  return `var(--agent-w${((Number(m[1]) - 1) % AGENT_RAMP_SLOTS) + 1})`;
}
