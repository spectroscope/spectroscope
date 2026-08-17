// Card 249: the source reading's pure folds. Language-blind on purpose —
// indentation is the one structure python, ts, yaml and a config file share,
// and a folding rule that needs a parser would be wrong in nineteen of the
// twenty registered languages before it was right in one.

import type { Token } from "./highlight";

/** A collapsible block: head line at {@link start}, body through {@link end}
 *  (inclusive, 0-based). The head stays visible when folded. */
export interface FoldRegion {
  start: number;
  end: number;
}

/** Indent width of a line, tabs counted as four; null for a blank line —
 *  blank lines take the indentation of what follows them. */
function indentOf(line: string): number | null {
  if (line.trim() === "") return null;
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

/**
 * Every indentation block worth a caret: a line whose following lines sit
 * deeper, spanning until the indentation returns. Blocks hiding fewer than
 * two lines are dropped — a fold that saves one line is caret noise. Trailing
 * blank lines are not claimed; blank lines INSIDE a block belong to it.
 */
export function foldRegions(lines: readonly string[]): FoldRegion[] {
  const indents = lines.map(indentOf);
  const regions: FoldRegion[] = [];
  for (let head = 0; head < lines.length; head++) {
    const base = indents[head];
    if (base === null) continue;
    let end = head;
    for (let next = head + 1; next < lines.length; next++) {
      const depth = indents[next];
      if (depth === null) continue; // decided by the next real line
      if (depth <= base) break;
      end = next;
    }
    if (end - head >= 2) regions.push({ start: head, end });
  }
  return regions;
}

/**
 * The line numbers still on screen: a folded region keeps its head and hides
 * its body — regions folded inside a hidden body stay swallowed.
 */
export function visibleLineNumbers(
  total: number,
  folded: ReadonlySet<number>,
  regions: readonly FoldRegion[],
): number[] {
  const byStart = new Map(regions.map((region) => [region.start, region]));
  const visible: number[] = [];
  let at = 0;
  while (at < total) {
    visible.push(at);
    const region = folded.has(at) ? byStart.get(at) : undefined;
    at = region !== undefined ? region.end + 1 : at + 1;
  }
  return visible;
}

/**
 * The highlight stream cut at line breaks: one token list per line, classes
 * kept, no byte lost (the tokenizer's own invariant, carried over the
 * breaks). A token spanning lines — a block comment — is split, both halves
 * keeping its class.
 */
export function tokenLines(tokens: readonly Token[]): Token[][] {
  const lines: Token[][] = [[]];
  for (const token of tokens) {
    const parts = token.text.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1].push({ text: part, cls: token.cls });
    });
  }
  return lines;
}
