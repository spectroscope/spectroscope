// The chat's half of the in-view search (the store in state/search.ts holds
// the query and the position; each view walks itself). Pure module, no React
// and no DOM — Chat.tsx does the outlining and the scrolling.
//
// WHAT IS SEARCHABLE: everything the chat puts on the screen. The prompt, the
// answer, the reasoning, and the tool cards with their command and their
// result. The first cut of this searched only prompts and answers, on the
// argument that a hit inside a collapsed block would be counted but invisible.
// Living with it settled the question the other way: a reader looking at the
// word "plan" in a tool result and being told "no matches" does not conclude
// that the block is collapsed, they conclude the search is broken. An honest
// count of what is present beats a tidy count of what is expanded.
//
// A HIT IS A TURN, not an occurrence — one step per turn, so no two steps land
// on the same outline. Inside a hit, the literal occurrences are marked
// wherever the view holds text it can slice.

import type { Turn } from "../state/reducer";
import { findRanges } from "../state/search";

/**
 * The readable text of a turn, "" for anything that is not conversation.
 *
 * @param turn a flat turn from the reducer
 * @return the haystack this turn contributes to the search
 */
export function turnSearchText(turn: Turn, card?: ToolCardText): string {
  switch (turn.kind) {
    case "user":
      return turn.text;
    case "assistant":
      // The reasoning is on screen whenever the disclosure opens it, and the
      // reader who searches for a phrase they just read there is right.
      return [turn.text, turn.thinking ?? ""].filter((p) => p !== "").join("\n");
    case "tool":
      // The command IS the interesting text in an incident transcript, and the
      // result is the evidence. Both are rendered; both are searchable.
      if (card === undefined) return "";
      return [card.name, card.input, card.output].filter((p) => p !== "").join("\n");
    default:
      return "";
  }
}

/** The searchable text of one tool card, flattened by the caller that holds
 *  the card store. Input is stringified once, by the view, so this module
 *  stays free of the card's shape. */
export interface ToolCardText {
  name: string;
  input: string;
  output: string;
}

/**
 * The flat indices of the turns that contain the query, in document order.
 * Each matching turn appears exactly once however often it matches inside.
 *
 * @param turns the reducer's chronological turn list
 * @param query what the reader typed; empty or whitespace matches nothing
 * @return the hit turns' indices — the view's hit count is this array's length
 */
export function chatHits(
  turns: readonly Turn[],
  query: string,
  cardText?: (turn: Turn) => ToolCardText | undefined,
  regex = false,
): number[] {
  if (query.trim() === "") return [];
  const out: number[] = [];
  turns.forEach((turn, index) => {
    const text = turnSearchText(turn, cardText?.(turn));
    if (text !== "" && findRanges(text, query, regex).length > 0) out.push(index);
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
export function markSegments(text: string, query: string, regex = false): MarkedSegment[] {
  const ranges = findRanges(text, query, regex);
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
