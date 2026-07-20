// The Petri-net model of the agent loop — pure functions, no DOM. Places are
// the stations a request passes through; transitions are the RunEvents; the
// marking is a token count per place. `log` is an accumulator place: EVERY
// fired transition also deposits one token there, so its marking equals the
// JSONL line number — the net literally counts the session file.
//
// Guards: a move only fires when the source place holds a token; otherwise it
// degrades to a pulse of the target place. That keeps the net consistent when
// e.g. a turn carries two parallel tool_calls (one main token, second call
// pulses) or a foreign session replays in an unexpected order.

import type { RunEvent } from "../events";

export type Place = "user" | "llm" | "tool" | "gate" | "log";

export type Marking = Record<Place, number>;

/** What one event did to the net — drives the animation and the trace label. */
export interface Firing {
  /** Transition name (Petri bar) — null when the event only logged. */
  transition: string | null;
  /** Token moved from → to (both null for a pure pulse). */
  from: Place | null;
  to: Place | null;
  /** Place that pulses when nothing moved. */
  pulse: Place | null;
  /** Styled as an error (denied permission, tool error, error event). */
  isError: boolean;
}

export function initialMarking(): Marking {
  return { user: 1, llm: 0, tool: 0, gate: 0, log: 0 };
}

/** True for the stream events that the coarse step grain plays through. */
export function isDelta(event: RunEvent): boolean {
  return event.type === "text_delta" || event.type === "thinking_delta";
}

const MAIN = "main";

function agentOf(event: RunEvent): string | null {
  return "agentId" in event && typeof event.agentId === "string" ? event.agentId : null;
}

/**
 * Fire one event against the marking. Returns the new marking plus what
 * happened (for animation). The input marking is never mutated.
 */
export function fire(marking: Marking, event: RunEvent): { marking: Marking; firing: Firing } {
  const next: Marking = { ...marking, log: marking.log + 1 }; // every event is one JSONL line

  const move = (transition: string, from: Place, to: Place, isError = false): Firing => {
    if (next[from] > 0) {
      next[from] -= 1;
      next[to] += 1;
      return { transition, from, to, pulse: null, isError };
    }
    return { transition, from: null, to: null, pulse: to, isError }; // guard: degrade to pulse
  };
  const pulse = (transition: string | null, place: Place, isError = false): Firing => ({
    transition,
    from: null,
    to: null,
    pulse: place,
    isError,
  });

  // Child-agent events (subagents) pulse the tool station — the parent loop
  // keeps the main token. permission_decision has no agentId (decided by the
  // human, applies to the parent's gate).
  const agent = agentOf(event);
  if (agent !== null && agent !== MAIN && event.type !== "permission_decision") {
    return { marking: next, firing: pulse("sub", "tool") };
  }

  switch (event.type) {
    case "run_start":
      return { marking: next, firing: move("prompt", "user", "llm") };
    case "turn_start":
      return { marking: next, firing: pulse("turn", "llm") };
    case "text_delta":
    case "thinking_delta":
      return { marking: next, firing: pulse("delta", "llm") };
    case "tool_call":
      return { marking: next, firing: move("call", "llm", "tool") };
    case "permission_request":
      return { marking: next, firing: move("ask", "tool", "gate") };
    case "permission_decision":
      return { marking: next, firing: move("decide", "gate", "tool", !event.allowed) };
    case "tool_result":
      return { marking: next, firing: move("result", "tool", "llm", event.isError) };
    case "usage":
    case "compaction":
    case "context_info":
      return { marking: next, firing: pulse(event.type === "usage" ? "usage" : "meta", "llm") };
    case "run_end":
      return { marking: next, firing: move("done", "llm", "user") };
    case "error": {
      // The run collapses back to the user from wherever the token sits.
      const from: Place | null = next.llm > 0 ? "llm" : next.tool > 0 ? "tool" : next.gate > 0 ? "gate" : null;
      return {
        marking: next,
        firing: from !== null ? move("error", from, "user", true) : pulse("error", "user", true),
      };
    }
    case "agent_spawn":
    case "image_generated":
      return { marking: next, firing: pulse("sub", "tool") };
    default:
      // Additive tolerance: unknown event types only count as a log line.
      return { marking: next, firing: pulse(null, "log") };
  }
}
