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
          lastBefore(
            entries,
            cur.seq,
            (e) => e.type === "permission_decision" && str(payload(e)["callId"]) === callId,
          ) ??
          lastBefore(entries, cur.seq, (e) => e.type === "tool_call" && str(payload(e)["callId"]) === callId);
        break;
      case "permission_decision":
        prev = lastBefore(
          entries,
          cur.seq,
          (e) => e.type === "permission_request" && str(payload(e)["callId"]) === callId,
        );
        break;
      case "permission_request":
        prev = lastBefore(
          entries,
          cur.seq,
          (e) => e.type === "tool_call" && str(payload(e)["callId"]) === callId,
        );
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
 * WHERE A BLOCK WEARS ITS LENS OUTPUT: on the row that OPENS it.
 *
 * Both maps below used to key the row that CLOSED the block, and the owner
 * caught what that costs. His report was "a turn_start always has a huge
 * thinking event and the thinking lens ignores it", and the measurement backs
 * him: on his own transcript the 451 thinking frames form 305 blocks, 146 of
 * them two rows long, and in 146 of those 146 the FIRST row sits directly under
 * the turn_start AND holds more text than the second. So the panel and the
 * "then:" chip were drawn on the short tail while the long thought above them —
 * the one the eye lands on — showed nothing. Measured, seq 13/14 of that file:
 * 788 characters silent, 112 characters carrying the whole joined block.
 *
 * The block is still one block and the joined text is unchanged. Only the
 * anchor moved, from the last row to the first.
 */

/** The index after the end of the same-agent thinking block starting at `i`. */
function blockEnd(entries: TraceEntry[], i: number): number {
  const agentId = entries[i].agentId;
  let j = i + 1;
  while (j < entries.length && entries[j].type === "thinking_delta" && entries[j].agentId === agentId) j++;
  return j;
}

/** Whether `i` opens a block rather than continuing one. */
function opensBlock(entries: TraceEntry[], i: number): boolean {
  if (entries[i].type !== "thinking_delta") return false;
  const prev = entries[i - 1];
  return prev === undefined || prev.type !== "thinking_delta" || prev.agentId !== entries[i].agentId;
}

/**
 * Said-vs-did pairs (reasoning lens, card 13): for each consecutive thinking
 * block, the next same-agent action that followed THE WHOLE BLOCK — a tool
 * call, a gate event, the answer text, or an error. Returns a map from the
 * block-OPENING thinking seq to the action's seq.
 */
export function reasoningPairs(entries: TraceEntry[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const isAction = (e: TraceEntry): boolean =>
    e.type === "tool_call" ||
    e.type === "permission_request" ||
    e.type === "text_delta" ||
    e.type === "error";

  for (let i = 0; i < entries.length; i++) {
    if (!opensBlock(entries, i)) continue;
    // Search from past the block, never from past its first row: the block's
    // own later rows are not the thing it led to.
    for (let j = blockEnd(entries, i); j < entries.length; j++) {
      const cand = entries[j];
      if (cand.agentId === entries[i].agentId && isAction(cand)) {
        pairs.set(entries[i].seq, cand.seq);
        break;
      }
    }
  }
  return pairs;
}

/**
 * Full reasoning text per block (reasoning lens): for each consecutive
 * same-agent thinking block, the WHOLE block's text — every thinking_delta of
 * the block joined in order, untruncated. So the lens shows the complete
 * thought behind an action, not just the fragment on one row. Returns a map
 * from the block-OPENING thinking seq to the joined text.
 */
export function reasoningBlockText(entries: TraceEntry[]): Map<number, string> {
  const blocks = new Map<number, string>();
  for (let i = 0; i < entries.length; i++) {
    if (!opensBlock(entries, i)) continue;
    const end = blockEnd(entries, i);
    let text = "";
    for (let k = i; k < end; k++) text += str(payload(entries[k])["text"]) ?? "";
    blocks.set(entries[i].seq, text);
  }
  return blocks;
}
