// The text tab's half of the in-view search (the store in state/search.ts holds
// the query and the position; each view walks itself). Pure module, no React
// and no DOM — TextView.tsx does the marking and the scrolling.
//
// WHAT IS SEARCHABLE: exactly the lines the reader is looking at. The text tab
// has two switches that change what exists on screen — Text|JSONL, and the
// `extended` disclosure that adds the frames the reading feed leaves out
// (context_info, usage, turn boundaries, the plan) — and the view hands over
// whichever set is currently rendered. Nothing here is collapsed or clipped:
// every segment renders in full, so every hit this module finds is a hit the
// reader can actually see. That is the whole reason a hit is an OCCURRENCE
// here and not a block, the way it has to be in the chat: this surface is flat
// text, so the honest unit is the smallest one.
//
// SHAPE: hits come back keyed by line, not as one flat list. The feed is long
// and mostly misses, and a render walks it start to finish — a map lookup per
// line leaves the misses as the plain strings they already were, and only the
// lines that matched get sliced.

import { findRanges } from "../state/search";

/** Where one line's hits are, and where they sit in the global sequence. */
export interface LineHits {
  /** [start, end) offsets into that line's own text, in document order. */
  ranges: ReadonlyArray<readonly [number, number]>;
  /** Global ordinal of `ranges[0]`; `ranges[k]` is hit number `first + k`. */
  first: number;
}

/** Every hit in one rendered surface. */
export interface FeedHits {
  /** Only the lines that matched, keyed by their index in the input array. */
  byLine: ReadonlyMap<number, LineHits>;
  /** How many hits in total — what the view reports to the store. */
  total: number;
}

/** The shared empty result, so a closed search allocates nothing. */
export const NO_HITS: FeedHits = { byLine: new Map(), total: 0 };

/** The shared empty haystack — a closed search hands this over and costs a
 *  stable reference instead of a fresh array per render. */
export const NO_LINES: readonly string[] = [];

/**
 * Every occurrence of `query` across `lines`, numbered in one continuous
 * sequence so the store's index addresses a single hit and not a line.
 *
 * @param lines the rendered surface, one string per rendered block
 * @param query what the reader typed; empty or whitespace matches nothing
 * @return the hits keyed by line, and their total
 */
export function feedHits(lines: readonly string[], query: string): FeedHits {
  if (query.trim() === "") return NO_HITS;
  const byLine = new Map<number, LineHits>();
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const ranges = findRanges(lines[i], query);
    if (ranges.length === 0) continue;
    byLine.set(i, { ranges, first: total });
    total += ranges.length;
  }
  return total === 0 ? NO_HITS : { byLine, total };
}

/** A run of one line, either a hit or the plain text between hits. */
export interface MarkedRun {
  text: string;
  /** The hit's global ordinal, or -1 for the text between hits. */
  ordinal: number;
}

/** Anything that is not a hit. */
const PLAIN = -1;

/**
 * Cuts one line into runs for rendering. Concatenating the runs gives the line
 * back unchanged, casing included — the reader searches lowercase and still
 * reads their own sentence.
 *
 * @param text the line's own text
 * @param hits that line's entry from {@link feedHits}
 * @return the runs in document order, never empty ones
 */
export function markLine(text: string, hits: LineHits): MarkedRun[] {
  const out: MarkedRun[] = [];
  let at = 0;
  hits.ranges.forEach(([start, end], k) => {
    if (start > at) out.push({ text: text.slice(at, start), ordinal: PLAIN });
    out.push({ text: text.slice(start, end), ordinal: hits.first + k });
    at = end;
  });
  if (at < text.length) out.push({ text: text.slice(at), ordinal: PLAIN });
  return out;
}
