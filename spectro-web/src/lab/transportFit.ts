// What the replay transport row gives up when it runs out of room (card 303).
//
// THE DEFECT THIS ANSWERS. Measured in a browser over .lab-scrub-track with
// getBoundingClientRect().width, dock closed: 1440px viewport -> 672.9,
// 1100 -> 326.3, 900 -> 126.3, 771 -> 4.0. With the dock open the track was
// already 16.3 at 1100 and 4.0 at 950. Between 1100 and 900 the track lost
// exactly the 200px the viewport lost, because it was the only thing in the
// row that could shrink: `.lab-scrub-track { min-width: 0 }` told the flex
// algorithm so. The scrub and card 299's chapter marks stayed on the page and
// stopped working — visible, aimable at, four pixels wide.
//
// THE ORDER OF YIELDING, and the reason for each place in it:
//
//   1. the speed pills. A multiplier only matters while the run is PLAYING,
//      which is the opposite of what someone dragging the scrub is doing, and
//      the same tempo sits in the "more" drawer — so this is the largest
//      saving in the row (186px) at the smallest cost, and nothing becomes
//      unreachable.
//   2. the clock. It is a second reading of the position the counter already
//      gives, in another unit.
//   3. the counter. The slider's own thumb still shows the position after it
//      goes, less precisely; this is the last reading to go because it is the
//      exact one.
//
// Three parts, and the list stops there. WHAT IS NOT IN IT, and why the first
// version of this file had it: "more" — the `.lab-advanced` drawer — stood
// fourth, on the reasoning that it should go last because after the pills it
// is the only speed control the row has. Last is not far enough. A part in
// this order is a part the stylesheet HIDES, and there is no drawer left to
// find the control in: the grain radiogroup and the tempo slider exist once
// each in the whole row and both live inside it (measured in
// LabTransport.test.tsx). Hiding it did not move the app's only tempo control,
// it deleted it — measured at a 488px row, `display: none` on the drawer and a
// width of 0 on both grain buttons. And at ordinary sizes: a 1100px viewport
// with the lab dock open measures a 464px row, a 900px one measures 504px,
// both under the 513px the query fired at.
//
// The buttons, the scrub itself and the drawer never yield: the buttons are the
// transport, the scrub is what the row exists for, and the drawer is the only
// way to a grain or a tempo. Below the floor — a row too narrow even with all
// three dropped — the row grows a LINE instead (`flex-wrap` plus a track that
// refuses to shrink, lab.css), and the drawer takes that second line rather
// than disappearing. That is honest in a way a four-pixel slider is not, and in
// a way a vanished tempo is not either.
//
// THE WIDTHS BELOW ARE BUDGETS, not browser measurements. Every box number is
// the stylesheet's own (five 38px buttons 6px apart; 16px between the row's
// groups, 12px inside the scrub group; the pill row's padding, borders and
// gaps); the text inside a pill, the counter and the clock is budgeted at its
// longest plausible string, so a part is dropped a little early rather than a
// little late. What is exact is the floor: SCRUB_MIN_WIDTH is enforced by the
// stylesheet, not by this file, so a budget that is off by a few pixels shifts
// a breakpoint and can never bring the four-pixel scrub back.

/**
 * The narrowest scrub worth having.
 *
 * WHAT THIS NUMBER BUYS, and what it does not. 220px is a draggability floor:
 * the slider keeps a thumb travel a hand can aim at, and the measured 4.0px
 * cannot be reached from any row width. That is the defect this card was cut
 * for, and it is closed.
 *
 * It is NOT enough to separate every chapter mark in the worst case, and the
 * arithmetic for that is card 299's own. `MARK_MIN_GAP_PCT` (state/stepper.ts)
 * thins ticks to 2% of the bar, and the number 2 was picked against a 600px
 * bar: 2% of 600 is 12px, one 11px `.lab-mark` hit box clear. The same rule on
 * a 220px track leaves 4.4px, so a run dense enough to hit the density floor
 * still has marks whose hit boxes overlap. Full separation at the floor wants
 *
 *     11px hit box / 2% per gap = 550px
 *
 * and 550 is not free: the row would then wrap on any pane under roughly 860px
 * of viewport, and with the lab dock open at 771px the row measures about 513px
 * — narrower than the track's own minimum, which is horizontal overflow rather
 * than a graceful second line. Choosing between a crowded tick and a row that
 * overflows a narrow dock is a product call, not an inference, so this file
 * takes the floor that cannot overflow and the open question goes to the owner.
 * The percentage, not this constant, is the honest place to fix it.
 */
export const SCRUB_MIN_WIDTH = 220;

/** The optional parts, in the order the row gives them up. The "more" drawer
 *  is deliberately NOT one of them — see the head of this file. */
export const TRANSPORT_YIELD_ORDER = ["pills", "clock", "counter"] as const;

export type TransportPart = (typeof TRANSPORT_YIELD_ORDER)[number];

/** Which part is kept at the row width asked about. */
export type TransportFit = Record<TransportPart, boolean>;

/** The class the stylesheet hides for each part — the seam between this file's
 *  decision and the @container queries that apply it, pinned by
 *  scrubKeepsItsWidth.drift.test.ts. */
export const HIDDEN_BY: Record<TransportPart, string> = {
  pills: ".lab-speed-pills",
  clock: ".lab-clock",
  counter: ".lab-counter",
};

/** Five 38px buttons, 6px apart (lab.css, .lab-ctrl-btns). */
const BUTTONS = 214;
/** --sp-4, between the row's groups. */
const ROW_GAP = 16;
/** The literal 12px inside .lab-scrub, between track, counter and clock. */
const SCRUB_GAP = 12;
/** The "more" / "mehr" summary, uppercase and tracked, padded --sp-1/--sp-2
 *  and bordered. It sits with the fixed costs and not in COST below because
 *  the row never gives it up: it is the only way to a grain or a tempo. */
const ADVANCED = 48 + ROW_GAP;

/** What each optional part costs the row, its own gap included. */
const COST: Record<TransportPart, number> = {
  // Five pills ("0.25×" … "5×") at 11px, each padded by --sp-2 either side,
  // 2px apart, in a 2px-padded 1px-bordered pill row.
  pills: 186 + ROW_GAP,
  // "12:34 / 56:78" in tabular mono at 11px.
  clock: 88 + SCRUB_GAP,
  // "step 240 / 240" in tabular mono at 11px.
  counter: 80 + SCRUB_GAP,
};

/** What the scrub track is left with at this row width, given what is kept. */
export function scrubWidthIn(rowWidth: number, fit: TransportFit): number {
  let left = rowWidth - BUTTONS - ROW_GAP - ADVANCED;
  for (const part of TRANSPORT_YIELD_ORDER) if (fit[part]) left -= COST[part];
  return Math.max(0, left);
}

/** What the row keeps at this width. Parts go in TRANSPORT_YIELD_ORDER, one at
 *  a time, and only while the scrub is still short of its minimum — a row that
 *  can pay for everything gives up nothing. */
export function transportFit(rowWidth: number): TransportFit {
  const fit: TransportFit = { pills: true, clock: true, counter: true };
  for (const part of TRANSPORT_YIELD_ORDER) {
    if (scrubWidthIn(rowWidth, fit) >= SCRUB_MIN_WIDTH) break;
    fit[part] = false;
  }
  return fit;
}

/** The widest row that has already given this part up — the number the
 *  stylesheet's `@container (max-width: …)` has to carry. */
export function dropWidthOf(part: TransportPart): number {
  // Everything before this part in the order is gone by the time it is asked
  // for, so the row it needs is its own cost plus what still stands after it.
  let need = BUTTONS + ROW_GAP + ADVANCED + SCRUB_MIN_WIDTH;
  let seen = false;
  for (const p of TRANSPORT_YIELD_ORDER) {
    if (p === part) seen = true;
    if (seen) need += COST[p];
  }
  return need - 1;
}
