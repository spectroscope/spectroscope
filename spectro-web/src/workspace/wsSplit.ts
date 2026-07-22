// Pure logic for the resizable tree/preview divider in the Files tab, split out
// so it is testable without a DOM. The split is the TREE's share of the vertical
// space (percent); the preview takes the rest.

export const WS_SPLIT_KEY = "spectroscope:wsSplit";
export const DEFAULT_SPLIT = 40;
export const MIN_SPLIT = 15;
export const MAX_SPLIT = 85;

/** Keep the split inside a usable range so neither pane collapses. */
export function clampSplitPct(pct: number): number {
  return Math.max(MIN_SPLIT, Math.min(MAX_SPLIT, pct));
}

/** Parse a persisted split, falling back to the default for missing / junk /
 *  out-of-range values (a stored value comes back null when storage is blocked). */
export function readStoredSplit(stored: string | null): number {
  const n = stored === null ? NaN : Number(stored);
  return Number.isFinite(n) && n >= MIN_SPLIT && n <= MAX_SPLIT ? n : DEFAULT_SPLIT;
}
