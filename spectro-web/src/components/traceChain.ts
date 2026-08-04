// Causal walk-back (spectro-explain, feature 2 — deterministic, no LLM):
// for one frame, the chain of frames that led to it, walked backwards
// through the recorded stream: result <- decision <- request <- call <-
// turn <- run <- spawn <- parent run. Pure function over TraceEntry[];
// the Trace detail and the Explain panel render the same chain.

import type { TraceEntry } from "../state/reducer";
import { noteAnchors } from "../state/traceSource";

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

/**
 * AND WHERE IT RIDES ON AN IMPORTED LINE: on the row that opens that line.
 *
 * One Claude Code assistant record writes the turn AND the thought. The
 * importer fans that single line out into a turn_start and the thinking rows
 * under it, so "the row the block starts on" is still one row below the row a
 * reader's eye lands on — and the owner said so: the lens has to take the
 * turn_start into account, there is a whole lot in there.
 *
 * There is. Measured over the 5,119 transcripts in ~/.claude/projects, counted
 * on what the importer EMITS: the lens speaks on 16,579 blocks, and the first
 * row of ALL 16,579 sits directly under a turn_start. 16,572 of them — 99.96%,
 * 18,763,578 of 18,770,600 characters — come from THE SAME LINE of the file as
 * that turn_start. The turn_start was silent about text that is on its own line.
 *
 * So the anchor is the line's own opening row, decided by `noteAnchors`, which
 * is the same rule that already picks which row wears a line's source chips.
 * Two conditions keep it honest, and both are measured cases:
 *   - no source line (a session produced HERE) means no rule: a live turn_start
 *     is its own frame from its own moment and never carried the thought.
 *   - the remaining 7 blocks, whose thinking arrived in a LATER record of the
 *     same response, keep their own row: their turn_start is a different line.
 */
function blockAnchors(entries: TraceEntry[]): Map<number, number> {
  const anchors = noteAnchors(entries);
  const seqOf = new Map<number, number>(); // block-opening index -> the seq it wears
  const taken = new Set<number>(); // anchors already spoken for, first block wins
  for (let i = 0; i < entries.length; i++) {
    if (!opensBlock(entries, i)) continue;
    const line = entries[i].sourceLine;
    const at = line === undefined ? undefined : anchors.get(line);
    // Never move a reading DOWN, and never let a second block on one line
    // overwrite the first — it would take the earlier thought off the screen.
    seqOf.set(i, at !== undefined && at <= entries[i].seq && !taken.has(at) ? at : entries[i].seq);
    const chosen = seqOf.get(i);
    if (chosen !== undefined) taken.add(chosen);
  }
  return seqOf;
}

/** The index after the end of the same-agent thinking block starting at `i`. */
function blockEnd(entries: TraceEntry[], i: number): number {
  const agentId = entries[i].agentId;
  let j = i + 1;
  while (j < entries.length && entries[j].type === "thinking_delta" && entries[j].agentId === agentId) j++;
  return j;
}

/** What counts as a thought being acted on: a call, a gate ask, the answer, or
 *  a failure. A tool_result is not one — that is the machine answering, and it
 *  belongs to the call's card. */
const isAction = (e: TraceEntry): boolean =>
  e.type === "tool_call" || e.type === "permission_request" || e.type === "text_delta" || e.type === "error";

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
  const anchor = blockAnchors(entries);

  for (let i = 0; i < entries.length; i++) {
    if (!opensBlock(entries, i)) continue;
    // Search from past the block, never from past its first row: the block's
    // own later rows are not the thing it led to.
    for (let j = blockEnd(entries, i); j < entries.length; j++) {
      const cand = entries[j];
      if (cand.agentId === entries[i].agentId && isAction(cand)) {
        pairs.set(anchor.get(i) ?? entries[i].seq, cand.seq);
        break;
      }
    }
  }
  return pairs;
}

/**
 * The other direction, which is the one a reader standing on a tool call needs.
 *
 * `reasoningPairs` answers "what did this thought lead to", and it is drawn on
 * the thought's own row and names only the FIRST thing that followed. So the
 * call itself said nothing: measured over the same corpus, 41,346 imported
 * tool_call rows and not one of them carried a word of the lens, while 19,589
 * of them ran with a thinking block in charge. The "then:" chip reached 7,061.
 *
 * This map is per ACTION: the block that was in charge when that action ran.
 * A block takes charge where it ends and holds it until the model thinks again
 * or the turn ends, because that is exactly as far as a recorded thought can
 * honestly be said to reach. It reaches 29,043 action rows (19,589 tool calls,
 * 9,454 answers) that had nothing before.
 *
 * WHAT IS DELIBERATELY NOT IN HERE: anything out of the call's own input or its
 * result. A tool's arguments and its output are the tool card's subject, and
 * folding them into a reading of the reasoning would turn the lens into a
 * second transcript. Only the model's own recorded thought is reasoning.
 *
 * @return action seq -> the seq of the row wearing the block in charge; an
 *         action that ran with nothing in charge is absent, never mapped to
 *         an empty reading
 */
export function reasoningReach(entries: TraceEntry[]): Map<number, number> {
  const reach = new Map<number, number>();
  const anchor = blockAnchors(entries);
  /** agentId (undefined is its own key) -> the seq of the block in charge. */
  const inCharge = new Map<string | undefined, number>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // A new turn, or a run opening or closing, ends what the last thought was
    // answerable for. Per agent: a subagent's turn says nothing about main's.
    if (e.type === "turn_start" || e.type === "run_start" || e.type === "run_end") {
      inCharge.delete(e.agentId);
      continue;
    }
    if (e.type === "thinking_delta") {
      if (opensBlock(entries, i)) inCharge.set(e.agentId, anchor.get(i) ?? e.seq);
      continue;
    }
    if (!isAction(e)) continue;
    const at = inCharge.get(e.agentId);
    if (at !== undefined) reach.set(e.seq, at);
  }
  return reach;
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
  const anchor = blockAnchors(entries);
  for (let i = 0; i < entries.length; i++) {
    if (!opensBlock(entries, i)) continue;
    const end = blockEnd(entries, i);
    let text = "";
    for (let k = i; k < end; k++) text += str(payload(entries[k])["text"]) ?? "";
    blocks.set(anchor.get(i) ?? entries[i].seq, text);
  }
  return blocks;
}
