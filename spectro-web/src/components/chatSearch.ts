// The chat's half of the in-view search (the store in state/search.ts holds
// the query and the position; each view walks itself). Pure module, no React
// and no DOM — Chat.tsx does the outlining and the scrolling.
//
// WHAT IS SEARCHABLE: the conversation as it is READ — the user's messages and
// the assistant's answers. Thinking blocks and tool bodies are NOT searched,
// for one reason: at the default disclosure level both render collapsed
// (state/disclosure.ts: `normal` opens neither), so a hit inside them would be
// counted but invisible. "3 of 17" with fourteen hits behind shut doors is a
// worse answer than an honest 3. The same rule keeps tool cards out even when
// a level opens them: what is searchable must not depend on a setting, or the
// count changes under the reader for reasons they did not cause.
//
// A HIT IS A TURN, not an occurrence. The assistant answer goes through the
// markdown renderer (Markdown.tsx builds React elements from a parse tree), so
// there is no rendered string to slice without rewriting that renderer. Turn
// granularity keeps every step meaningful: no two steps land on the same
// outline. Inside a hit, `markSegments` marks the literal occurrences wherever
// the view holds plain text (the user turn), which is a refinement of the
// outline, never a second unit of counting.

import type { Turn } from "../state/reducer";
import { findRanges } from "../state/search";

/**
 * The readable text of a turn, "" for anything that is not conversation.
 *
 * @param turn a flat turn from the reducer
 * @return the haystack this turn contributes to the search
 */
export function turnSearchText(turn: Turn): string {
  switch (turn.kind) {
    case "user":
      return turn.text;
    case "assistant":
      // Deliberately NOT turn.thinking — see the module note.
      return turn.text;
    default:
      return "";
  }
}

/**
 * The flat indices of the turns that contain the query, in document order.
 * Each matching turn appears exactly once however often it matches inside.
 *
 * @param turns the reducer's chronological turn list
 * @param query what the reader typed; empty or whitespace matches nothing
 * @return the hit turns' indices — the view's hit count is this array's length
 */
export function chatHits(turns: readonly Turn[], query: string): number[] {
  if (query.trim() === "") return [];
  const out: number[] = [];
  turns.forEach((turn, index) => {
    const text = turnSearchText(turn);
    if (text !== "" && findRanges(text, query).length > 0) out.push(index);
  });
  return out;
}

/** A run of text, either matched or not. Concatenating them is the original. */
export interface MarkedSegment {
  text: string;
  mark: boolean;
}

/**
 * Cuts plain text into marked and unmarked runs for rendering. The original
 * casing survives — the reader searches lowercase and still reads their own
 * sentence back.
 *
 * @param text  the plain text of one turn
 * @param query the current query
 * @return the runs in document order; a query that matches nothing yields the
 *         whole text as a single unmarked run
 */
export function markSegments(text: string, query: string): MarkedSegment[] {
  const ranges = findRanges(text, query);
  if (ranges.length === 0) return [{ text, mark: false }];
  const out: MarkedSegment[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) out.push({ text: text.slice(at, start), mark: false });
    out.push({ text: text.slice(start, end), mark: true });
    at = end;
  }
  if (at < text.length) out.push({ text: text.slice(at), mark: false });
  return out;
}
