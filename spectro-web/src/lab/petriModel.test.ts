import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { fire, initialMarking } from "./petriModel";
import type { Marking } from "./petriModel";

const T = 1700000000000;

const runStart = (agentId = "main"): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId, prompt: "hi", ts: T }) as RunEvent;
const toolCall = (callId = "c1", agentId = "main"): RunEvent =>
  ({ type: "tool_call", agentId, callId, name: "run_command", input: {}, ts: T }) as RunEvent;

function fireAll(events: RunEvent[]): { marking: Marking; transitions: (string | null)[] } {
  let marking = initialMarking();
  const transitions: (string | null)[] = [];
  for (const e of events) {
    const fired = fire(marking, e);
    marking = fired.marking;
    transitions.push(fired.firing.transition);
  }
  return { marking, transitions };
}

describe("petriModel", () => {
  it("walks the canonical loop user→llm→tool→gate→tool→llm→user", () => {
    const events: RunEvent[] = [
      runStart(),
      { type: "turn_start", agentId: "main", turn: 1, ts: T },
      { type: "text_delta", agentId: "main", text: "…", ts: T },
      toolCall(),
      { type: "permission_request", agentId: "main", callId: "c1", name: "run_command", input: {}, ts: T },
      { type: "permission_decision", callId: "c1", allowed: true, ts: T },
      { type: "tool_result", agentId: "main", callId: "c1", output: "ok", isError: false, durationMs: 5, ts: T },
      { type: "usage", agentId: "main", inputTokens: 10, outputTokens: 2, ts: T },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T },
    ];

    // Marking snapshots at the teaching moments:
    let m = initialMarking();
    m = fire(m, events[0]).marking;
    expect(m.llm).toBe(1); // prompt fired
    for (const e of events.slice(1, 5)) m = fire(m, e).marking;
    expect(m.gate).toBe(1); // the token WAITS at the permission gate
    expect(m.tool).toBe(0);
    m = fire(m, events[5]).marking;
    expect(m.tool).toBe(1); // allowed → back into the tool
    for (const e of events.slice(6)) m = fire(m, e).marking;
    expect(m.user).toBe(1); // run_end returns the token to the user
    expect(m.llm + m.tool + m.gate).toBe(0);
    expect(m.log).toBe(events.length); // log marking == JSONL line count
  });

  it("names the transitions like the spec table", () => {
    const { transitions } = fireAll([
      runStart(),
      toolCall(),
      { type: "permission_request", agentId: "main", callId: "c1", name: "x", input: {}, ts: T },
      { type: "permission_decision", callId: "c1", allowed: false, ts: T },
      { type: "tool_result", agentId: "main", callId: "c1", output: "denied", isError: true, durationMs: 1, ts: T },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T },
    ]);
    expect(transitions).toEqual(["prompt", "call", "ask", "decide", "result", "done"]);
  });

  it("flags a denied decision and an error result as errors", () => {
    let m = initialMarking();
    m = fire(m, runStart()).marking;
    m = fire(m, toolCall()).marking;
    m = fire(m, { type: "permission_request", agentId: "main", callId: "c1", name: "x", input: {}, ts: T } as RunEvent).marking;
    const denied = fire(m, { type: "permission_decision", callId: "c1", allowed: false, ts: T } as RunEvent);
    expect(denied.firing.isError).toBe(true);
    const result = fire(denied.marking, {
      type: "tool_result", agentId: "main", callId: "c1", output: "no", isError: true, durationMs: 1, ts: T,
    } as RunEvent);
    expect(result.firing.isError).toBe(true);
  });

  it("guards: a second parallel tool_call degrades to a pulse, one main token", () => {
    let m = initialMarking();
    m = fire(m, runStart()).marking;
    const first = fire(m, toolCall("c1"));
    expect(first.firing.from).toBe("llm");
    const second = fire(first.marking, toolCall("c2"));
    expect(second.firing.from).toBeNull(); // no llm token left → pulse
    expect(second.firing.pulse).toBe("tool");
    const total = second.marking.user + second.marking.llm + second.marking.tool + second.marking.gate;
    expect(total).toBe(1); // exactly one main token, always
  });

  it("child-agent events pulse the tool place without moving the main token", () => {
    let m = initialMarking();
    m = fire(m, runStart()).marking;
    const child = fire(m, { type: "text_delta", agentId: "explore-1", text: "…", ts: T } as RunEvent);
    expect(child.firing.transition).toBe("sub");
    expect(child.firing.pulse).toBe("tool");
    expect(child.marking.llm).toBe(1); // main token untouched
  });

  it("errors collapse the token back to the user from wherever it sits", () => {
    let m = initialMarking();
    m = fire(m, runStart()).marking;
    m = fire(m, toolCall()).marking; // token in tool
    const err = fire(m, { type: "error", message: "boom", ts: T } as RunEvent);
    expect(err.firing.from).toBe("tool");
    expect(err.marking.user).toBe(1);
    expect(err.firing.isError).toBe(true);
  });

  it("tolerates unknown additive event types (log only)", () => {
    const unknown = { type: "voice_input", agentId: "main", text: "hi", ts: T } as unknown as RunEvent;
    const fired = fire(initialMarking(), unknown);
    expect(fired.firing.transition).toBeNull();
    expect(fired.marking.log).toBe(1);
    expect(fired.marking.user).toBe(1);
  });
});
