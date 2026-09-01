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

/**
 * The split a pointer at `clientY` is asking for (card 362).
 *
 * <p>THE DEFECT THIS REPLACES: the drag divided by the distance from the tree's
 * TOP to the container's BOTTOM, while the rendered basis is `split%` of the
 * container's FULL inner height — which also holds `.ws-head` and the gaps
 * between the four children. The divisor was therefore smaller than the
 * quantity the result would be applied to, and every drag asked for a bigger
 * share than the pointer had moved to. The divider ran ahead of the cursor.</p>
 *
 * <p>Both distances are handed in rather than measured here, because this
 * module is DOM-free and because the fix is a statement about WHICH height is
 * the right one — a statement that can be checked in plain arithmetic. The
 * caller reads `clientHeight` on the container, which is the content box a
 * percentage basis resolves against.</p>
 *
 * @param clientY     where the pointer is
 * @param treeTop     the tree's top edge on screen
 * @param innerHeight the flex container's inner height — what `split%` is of
 * @return the split to store, clamped, or null when there is no height to
 *         divide by (a hidden pane measures zero and must move nothing)
 */
export function splitPctFromPointer(clientY: number, treeTop: number, innerHeight: number): number | null {
  if (!Number.isFinite(innerHeight) || innerHeight <= 0) return null;
  return clampSplitPct(((clientY - treeTop) / innerHeight) * 100);
}

/** Parse a persisted split, falling back to the default for missing / junk /
 *  out-of-range values (a stored value comes back null when storage is blocked). */
export function readStoredSplit(stored: string | null): number {
  const n = stored === null ? NaN : Number(stored);
  return Number.isFinite(n) && n >= MIN_SPLIT && n <= MAX_SPLIT ? n : DEFAULT_SPLIT;
}
