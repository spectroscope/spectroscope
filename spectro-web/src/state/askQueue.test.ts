// Card 265: the pending-question queue.
//
// The rules are the gate queue's, with one that is only the ask's. Idempotent
// per callId, so a replay and a live stream cannot queue the same question
// twice. One at a time on screen. And — the one that is not the gate's —
// a question the reducer derives has to disappear again on the paths that end
// it, because an ask bar left over an IMPORTED transcript would offer live
// buttons on somebody else's already-answered decision.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, normalizeReplay, reduce, reduceAll } from "./reducer";
import { seedResumedLive } from "./resume";

const askInput = {
  questions: [
    {
      question: "Which store?",
      header: "Storage",
      multiSelect: false,
      options: [{ label: "Postgres" }, { label: "SQLite" }],
    },
  ],
};

const toolCall: RunEvent = {
  type: "tool_call",
  agentId: "main",
  callId: "c1",
  name: "ask_user_question",
  input: askInput,
  ts: 2,
};

const asked: RunEvent = {
  type: "question_asked",
  agentId: "main",
  callId: "c1",
  questions: askInput.questions,
  ts: 3,
};

const answered: RunEvent = {
  type: "question_answered",
  callId: "c1",
  answers: ["Postgres"],
  cancelled: false,
  waitMs: 240_000,
  ts: 4,
};

describe("reduce — the pending question (card 265)", () => {
  it("queues the question the event announced", () => {
    const state = reduceAll(initialState, [toolCall, asked]);
    expect(state.pendingAsks).toHaveLength(1);
    expect(state.pendingAsks[0]).toMatchObject({ callId: "c1", agentId: "main" });
    expect(state.pendingAsks[0].questions[0].question).toBe("Which store?");
    expect(state.pendingAsks[0].questions[0].options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
  });

  it("derives the pending question from the tool_call alone", () => {
    // Belt and braces from the concept: tool_call is emitted BEFORE the tool
    // parks, so the browser holds the question either way. A dropped or unknown
    // question_asked still shows the bar rather than a run that looks stuck.
    const state = reduce(initialState, toolCall);
    expect(state.pendingAsks).toHaveLength(1);
    expect(state.pendingAsks[0].questions[0].question).toBe("Which store?");
  });

  it("is idempotent per callId across both sources", () => {
    const state = reduceAll(initialState, [toolCall, asked, asked]);
    expect(state.pendingAsks).toHaveLength(1);
  });

  it("clears the question when the answer arrives, and marks the card", () => {
    const state = reduceAll(initialState, [toolCall, asked, answered]);
    expect(state.pendingAsks).toHaveLength(0);
    expect(state.cards["c1"].answers).toEqual(["Postgres"]);
    expect(state.cards["c1"].askWaitMs).toBe(240_000);
  });

  it("clears the question when the call ends without one", () => {
    // A run that died, a socket that dropped: the tool_result lands (or the
    // stream ends) and the bar must not outlive the call it belonged to.
    const state = reduceAll(initialState, [
      toolCall,
      asked,
      {
        type: "tool_result",
        agentId: "main",
        callId: "c1",
        output: "unanswered: nobody answered this question.",
        isError: false,
        durationMs: 1,
        ts: 5,
      },
    ]);
    expect(state.pendingAsks).toHaveLength(0);
  });

  it("records a cancelled question without inventing an answer", () => {
    const state = reduceAll(initialState, [
      toolCall,
      asked,
      { type: "question_answered", callId: "c1", answers: [], cancelled: true, ts: 4 },
    ]);
    expect(state.pendingAsks).toHaveLength(0);
    expect(state.cards["c1"].answers).toEqual([]);
    expect(state.cards["c1"].askCancelled).toBe(true);
  });

  it("a replayed archive or import never shows a live question", () => {
    // The card's criterion 8. An imported transcript replays through this exact
    // reducer, and an interrupted one carries a tool_call whose result never
    // came — which is precisely the shape that would leave a live bar with
    // buttons over a decision somebody else made months ago.
    const folded = normalizeReplay(reduceAll(initialState, [toolCall, asked]));
    expect(folded.pendingAsks).toHaveLength(0);
  });

  it("a resumed session does not re-open a question nobody can answer", () => {
    // A resume re-folds the stored history into LIVE state. The server never
    // re-parks those calls, so an answer sent for one would be dropped and the
    // bar would sit there forever.
    const seeded = seedResumedLive(reduceAll(initialState, [toolCall, asked]));
    expect(seeded.pendingAsks).toHaveLength(0);
  });

  it("keeps several questions in arrival order, so the bar can show one", () => {
    const second: RunEvent = { ...asked, callId: "c2", ts: 6 } as RunEvent;
    const state = reduceAll(initialState, [toolCall, asked, second]);
    expect(state.pendingAsks.map((p) => p.callId)).toEqual(["c1", "c2"]);
  });

  it("a question and a permission never land in each other's queue", () => {
    // They are two surfaces with two different answers. A question in the gate
    // queue would be offered Allow/Deny, and Deny would invent a refusal the
    // person never gave.
    const state = reduceAll(initialState, [
      toolCall,
      asked,
      { type: "permission_request", agentId: "main", callId: "c9", name: "run_command", input: {}, ts: 7 },
    ]);
    expect(state.pendingAsks.map((p) => p.callId)).toEqual(["c1"]);
    expect(state.pendingPermissions.map((p) => p.callId)).toEqual(["c9"]);
  });
});

describe("the foreign tool name is never queued (card 265, criterion 8)", () => {
  it("an imported AskUserQuestion call is not a question for THIS person", () => {
    // Measured against a real Claude Code transcript on 2026-08-17: the imported
    // input is byte-for-byte the shape this reducer reads, because that shape IS
    // the importer's and we adopted it deliberately. So shape cannot tell the two
    // apart — the NAME has to. Without this, the only things standing between an
    // imported decision and a live answer button are normalizeReplay and the
    // tool_result clear, and each of those is one edit away from a transcript
    // that was interrupted mid-question.
    const foreign = reduce(initialState, {
      type: "tool_call",
      agentId: "main",
      callId: "imported-1",
      name: "AskUserQuestion",
      input: askInput,
      ts: 1,
    });
    expect(foreign.pendingAsks).toEqual([]);
  });

  it("and our own name still is", () => {
    expect(reduce(initialState, toolCall).pendingAsks).toHaveLength(1);
  });
});
