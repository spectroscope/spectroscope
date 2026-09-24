// The seam of cards 378 and 380, pinned in the merge branch of 2026-09-24.
//
// Card 380 draws a message sent into a running turn as a user turn, marked
// delivered or undelivered. Card 378's walk recalls user turns. Neither card
// knew the other, so "the up arrow recalls a steering message" is a fact only
// the merge makes. It is pinned here through the functions the page and the
// composer actually call: the reducer, the steering router and the recall list.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type UiState } from "../state/reducer";
import { enqueue, type QueuedMessage } from "../state/sendQueue";
import { initialSteering, noteFrame, routeSubmit } from "../state/steering";
import { atDraft, composerKeyAction, recallEntries, walkStep, type RecallEntry } from "./composerKeys";
import { read, stripComments } from "../testkit/source";

const runStart = (runId: string, prompt: string): RunEvent =>
  ({ type: "run_start", runId, agentId: "main", prompt, ts: 1 }) as RunEvent;

const steering = (text: string, taken: boolean): RunEvent =>
  ({ type: "steering_message", agentId: "main", text, taken, turn: taken ? 2 : 0, ts: 5 }) as RunEvent;

/** The operator presses the up arrow in an empty composer, once. */
function upArrow(entries: readonly RecallEntry[]) {
  const action = composerKeyAction({
    key: "ArrowUp",
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    value: "",
    selectionStart: 0,
    selectionEnd: 0,
  });
  expect(action).toBe("recall-back");
  return walkStep(atDraft(), "back", entries, "");
}

/**
 * Everything between the parentheses of the first call that starts with
 * `opening`, nested parentheses included. A pattern that stops at the first
 * closing parenthesis misses an argument such as `[...(a ?? []), ...b]`.
 *
 * @param src the source to search
 * @param opening the callee and its opening parenthesis
 * @return the argument text
 */
function callArguments(src: string, opening: string): string {
  const at = src.indexOf(opening);
  if (at < 0) throw new Error(`the source no longer contains ${opening}`);
  let depth = 1;
  for (let i = at + opening.length; i < src.length; i++) {
    if (src[i] === "(") depth++;
    if (src[i] === ")") depth--;
    if (depth === 0) return src.slice(at + opening.length, i);
  }
  throw new Error(`${opening} is never closed`);
}

function userTexts(state: UiState): string[] {
  return state.turns.flatMap((t) => (t.kind === "user" ? [t.text] : []));
}

describe("the up arrow and a message sent into a running turn", () => {
  it("recalls a steering message the run read, with its exact text", () => {
    const said = "use the cached list, not the API";
    let state = reduce(initialState, runStart("r1", "list the files"));
    state = reduce(state, steering(said, true));

    // The premise, measured: 380 drew it as a delivered user turn.
    const drawn = state.turns.find((t) => t.kind === "user" && t.text === said);
    expect(drawn?.kind === "user" ? drawn.steer : undefined).toBe("delivered");

    const entries = recallEntries(state.turns, []);
    expect(entries).toEqual([{ text: said }, { text: "list the files" }]);

    const step = upArrow(entries);
    expect(step.moved).toBe(true);
    expect(step.text).toBe(said);
    expect(step.unqueue).toBeNull();
  });

  it("recalls a steering message the run missed, which is a user turn as well", () => {
    const said = "stop after the first file";
    let state = reduce(initialState, runStart("r1", "list the files"));
    state = reduce(state, steering(said, false));

    const drawn = state.turns.find((t) => t.kind === "user" && t.text === said);
    expect(drawn?.kind === "user" ? drawn.steer : undefined).toBe("undelivered");

    expect(upArrow(recallEntries(state.turns, [])).text).toBe(said);
  });

  it("keeps a missed sentence as one entry while it waits and after it starts the next run", () => {
    const said = "stop after the first file";
    let state = reduce(initialState, runStart("r1", "list the files"));

    // The page sends it into the running turn.
    const routed = routeSubmit(initialSteering, said);
    expect(routed.action).toBe("steer");
    if (routed.action !== "steer") return;

    // The run ends first. The server writes the sentence back as not taken,
    // the transcript draws it, and the page hands it to the waiting line
    // (App.tsx onEvents, owner call 3 of card 380).
    const missed = steering(said, false);
    state = reduce(state, missed);
    const answer = noteFrame(routed.next, missed);
    expect(answer.requeue).toEqual([said]);
    expect(answer.next.pending).toEqual([]);
    let queue: QueuedMessage[] = answer.requeue.reduce(
      (line, text) => enqueue(line, text),
      [] as QueuedMessage[],
    );
    expect(queue.map((m) => m.text)).toEqual([said]);

    // While it waits: an undelivered turn and a queued message, one entry,
    // and the entry is the queued one, so recalling it takes it out of the line.
    const waiting = recallEntries(state.turns, queue);
    expect(waiting).toEqual([{ text: said, queueId: queue[0].id }, { text: "list the files" }]);

    // The queue drains into the next run, which carries it as its prompt.
    state = reduce(state, runStart("r2", said));
    queue = [];
    expect(userTexts(state).filter((t) => t === said)).toHaveLength(2);

    const after = recallEntries(state.turns, queue);
    expect(after).toEqual([{ text: said }, { text: "list the files" }]);
  });

  it("does not recall a sentence the run has not read yet, and recalls it once it has", () => {
    const said = "skip the tests";
    let state = reduce(initialState, runStart("r1", "list the files"));

    const routed = routeSubmit(initialSteering, said);
    expect(routed.action).toBe("steer");
    if (routed.action !== "steer") return;
    // The premise: the sentence is pending, drawn by the chat as a pending row.
    expect(routed.next.pending.map((p) => p.text)).toEqual([said]);

    // Pending is not a turn, and App passes it to the chat as steerPending,
    // never through the queue. So the walk has nothing of it yet.
    const before = recallEntries(state.turns, []);
    expect(before).toEqual([{ text: "list the files" }]);

    // The positive half: the run reads it, the pending row gives way to the
    // drawn turn, and the up arrow now reaches it first.
    const readIt = steering(said, true);
    expect(noteFrame(routed.next, readIt).next.pending).toEqual([]);
    state = reduce(state, readIt);
    expect(upArrow(recallEntries(state.turns, [])).text).toBe(said);
  });

  it("builds the composer's list from the turns and the queue, never from the pending sentences", () => {
    const args = callArguments(stripComments(read("./Chat.tsx", import.meta.url)), "recallEntries(");
    expect(args).toContain("state.turns");
    expect(args).toContain("props.queued");
    expect(args).not.toContain("steerPending");
  });
});
