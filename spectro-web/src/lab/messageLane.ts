// Card 301A: the message lane — the handovers between agents.
//
// THE GAP THIS CLOSES. An `agent_message` reaches the canon UI twice and says
// nothing either time: as a JSON row in LabTrace, and as an animated packet on
// the Fleet rail. Neither shows the TEXT, the DIRECTION, the SIZE, or the task
// the message answers. The workflow lens draws who tasked whom; it cannot draw
// what was said. This module folds exactly that, and nothing else.
//
// IT RE-DERIVES NOTHING. Three folds already exist and all three are called
// rather than reimplemented:
//   · agentDirectory (card 298) for the handle and the parent map,
//   · foldWork (state/work.ts) for a lane's name/intent/state/lastStatus and
//     its token, tool and gate counters — every one with a RunEvent behind it,
//   · groupWaves (state/work.ts) for the time-overlap phase rows.
//
// DIRECTION COMES FROM THE SPAWN TREE, NOT THE ROLE WORD. The directory's
// `parentId` is folded from the run's own agent_spawn frames, so "who tasked
// whom" is a fact about the run. The role word is a label on one message and
// can disagree with it; it is therefore the FALLBACK and only the fallback,
// used when the tree has no relation between the two ends. Every row says
// which of the two decided it (`fromTree`), because a reader is entitled to
// know whether they are looking at a fact or at a guess.
//
// AND A DEFAULT IS NOT A FACT. The directory fills `parentId` in for every
// child, including one no frame ever spawned — the fill is the root, and it is
// a placeholder. Reading it back here reported `fromTree: true` for a
// relationship the run never stated, which is precisely the failure `fromTree`
// exists to prevent, so only a RECORDED parent counts (card 298's own header
// warns that a child can appear without an agent_spawn frame ever naming it).
//
// THE SAME RULE GOVERNS THE NUMBERS. `foldWork` has no item for every agent —
// its `itemOf` says "or undefined for main" in its own words, and an agent
// only ever heard from as the sender of a status message has none either. A
// lane like that carries `counts: null` and `state: null`, not a zeroed set.

import type { RunEvent } from "../events";
import { agentDirectory } from "./agentDirectory";
import { foldWork, groupWaves, type Wave, type WorkItem, type WorkState } from "../state/work";

/** Which way a handover went, as seen from the spawn tree. */
export type Handover = "down" | "up" | "side";

/** One message, ready to render and ready to click. */
export interface LaneMessage {
  /** Index in the prefix — the scrub cursor's own coordinates. */
  index: number;
  /** The event itself: what a click hands to App's focusInTrace seam. */
  event: RunEvent;
  from: string;
  to: string;
  /** The handles, from the directory. NEVER an opaque agent id. */
  fromTag: string;
  toTag: string;
  direction: Handover;
  /** True when the SPAWN TREE decided the direction, false when the role word
   *  had to. A panel may show the difference; it may never hide it. */
  fromTree: boolean;
  role: string;
  state: string;
  /** The text as the run recorded it. Not clipped here — clipping is a pixel
   *  decision and belongs to whatever renders it. */
  text: string;
  /** The size of the handover, in characters of that text. */
  chars: number;
  /**
   * Prefix index of the task message this one answers, or null.
   *
   * Zero-based, like `index` — these are array positions, not line numbers.
   * LabTrace, the only line numbering the product puts on screen, prints
   * `appliedStart + i + 1`, so anything that shows one of these to a reader
   * has to add the one. The panel does; this module does not, because the
   * cursor's coordinates are what a caller indexes with.
   */
  answers: number | null;
}

/**
 * Everything foldWork counted for one lane.
 *
 * Grouped rather than spread across the lane, because they arrive and vanish as
 * ONE thing: they all come from a single work item, or from no work item at
 * all. Five nullable fields would let a caller check one and read the other
 * four, and would leave the render with four ways to ask the same question —
 * none of which a mutation test can bite on its own.
 */
export interface LaneCounts {
  inTokens: number;
  outTokens: number;
  toolCalls: number;
  gatesAsked: number;
  gatesDenied: number;
}

/** One agent's side of the conversation, with the work fold's numbers. */
export interface MessageLane {
  agentId: string;
  /** From the directory. */
  tag: string;
  name: string;
  /**
   * The rest, from foldWork — joined, never recomputed, and NULL when the fold
   * has no item for this agent.
   *
   * That case is real and not rare: `itemOf` says in its own words "the item an
   * agent's events count towards, or undefined for main", and an agent that was
   * only ever heard from as the SENDER of a status message has no item either.
   * Filling the gap with zeros and a "submitted" would report, in the reader's
   * own coordinates, that an agent which spent tokens and called tools did
   * nothing and has not started. Absent is the absence of a claim, exactly as
   * events.ts already records for `fileChange`.
   */
  intent: string;
  state: WorkState | null;
  lastStatus: string | null;
  counts: LaneCounts | null;
  messages: LaneMessage[];
}

export interface MessageLanes {
  /** One lane per agent that was handed something, in first-appearance order. */
  lanes: MessageLane[];
  /** Every message in arrival order, whatever lane it belongs to. */
  messages: LaneMessage[];
  /** The work fold's own time-overlap phases, for a panel that wants to group
   *  lanes into the waves they actually ran in. */
  waves: Wave[];
}

/** Every item in the work tree, flattened, so a lane can be looked up by id. */
function flatten(items: readonly WorkItem[], into: Map<string, WorkItem>): Map<string, WorkItem> {
  for (const item of items) {
    into.set(item.id, item);
    flatten(item.children, into);
  }
  return into;
}

/**
 * The direction, and whether the tree or the role word decided it.
 *
 * The tree is asked first and in both directions. Only when neither end names
 * the other as its parent does the role word get a say — and there a `task` is
 * something handed DOWN, while a `status` or a `result` is something reported
 * back UP. Anything else is sideways, which is the honest answer for two
 * agents whose relationship the run never recorded.
 *
 * `parentOf` is the RECORDED parent and only the recorded one. The directory
 * fills `parentId` in for every child, and for one that no frame ever spawned
 * the fill is the root — a default. Reading that default here would return
 * `fromTree: true` for a relationship the run never stated, which defeats the
 * whole point of reporting the difference.
 */
function directionOf(
  from: string,
  to: string,
  role: string,
  parentOf: (id: string) => string | null | undefined,
): { direction: Handover; fromTree: boolean } {
  if (parentOf(to) === from) return { direction: "down", fromTree: true };
  if (parentOf(from) === to) return { direction: "up", fromTree: true };
  if (role === "task") return { direction: "down", fromTree: false };
  if (role === "status" || role === "result") return { direction: "up", fromTree: false };
  return { direction: "side", fromTree: false };
}

/**
 * Fold the run's handovers.
 *
 * @param events the run's events
 * @param upto   how many of them to read — the scrub cursor. Absent = all.
 *   `messageLanes(e, k)` is exactly `messageLanes(e.slice(0, k))`.
 */
export function messageLanes(events: readonly RunEvent[], upto?: number): MessageLanes {
  const prefix = upto === undefined ? events : events.slice(0, Math.max(0, upto));

  const dir = agentDirectory(prefix);
  // ONE pass of the work fold, read twice: flattened for the per-lane join,
  // and handed to groupWaves for the phase rows.
  const roots = foldWork(prefix);
  const work = flatten(roots, new Map<string, WorkItem>());
  const parentOf = (id: string): string | null | undefined => {
    const handle = dir.get(id);
    return handle === undefined || !handle.parentRecorded ? undefined : handle.parentId;
  };
  const tagOf = (id: string): string => dir.get(id)?.tag ?? id;

  /** agentId -> prefix index of the latest task message sent to it. */
  const openTask = new Map<string, number>();
  const messages: LaneMessage[] = [];
  /** Lane order is the order lanes were first spoken to. */
  const laneMsgs = new Map<string, LaneMessage[]>();

  prefix.forEach((e, at) => {
    if (e.type !== "agent_message") return;
    const { direction, fromTree } = directionOf(e.from, e.to, e.role, parentOf);

    // A reply answers the task most recently handed to the agent that is
    // replying — the LATEST, because a lane can be tasked more than once and
    // the first task is not the one being answered.
    const answers = e.role === "task" ? null : (openTask.get(e.from) ?? null);

    const m: LaneMessage = {
      index: at,
      event: e,
      from: e.from,
      to: e.to,
      fromTag: tagOf(e.from),
      toTag: tagOf(e.to),
      direction,
      fromTree,
      role: e.role,
      state: e.state,
      text: e.text,
      chars: e.text.length,
      answers,
    };
    if (e.role === "task") openTask.set(e.to, at);
    messages.push(m);

    // The lane is the CHILD side of the handover: a task belongs to the agent
    // it was given to, a reply to the agent that sent it. That keeps one
    // conversation on one row instead of splitting it across two.
    const laneId = direction === "down" ? e.to : e.from;
    const list = laneMsgs.get(laneId);
    if (list === undefined) laneMsgs.set(laneId, [m]);
    else list.push(m);
  });

  // Lanes come out in the DIRECTORY's order (first appearance in the stream),
  // not in the order they were first spoken to — so the lane list and the tag
  // ramp agree, and w1 is never listed under w2.
  const lanes: MessageLane[] = [];
  for (const [agentId, handle] of dir) {
    const own = laneMsgs.get(agentId);
    if (own === undefined) continue;
    const item = work.get(agentId);
    lanes.push({
      agentId,
      tag: handle.tag,
      name: handle.name,
      intent: item?.intent ?? "",
      // No item, no numbers. `?? 0` here would have invented a measurement.
      state: item === undefined ? null : item.state,
      lastStatus: item?.lastStatus ?? null,
      counts:
        item === undefined
          ? null
          : {
              inTokens: item.inTokens,
              outTokens: item.outTokens,
              toolCalls: item.toolCalls,
              gatesAsked: item.gatesAsked,
              gatesDenied: item.gatesDenied,
            },
      messages: own,
    });
  }

  return { lanes, messages, waves: groupWaves(roots) };
}
