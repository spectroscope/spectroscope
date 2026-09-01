// Card 361 — the ONE owner of the chat row's widths.
//
// Three caps used to run in series and nobody owned any of them: the drag
// clamped against `row - 360` (App.tsx:475), the store clamped against a
// literal 1200 (layout.ts:403), and the stylesheet capped the render at
// `calc(100% - 360px - 8px)` — eight pixels tighter than the drag. Which of
// them BOUND depended on the window: below a chat row of roughly 1560px the
// reserve decided and the ceiling never came into it, at or above that width
// the ceiling decided and the reserve never did. That is why "the dock has a
// hard edge" survived one fix, and why the two numbers are two settings.
//
// Worse than the three caps was that there were two ALLOCATORS. The dock's
// resize handler and the gallery's each subtracted the same reserve from the
// same row without knowing the other existed, so with both open and both
// dragged to their limits on the owner's 1030px row the chat computed to
// −318px. This module is the cure: one function turns a row into one panel's
// width, and both handlers call it.
//
// Pure and DOM-free like the rest of state/*: the pixels come in as numbers,
// so the whole allocation is testable in plain Node.

/**
 * The width of one resizer handle, in CSS pixels — `.lab-resizer`'s
 * flex-basis, and the gap between the chat and every panel docked to its
 * right.
 *
 * <p>Counted ONCE, which is criterion 4 of the card: this constant, the
 * `--row-resizer` token in tokens.css and `.lab-resizer`'s own flex-basis are
 * pinned to each other by `dockNarrow.drift.test.ts`. Before that the drag
 * clamp ignored the handle and the render-time cap subtracted it, so the two
 * disagreed by exactly a resizer's width and the chat came out 352px against
 * a 360px floor (measured 2026-08-15).</p>
 */
export const ROW_RESIZER_PX = 8;

/** The shipped `chatReserveWidth`: pixels of the chat row the dock may never
 *  take. The same number lives in `SpectroConfig.DEFAULTS` and in the
 *  `--chat-reserve` token; the settings view overrides it at runtime. */
export const DEFAULT_CHAT_RESERVE_PX = 360;

/** The shipped `dockMaxWidth`: the widest the dock may be dragged. Raised
 *  720 → 1200 with the card-228 grid (three 240px columns plus gaps never fit
 *  under the old cap), a setting since this card. */
export const DEFAULT_DOCK_MAX_PX = 1200;

/** The dock's own floor — below this the cards inside it are slivers. */
export const RIGHT_PANEL_MIN_PX = 260;

/** The gallery's floor and ceiling. Its ceiling is not a setting: the gallery
 *  is not the surface the owner reported a hard edge on, and inventing a key
 *  nobody asked for is a promise this page would have to keep. */
export const IMAGES_MIN_PX = 240;
export const IMAGES_MAX_PX = 1200;

/** What one drag needs to know. Every field is a CSS pixel count. */
export interface RowFit {
  /** The chat row's own width. */
  row: number;
  /** The width the pointer is asking for. */
  desired: number;
  /** What the OTHER panels docked to the chat's right already take, each with
   *  the resizer that precedes it. Zero when this panel is the only one. */
  occupied: number;
  /** The chat's floor (`chatReserveWidth`). */
  reserve: number;
  /** This panel's own floor. */
  min: number;
  /** This panel's own ceiling (`dockMaxWidth` for the dock). */
  max: number;
}

/**
 * What the chat is left with.
 *
 * @param row    the chat row's width
 * @param panels the widths of the panels docked to the chat's right, in any
 *               order — each one costs its own width plus one resizer
 * @return the chat's width, which goes NEGATIVE when the panels overrun the row
 */
export function chatWidthLeft(row: number, panels: readonly number[]): number {
  return panels.reduce((left, w) => left - w - ROW_RESIZER_PX, row);
}

/**
 * One panel's width, given the whole row.
 *
 * <p>The reserve is spent once, against everything already docked. When the
 * row cannot hold the panels' own floors plus the reserve — measured: it
 * cannot below about 880px with both panels open — the floors win and the
 * render-time cap in panels.css shrinks what is drawn. The store never keeps a
 * width the panel is unreadable at, so widening the window brings the drag
 * back rather than leaving a panel stuck at a number a narrow moment chose.</p>
 *
 * <p>A row that cannot be measured (a rect this component never got) leaves
 * the desired width alone rather than snapping the panel to a floor: a
 * non-finite ceiling must not become a decision.</p>
 *
 * @param fit the row, the ask, and this panel's bounds
 * @return the width to store, rounded to whole pixels
 */
export function fitRowPanel(fit: RowFit): number {
  const ceiling = fit.row - fit.reserve - fit.occupied - ROW_RESIZER_PX;
  const cap = Number.isFinite(ceiling) ? Math.min(fit.max, Math.max(ceiling, fit.min)) : fit.max;
  return Math.round(Math.max(fit.min, Math.min(fit.desired, cap)));
}

/** The two dock widths, as this app runs with them. */
export interface DockWidths {
  reserve: number;
  max: number;
}

/** The shipped pair — what the layout runs on until `/api/settings` answers. */
export const SHIPPED_DOCK_WIDTHS: DockWidths = {
  reserve: DEFAULT_CHAT_RESERVE_PX,
  max: DEFAULT_DOCK_MAX_PX,
};

/**
 * Reads a resolved settings view's `effective` map.
 *
 * <p>Every value that is not a finite number in a usable band heals to the
 * shipped one. That is the card-241 direction: these two numbers ride into a
 * CSS custom property and into a clamp, so a junk value would wedge the layout
 * on every load with nothing left for a reload to heal. A negative reserve
 * would hand the dock more room than the row has; a ceiling under the dock's
 * own floor would make every drag illegal.</p>
 *
 * @param effective the settings view's resolved field map
 * @return the widths to run with
 */
export function readDockWidths(effective: Record<string, unknown>): DockWidths {
  const reserve = effective.chatReserveWidth;
  const max = effective.dockMaxWidth;
  return {
    reserve:
      typeof reserve === "number" && Number.isFinite(reserve) && reserve >= 0
        ? Math.round(reserve)
        : DEFAULT_CHAT_RESERVE_PX,
    max:
      typeof max === "number" && Number.isFinite(max) && max >= RIGHT_PANEL_MIN_PX
        ? Math.round(max)
        : DEFAULT_DOCK_MAX_PX,
  };
}
