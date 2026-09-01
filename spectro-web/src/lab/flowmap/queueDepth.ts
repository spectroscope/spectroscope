// What the run has been asked for and has not reached yet (card 331).
//
// The owner asked for a queue above the main agent, on a connector point at the
// TOP of its card rather than on the side: "die aktuell noch nicht dequeuten
// kommandos". Every other pressure on a run is drawn — the gate, the context
// bar, the spend. The backlog is a fact about the run and the map does not show
// it.
//
// ── WHY THIS IS A SUBTRACTION AND NOT A LIST ──────────────────────────────────
//
// Measured 2026-09-01 across every Claude Code transcript on this machine — 342
// session files, and the argument is stronger than when the card was written
// against 67 of them:
//
//   queue-operation lines                    15,477
//   carrying no content at all                5,287 = 34.2 %
//   of the 10,190 that do, texts that repeat  6,751
//   the most frequent text appears               59×
//   enqueue 7,745 − dequeue 4,029 − remove 3,703 = 13
//
// A third name nothing. Two thirds of the named ones share their text with
// another. And the frame carries NO ID — `claudeCode.ts:1379-1385` builds it
// from `operation`, an optional `timestamp` and an optional `content`, and that
// is all there is.
//
// So a dequeue retires DEPTH and never a named row. Pairing by text would be a
// guess wearing the clothes of a fact, which is the defect this house keeps
// finding; the honest shape is to say how many left without saying which.
//
// The final 13 over the whole corpus is the arithmetic's own sanity check: a
// running subtraction lands just above zero, which is what a queue does.

import type { RunEvent } from "../../events";

/** The running counts the scene carries. Deliberately not the view: the view's
 *  floor and its `everQueued` are derivations, and a state that stored them
 *  would have two places to keep one truth. */
export interface QueueState {
  arrived: number;
  retired: number;
  named: string[];
  unnamed: number;
}

/** What the node draws: a depth, the names it can honestly show, and the rest. */
export interface QueueView {
  /** enqueue − dequeue − remove up to here, floored at zero. */
  depth: number;
  /** The texts of every enqueue that carried one, in arrival order. */
  named: string[];
  /** Enqueues that named nothing. Stated, never hidden. */
  unnamed: number;
  /** How many left. Deliberately not subtracted from `named`: see the header. */
  retired: number;
  /** Whether anything was ever queued — so an emptied queue reads as zero
   *  rather than as a run that never queued. */
  everQueued: boolean;
}

/** Operations that add to the queue, and the two that take from it. */
const ARRIVES = "enqueue";
const DEPARTS = new Set(["dequeue", "remove"]);

/**
 * Folds the queue frames up to a point in the run.
 *
 * <p>Callers pass the events up to the scrub position, so the answer is the
 * queue AT THAT MOMENT. A fold over the whole run would answer the end state
 * and be wrong everywhere in between, which is what the first criterion's
 * step-through pins.</p>
 *
 * @param events the run's events up to and including the moment in question
 * @returns the depth, the names it can show, and what it cannot name or pair
 */
export function emptyQueue(): QueueState {
  return { arrived: 0, retired: 0, named: [], unnamed: 0 };
}

/**
 * One step of the fold, so the scene can carry the queue the way it carries
 * every other running fact.
 *
 * <p>ONE implementation, not two. `sceneToFlow` reads the SCENE and never the
 * raw events, so a convenience that walked the events separately would be a
 * second copy of this arithmetic — and two copies of one truth is the defect
 * this house keeps finding. {@link queueView} below is that convenience and it
 * is built FROM this reducer rather than beside it.</p>
 *
 * @param state the queue so far
 * @param event the next event, of any type
 * @returns the queue after it — the same object when the event is not a queue one
 */
export function foldQueue(state: QueueState, event: RunEvent): QueueState {
  const raw = event as unknown as { type?: string; operation?: string; content?: string };
  if (raw.type !== "queue_operation") return state;
  const operation = raw.operation;
  if (operation === ARRIVES) {
    const text = typeof raw.content === "string" ? raw.content.trim() : "";
    return {
      arrived: state.arrived + 1,
      retired: state.retired,
      named: text ? [...state.named, text] : state.named,
      unnamed: text ? state.unnamed : state.unnamed + 1,
    };
  }
  if (operation && DEPARTS.has(operation)) {
    return { ...state, retired: state.retired + 1 };
  }
  return state;
}

/** What the node draws, read off the folded state. */
export function viewOf(state: QueueState): QueueView {
  return {
    // Floored: an imported transcript can open AFTER the enqueue it dequeues,
    // and a negative depth is a number no reader can act on.
    depth: Math.max(0, state.arrived - state.retired),
    named: state.named,
    unnamed: state.unnamed,
    retired: state.retired,
    everQueued: state.arrived > 0,
  };
}

/**
 * The whole fold, for tests and for any caller that has the events in hand.
 *
 * @param events the run's events up to and including the moment in question
 * @returns the depth, the names it can show, and what it cannot name or pair
 */
export function queueView(events: readonly RunEvent[]): QueueView {
  return viewOf(events.reduce(foldQueue, emptyQueue()));
}
