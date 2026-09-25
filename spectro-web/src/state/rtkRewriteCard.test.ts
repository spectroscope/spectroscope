// Card 416: the tool card keeps the command rtk ran.
//
// The core rewrites a run_command line ABOVE the permission gate (card 379,
// Agent.runGuarded). The tool_call event keeps the line the model wrote; the
// permission_request is the one event that carries the executed line, with the
// model's line beside it under `originalCommand` and `rewrittenBy`. The card was
// built from tool_call alone, and the request's input lived only in the pending
// queue, which the decision empties. So the card said `ls -la` for a call that
// ran `rtk ls -la`, and in auto mode no surface ever showed the rewrite.
//
// The event shapes below are the ones a live auto-mode session wrote on
// 2026-09-24 (session 20260924-143252-6c2a9765, the wave V0 browser check):
// request and decision 4 ms apart, no render needed in between.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type ToolCard, type UiState } from "./reducer";
import { describeTool } from "../components/toolViews";
import { toolTeaser } from "../components/toolTeaser";

const CALL = "ollama-call-98652533347541";

const runStart: RunEvent = {
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "list the folder",
  provider: "ollama",
  ts: 1790253173000,
};

const toolCall: RunEvent = {
  type: "tool_call",
  agentId: "main",
  callId: CALL,
  name: "run_command",
  input: { command: "ls -la" },
  ts: 1790253173339,
};

const REWRITTEN = { command: "rtk ls -la", originalCommand: "ls -la", rewrittenBy: "rtk" };

const request: RunEvent = {
  type: "permission_request",
  agentId: "main",
  callId: CALL,
  name: "run_command",
  input: REWRITTEN,
  ts: 1790253173470,
};

const decision: RunEvent = { type: "permission_decision", callId: CALL, allowed: true, ts: 1790253173474 };

const result: RunEvent = {
  type: "tool_result",
  agentId: "main",
  callId: CALL,
  output: "755  .spectro/\n755  sub/\n644  notes.txt  4B\n",
  isError: false,
  durationMs: 194,
  ts: 1790253173668,
};

function fold(events: RunEvent[]): UiState {
  return events.reduce(reduce, reduce(initialState, runStart));
}

function cardOf(state: UiState): ToolCard {
  const card = state.cards[CALL];
  if (card === undefined) throw new Error("the fold built no card for the call");
  return card;
}

/** What the card's structured face reads: the command it prints after `$`,
 *  and the model's line when the two differ. */
function commandsOf(card: ToolCard): { ran: string; wrote: string | null } {
  const view = describeTool(card.name, card.input, card.output, card.status === "error");
  if (view.kind !== "command") throw new Error(`the card read as ${view.kind}, not as a command`);
  return { ran: view.command, wrote: view.rewrite?.original ?? null };
}

describe("card 416: the card keeps the rewrite after the permission entry is gone", () => {
  it("a window that opened and closed leaves the card with the executed and the original command", () => {
    const afterRequest = fold([toolCall, request]);
    expect(afterRequest.pendingPermissions).toHaveLength(1);

    const done = fold([toolCall, request, decision, result]);
    expect(done.pendingPermissions).toHaveLength(0);
    expect(cardOf(done).input).toEqual(REWRITTEN);
    expect(commandsOf(cardOf(done))).toEqual({ ran: "rtk ls -la", wrote: "ls -la" });
  });

  it("the decision right after the request, and after another agent's event, both leave the rewrite on the card", () => {
    // The first order is the one the 2026-09-24 auto-mode session file holds:
    // the queue holds the entry for exactly one reduce call.
    const atOnce = fold([toolCall, request, decision, result]);
    const withEventBetween = fold([
      toolCall,
      request,
      { type: "text_delta", agentId: "worker-1", text: "meanwhile", ts: 1790253173471 },
      decision,
      result,
    ]);
    // One assertion over both folds, so a failure prints both cards.
    const both = { ran: "rtk ls -la", wrote: "ls -la" };
    expect({
      atOnce: commandsOf(cardOf(atOnce)),
      withEventBetween: commandsOf(cardOf(withEventBetween)),
    }).toEqual({ atOnce: both, withEventBetween: both });
  });

  it("a request the server stamped as decided (card 399) still reaches the card", () => {
    // Auto mode on this branch: the stamped request queues nothing, and it was
    // dropped whole. The input is what the tool runs with, so it is kept.
    const stamped = { ...request, decidedBy: "mode:auto" } as RunEvent;
    expect(fold([toolCall, stamped]).pendingPermissions).toHaveLength(0);
    const done = fold([toolCall, stamped, decision, result]);
    expect(cardOf(done).permission).toBe("allowed");
    expect(commandsOf(cardOf(done))).toEqual({ ran: "rtk ls -la", wrote: "ls -la" });
  });

  it("a denied rewrite keeps the line the gate refused", () => {
    const denied: RunEvent = { ...decision, allowed: false } as RunEvent;
    const done = fold([toolCall, request, denied]);
    expect(cardOf(done).permission).toBe("denied");
    expect(commandsOf(cardOf(done))).toEqual({ ran: "rtk ls -la", wrote: "ls -la" });
  });
});

describe("card 416: the folded card's one line", () => {
  it("names the line that ran first and the model's line after it", () => {
    const card = cardOf(fold([toolCall, request, decision, result]));
    expect(toolTeaser(card.name, card.input, (n) => `${n} lines`)).toBe(
      "command: rtk ls -la · originalCommand: ls -la · rewrittenBy: rtk",
    );
  });
});

describe("card 416: a call rtk did not rewrite is untouched", () => {
  it("a request that carries the model's own input leaves the card's input as tool_call built it", () => {
    const plain: RunEvent = { ...request, input: { command: "ls -la" } } as RunEvent;
    const before = cardOf(fold([toolCall]));
    const done = cardOf(fold([toolCall, plain, decision, result]));
    expect(done.input).toBe(before.input);
    expect(commandsOf(done)).toEqual({ ran: "ls -la", wrote: null });
  });

  it("only run_command takes the rewrite (owner call 2 at its default)", () => {
    const other: RunEvent = {
      ...toolCall,
      name: "run_in_terminal",
    } as RunEvent;
    const otherRequest: RunEvent = { ...request, name: "run_in_terminal" } as RunEvent;
    const done = cardOf(fold([other, otherRequest, decision]));
    expect(done.input).toEqual({ command: "ls -la" });
  });

  it("a request for a call with no card changes no card", () => {
    const stray: RunEvent = { ...request, callId: "no-such-call" } as RunEvent;
    const state = fold([toolCall]);
    expect(reduce(state, stray).cards).toEqual(state.cards);
  });
});
