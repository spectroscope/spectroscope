// Card 380: what a submit does while a run is already up.
//
// Before this card the answer was one word, queue, and the message waited for
// the run to end. Now it goes out as its own frame and the loop reads it at its
// next safe point. The queue stays, for the two cases steering cannot serve: a
// message carrying attachments (owner call 2 keeps steering text only), and a
// server too old to know the frame.
//
// Pure list and flag work. App owns the state and the sending; this module owns
// the decision, so the decision can be measured without a socket.

import type { PendingAttachment } from "../components/AttachmentPreview";
import type { ClientMessage } from "../events";
import { isUnknownTypeError } from "../transport/ws";

/** A sentence whose steering frame has gone out and that no run has answered
 *  for yet. `id` keys the row the chat draws for it. */
export interface PendingSteer {
  id: number;
  text: string;
}

export interface SteeringState {
  /** False once a server has refused the frame by name. It never goes back to
   *  true on the same socket: a page that kept asking would draw one error row
   *  per submit at an operator who cannot do anything about it. */
  understood: boolean;
  /** Sent and not yet answered for, oldest first (fix round 2026-09-24).
   *
   *  Two jobs. The chat draws each one as a pending row the moment it is sent,
   *  because the loop may take minutes to reach its next safe point and the
   *  first build showed nothing at all in between. And an answer that names no
   *  message (the refusal of an older server) or names several (the loop folds
   *  everything waiting into one line) is paired with the page's own list,
   *  in order, which is the order the server read them in. */
  pending: PendingSteer[];
  /** The id the next pending row gets. */
  nextId: number;
}

export const initialSteering: SteeringState = { understood: true, pending: [], nextId: 1 };

/** An end character either side takes off: JS whitespace, which covers every
 *  character Java's String.strip() removes except U+001C..U+001F. */
function isEnd(ch: string): boolean {
  return /\s/.test(ch) || (ch >= "\u001c" && ch <= "\u001f");
}

/**
 * The sentence as the frame carries it and the pending row keeps it.
 *
 * The server strips what the frame brings (SteeringInbox.submit) and writes
 * the result back in its steering_message line, and the pending row has to
 * equal that line. So the page strips first, and strips a superset of what
 * Java strips: on this text the server's strip() then has nothing left to
 * remove. JS trim() alone was not that. It keeps U+001C..U+001F, which Java
 * strips, and the first build also sent the untrimmed text, so a trailing
 * U+00A0 reached the server, which keeps it (review, 2026-09-24).
 */
function sentence(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isEnd(text[start])) start++;
  while (end > start && isEnd(text[end - 1])) end--;
  return text.slice(start, end);
}

export type SubmitRoute =
  { action: "steer"; frame: ClientMessage; next: SteeringState } | { action: "queue" } | { action: "drop" };

/**
 * Decides what a submit during a run becomes.
 *
 * Blank is dropped here as well as at the server's inbox. Two copies of the
 * rule rather than one, because the composer is not the only door into this
 * function and a rule kept at one end is a rule the other end can miss. The
 * page's blank covers the server's: a sentence the inbox would refuse as blank
 * gets no line back, so a pending row kept for it would wait forever.
 */
export function routeSubmit(
  state: SteeringState,
  text: string,
  attachments?: PendingAttachment[],
): SubmitRoute {
  const said = sentence(text);
  if (said === "") {
    return { action: "drop" };
  }
  if (attachments !== undefined && attachments.length > 0) {
    return { action: "queue" };
  }
  if (!state.understood) {
    return { action: "queue" };
  }
  return {
    action: "steer",
    frame: { type: "steering_message", text: said },
    next: {
      understood: true,
      pending: [...state.pending, { id: state.nextId, text: said }],
      nextId: state.nextId + 1,
    },
  };
}

/**
 * How many of the oldest pending sentences one steering line answers for.
 *
 * The loop folds everything waiting into one text, newline between, each
 * sentence trimmed, so the line is always the join of a run of the oldest
 * pending ones. Zero when no such run matches, which is what a replayed record
 * or another page's sentence looks like: those were never this page's to give
 * back.
 */
function answered(pending: PendingSteer[], text: string): number {
  let joined = "";
  for (let n = 1; n <= pending.length; n++) {
    joined = n === 1 ? pending[0].text : `${joined}\n${pending[n - 1].text}`;
    if (joined === text) return n;
    if (!text.startsWith(joined)) return 0;
  }
  return 0;
}

/**
 * Reads one inbound frame for what it says about the steering path.
 *
 * The refusal is recognised with `isUnknownTypeError`, the predicate the
 * transport uses for its liveness probe, so both read the same text. It is
 * only read as a refusal while a steering frame is outstanding.
 * The same text with nothing outstanding is the agent's own failure and belongs
 * on the operator's screen. The transport draws exactly this line for its
 * liveness probe, and a false positive here costs one message its direct path,
 * never a frame the operator needed.
 *
 * @returns the next state, plus the sentences that go back into the old
 *   waiting line, oldest first. A sentence goes back when an older server
 *   refused the frame, or when the run ended before reading it: owner call 3
 *   of the card says it then falls back to exactly today's behaviour and starts
 *   the next run, and the waiting line is what does that.
 */
export function noteFrame(state: SteeringState, frame: unknown): { next: SteeringState; requeue: string[] } {
  const named = frame as { type?: unknown; text?: unknown; taken?: unknown };
  if (named.type === "steering_message" && typeof named.text === "string") {
    const n = answered(state.pending, named.text);
    if (n === 0) {
      return { next: state, requeue: [] };
    }
    const done = state.pending.slice(0, n);
    const next = { ...state, pending: state.pending.slice(n) };
    return { next, requeue: named.taken === true ? [] : done.map((p) => p.text) };
  }
  if (isUnknownTypeError(frame) && state.pending.length > 0) {
    const [refused, ...rest] = state.pending;
    return { next: { ...state, understood: false, pending: rest }, requeue: [refused.text] };
  }
  return { next: state, requeue: [] };
}
