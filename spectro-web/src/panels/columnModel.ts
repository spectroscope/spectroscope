// Card 236 — the column model behind the workspace panels.
//
// The 228 grid derived its column COUNT from the available width
// (`repeat(auto-fit, minmax(240px, 1fr))`) and let grid auto-placement flow
// the cards row-major. Measured on the live build (2026-08-14): a window
// resize crossing a breakpoint re-seated every card — Files moved from beside
// Agents to under Agents at 1440→760 — and the open sequence went
// side-by-side → row-wrap instead of the reference's full-height → split →
// new column. The window size was feeding the ASSIGNMENT.
//
// This model is the cure: an ordered list of columns, each holding one or two
// panel ids, plus a width weight per column and a height split per column.
// Opening appends by the fill rule, closing removes and collapses emptied
// columns, drags re-cut ratios — and nothing in here reads a pixel. The
// pixel PROJECTION (weights → flex, split → flex, 60px floors) happens where
// pixels exist: in the component and the stylesheet.
//
// Pure and dependency-free on purpose: the layout store persists this model
// as one string field (its hand-rolled equality check stays one line), so
// serialize/parse live here beside the operations, testable in plain Node.
// Panel ids are plain strings here; the store validates them against its own
// vocabulary when it parses.

/** One column of the workspace: one or two panels, a width weight relative to
 *  the other columns, and the FIRST panel's share of the column height. */
export interface PanelColumn {
  panels: string[];
  weight: number;
  split: number;
}

/** A column holds at most two panels — the reference's rule, the owner's words. */
export const COLUMN_CAP = 2;

/** A fresh column's split: the two panels share the height evenly. */
export const DEFAULT_SPLIT = 0.5;

/** Sanity band for RATIOS (splits and pair shares). Deliberately wider than
 *  any usable arrangement: the real floor is 60px (PANEL_MIN_PX) and lives in
 *  the pixel domain, enforced where pixels exist. This band only keeps a
 *  stored or keyboard-stepped ratio from reaching 0 or 1, where a panel
 *  would vanish entirely. */
export const RATIO_FLOOR = 0.05;
export const RATIO_CEIL = 0.95;

/** Sanity band for stored width weights — junk-resistant, not taste. */
const WEIGHT_FLOOR = 0.1;
const WEIGHT_CEIL = 10;

const clampRatio = (r: number): number => Math.min(RATIO_CEIL, Math.max(RATIO_FLOOR, r));

/** Ratios and weights are stored to 4 decimals so a drag does not persist
 *  float noise and the serialized form round-trips byte-identical. */
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

/**
 * The fill rule, exactly as the owner said it: a panel joins the LAST column
 * while that column has room, and opens a new column to the right otherwise.
 * One panel → one column (the projection gives it the full height); a second
 * → splits that column; a third → a new column at full height; and so on.
 *
 * @return a new array, or the SAME array when the panel is already seated —
 *         identity is the no-re-render contract the layout store relies on.
 */
export function openInColumns(cols: readonly PanelColumn[], id: string): PanelColumn[] {
  if (cols.some((c) => c.panels.includes(id))) return cols as PanelColumn[];
  const last = cols[cols.length - 1];
  if (last !== undefined && last.panels.length < COLUMN_CAP) {
    return [...cols.slice(0, -1), { ...last, panels: [...last.panels, id] }];
  }
  return [...cols, { panels: [id], weight: 1, split: DEFAULT_SPLIT }];
}

/**
 * Closing re-flows minimally: the panel leaves its column, an emptied column
 * disappears (weights are relative, so its width redistributes by
 * renormalization), and no panel ever migrates between columns.
 */
export function closeInColumns(cols: readonly PanelColumn[], id: string): PanelColumn[] {
  if (!cols.some((c) => c.panels.includes(id))) return cols as PanelColumn[];
  const next: PanelColumn[] = [];
  for (const c of cols) {
    if (!c.panels.includes(id)) {
      next.push(c);
      continue;
    }
    const panels = c.panels.filter((p) => p !== id);
    if (panels.length > 0) next.push({ ...c, panels });
  }
  return next;
}

/** The seated panels, column-major — the order the DOM renders them in. */
export function panelsInColumns(cols: readonly PanelColumn[]): string[] {
  return cols.flatMap((c) => c.panels);
}

/**
 * Reassigns one column's height split, clamped to the sanity band. Junk
 * indices and non-finite ratios return the SAME array (identity, no emit).
 */
export function setColumnSplit(cols: readonly PanelColumn[], index: number, split: number): PanelColumn[] {
  const c = cols[index];
  if (c === undefined || !Number.isFinite(split)) return cols as PanelColumn[];
  const clamped = round4(clampRatio(split));
  if (clamped === c.split) return cols as PanelColumn[];
  return cols.map((col, i) => (i === index ? { ...col, split: clamped } : col));
}

/**
 * Re-cuts the width weights of columns `leftIndex` and `leftIndex + 1`,
 * conserving their sum — a divider drag moves the shared edge and leaves
 * every other column exactly as wide as it was.
 *
 * @param leftShare the left column's new share of the PAIR, 0..1 (clamped)
 */
export function setColumnPairShare(
  cols: readonly PanelColumn[],
  leftIndex: number,
  leftShare: number,
): PanelColumn[] {
  const left = cols[leftIndex];
  const right = cols[leftIndex + 1];
  if (left === undefined || right === undefined || !Number.isFinite(leftShare)) {
    return cols as PanelColumn[];
  }
  const sum = left.weight + right.weight;
  const nextLeft = round4(sum * clampRatio(leftShare));
  const nextRight = round4(sum - nextLeft);
  if (nextLeft === left.weight && nextRight === right.weight) return cols as PanelColumn[];
  return cols.map((c, i) =>
    i === leftIndex ? { ...c, weight: nextLeft } : i === leftIndex + 1 ? { ...c, weight: nextRight } : c,
  );
}

/**
 * Brings a stored arrangement into agreement with the mode fields, which own
 * MEMBERSHIP: seated panels the caller no longer lists are dropped, listed
 * panels the arrangement misses re-enter by the fill rule — in the caller's
 * order, which is DOCK_ORDER for the store and therefore deterministic (the
 * card asks that the order be said out loud). Returns the same array when
 * nothing diverges.
 */
export function reconcileColumns(cols: readonly PanelColumn[], openIds: readonly string[]): PanelColumn[] {
  let next = cols as PanelColumn[];
  for (const seated of panelsInColumns(cols)) {
    if (!openIds.includes(seated)) next = closeInColumns(next, seated);
  }
  for (const id of openIds) next = openInColumns(next, id);
  return next;
}

/**
 * One column as `panels~weight~split`, columns joined by `|` — e.g.
 * `"agents,files~1~0.35|terminal~2~0.5"`. One string field keeps the layout
 * store's hand-written equality check one line (the layout.ts:76-93 trap).
 */
export function serializeColumns(cols: readonly PanelColumn[]): string {
  return cols.map((c) => `${c.panels.join(",")}~${round4(c.weight)}~${round4(c.split)}`).join("|");
}

/**
 * The stored string, made whole. Junk never opens or seats anything the
 * caller did not vouch for: unknown ids and duplicates are dropped, a column
 * beyond the cap keeps its first two, weights and splits are clamped, and an
 * emptied column disappears. A wholesale-junk string parses to `[]`, which
 * reconcileColumns then refills from the modes — the same safe direction as
 * normalizeDockMode's junk-reads-as-closed.
 */
export function parseColumns(raw: string, validIds: readonly string[]): PanelColumn[] {
  const seen = new Set<string>();
  const cols: PanelColumn[] = [];
  for (const part of raw.split("|")) {
    const [panelsCsv, weightRaw, splitRaw] = part.split("~");
    const panels: string[] = [];
    for (const id of (panelsCsv ?? "").split(",")) {
      if (panels.length >= COLUMN_CAP) break;
      if (!validIds.includes(id) || seen.has(id)) continue;
      seen.add(id);
      panels.push(id);
    }
    if (panels.length === 0) continue;
    const weight = Number(weightRaw);
    const split = Number(splitRaw);
    cols.push({
      panels,
      weight: Number.isFinite(weight) ? round4(Math.min(WEIGHT_CEIL, Math.max(WEIGHT_FLOOR, weight))) : 1,
      split: Number.isFinite(split) ? round4(clampRatio(split)) : DEFAULT_SPLIT,
    });
  }
  return cols;
}
