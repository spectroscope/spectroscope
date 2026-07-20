// Causal walk-back (spectro-explain, feature 2 — deterministic, no LLM):
// for one frame, the chain of frames that led to it, walked backwards
// through the recorded stream: result <- decision <- request <- call <-
// turn <- run <- spawn <- parent run. Pure function over TraceEntry[];
// the Trace detail and the Explain panel render the same chain.

import type { TraceEntry } from "../state/reducer";

/** Chains longer than this stop with a truncation guard (defensive only —
 *  real chains are result->...->root prompt, at most ~8 hops). */
const MAX_CHAIN = 12;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function payload(e: TraceEntry): Record<string, unknown> {
  return (e.payload ?? {}) as Record<string, unknown>;
}

/** The latest entry BEFORE `beforeSeq` matching `pred` (backwards scan). */
function lastBefore(
  entries: TraceEntry[],
  beforeSeq: number,
  pred: (e: TraceEntry) => boolean,
): TraceEntry | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.seq < beforeSeq && pred(e)) return e;
  }
  return undefined;
}

/**
 * The causal chain for one frame, oldest first, ending in the frame itself.
 * Hops, where the stream carries the links:
 * - callId joins tool_result / permission_decision / permission_request /
 *   tool_call into one call thread,
 * - agentId + order find the turn_start and run_start that carried the call,
 * - a subagent's run walks over its agent_spawn to the parent's run_start.
 */
export function causalChain(entries: TraceEntry[], target: TraceEntry): TraceEntry[] {
  const chain: TraceEntry[] = [target];
  let cur: TraceEntry | undefined = target;

  while (cur !== undefined && chain.length < MAX_CHAIN) {
    const p = payload(cur);
    const callId = str(p["callId"]);
    const agentId = cur.agentId ?? str(p["agentId"]);
    let prev: TraceEntry | undefined;

    switch (cur.type) {
      case "tool_result":
        prev =
          lastBefore(entries, cur.seq, (e) => e.type === "permission_decision" && str(payload(e)["callId"]) === callId) ??
          lastBefore(entries, cur.seq, (e) => e.type === "tool_call" && str(payload(e)["callId"]) === callId);
        break;
      case "permission_decision":
        prev = lastBefore(entries, cur.seq, (e) => e.type === "permission_request" && str(payload(e)["callId"]) === callId);
        break;
      case "permission_request":
        prev = lastBefore(entries, cur.seq, (e) => e.type === "tool_call" && str(payload(e)["callId"]) === callId);
        break;
      case "tool_call":
      case "text_delta":
      case "thinking_delta":
      case "error":
        prev =
          lastBefore(entries, cur.seq, (e) => e.type === "turn_start" && e.agentId === agentId) ??
          lastBefore(entries, cur.seq, (e) => e.type === "run_start" && e.agentId === agentId);
        break;
      case "turn_start":
        prev = lastBefore(entries, cur.seq, (e) => e.type === "run_start" && e.agentId === agentId);
        break;
      case "run_start": {
        // A subagent run hops to its spawn, a spawn to the parent's run.
        const parentId = str(p["parentId"]);
        if (parentId !== undefined) {
          prev =
            lastBefore(entries, cur.seq, (e) => e.type === "agent_spawn" && e.agentId === agentId) ??
            lastBefore(entries, cur.seq, (e) => e.type === "run_start" && e.agentId === parentId);
        }
        break;
      }
      case "agent_spawn": {
        const parentId = str(p["parentId"]);
        prev = lastBefore(entries, cur.seq, (e) => e.type === "run_start" && e.agentId === parentId);
        break;
      }
      default:
        prev = undefined;
    }

    if (prev === undefined) break;
    chain.unshift(prev);
    cur = prev;
  }

  return chain;
}

/**
 * Said-vs-did pairs (reasoning lens, card 13): for the LAST frame of each
 * consecutive thinking block, the next same-agent action that followed it —
 * a tool call, a gate event, the answer text, or an error. Returns a map
 * from the block-ending thinking seq to the action's seq.
 */
export function reasoningPairs(entries: TraceEntry[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const isAction = (e: TraceEntry): boolean =>
    e.type === "tool_call" || e.type === "permission_request" || e.type === "text_delta" || e.type === "error";

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.type !== "thinking_delta") continue;
    const next = entries[i + 1];
    const blockEnds =
      next === undefined || next.type !== "thinking_delta" || next.agentId !== e.agentId;
    if (!blockEnds) continue;
    for (let j = i + 1; j < entries.length; j++) {
      const cand = entries[j];
      if (cand.agentId === e.agentId && isAction(cand)) {
        pairs.set(e.seq, cand.seq);
        break;
      }
    }
  }
  return pairs;
}
