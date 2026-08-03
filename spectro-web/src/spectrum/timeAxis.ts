// The time axis under the lanes.
//
// Two decisions live here. Steps come off a FIXED LADDER, so a reader gets 12 h
// rather than the 11.28 h that four days divided by eight happens to produce.
// And labels align to the LOCAL WALL CLOCK rather than to t0: over four calendar
// days "t+63.6 h" is close to useless where "Thu 09:00" is immediate.
//
// The relative offset does not disappear; it stays on the band's tooltip, where
// "how far into the run" is the question actually being asked.

import type { Lang } from "../i18n/i18n";
import { toScreen, type Window } from "./viewport";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Durations a reader can divide in their head, and nothing else. */
const LADDER = [
  SEC,
  2 * SEC,
  5 * SEC,
  10 * SEC,
  15 * SEC,
  30 * SEC,
  MIN,
  2 * MIN,
  5 * MIN,
  10 * MIN,
  15 * MIN,
  30 * MIN,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
  7 * DAY,
];

/** Label density is a matter of pixels: below this many, two labels collide. */
const PX_PER_LABEL = 130;

/** The coarsest rung that still fits `targetTicks` labels across the window. */
export function niceStep(visibleMs: number, targetTicks: number): number {
  const span = Number.isFinite(visibleMs) && visibleMs > 0 ? visibleMs : 0;
  const want = Number.isFinite(targetTicks) && targetTicks > 0 ? targetTicks : 1;
  const ideal = span / want;
  for (const rung of LADDER) if (rung >= ideal) return rung;
  return LADDER[LADDER.length - 1];
}

export interface AxisTick {
  /** Absolute instant (epoch ms). */
  t: number;
  /** Domain fraction, the same coordinate the marks use, so the component
   *  positions a label and a mark through one `toScreen`. */
  x: number;
  /** The step this tick belongs to: what the label should be formatted for. */
  step: number;
}

/** The first whole local step at or after `t`.
 *
 *  A single ceiling would be enough if a zone had one UTC offset. Across a
 *  daylight saving change it does not, and reading the offset once leaves every
 *  label after the change an hour off the local clock. Reading it twice is worse
 *  than it sounds: both answers can be PHANTOMS, grid points computed under an
 *  offset that is not the one in force where they landed. Berlin's fall-back
 *  produces exactly that, one candidate an hour early and one an hour late, and
 *  the real 12:00 is neither.
 *
 *  So each candidate is verified against the offset at its own instant, and the
 *  earliest survivor wins. A zone with no change in reach yields the plain
 *  ceiling on the first try, unchanged. */
function alignUp(t: number, step: number): number {
  const offAt = (instant: number): number => new Date(instant).getTimezoneOffset() * MIN;
  const onGrid = (x: number): boolean => (((x - offAt(x)) % step) + step) % step === 0;
  let best = Infinity;
  for (const off of new Set([offAt(t), offAt(t + step), offAt(t + 2 * step)])) {
    const first = Math.ceil((t - off) / step) * step + off;
    for (const x of [first, first + step]) {
      if (x >= t && x < best && onGrid(x)) best = x;
    }
  }
  const off = offAt(t);
  return Number.isFinite(best) ? best : Math.ceil((t - off) / step) * step + off;
}

/** The labelled instants inside a window. Instants and fractions only: no
 *  timezone reaches the caller, and no pixels reach this function. */
export function axisTicks(win: Window, t0: number, t1: number, widthPx: number): AxisTick[] {
  const span = t1 - t0;
  if (!(span > 0) || !(widthPx > 0)) return [];
  const visible = span * (win.b - win.a);
  if (!(visible > 0)) return [];
  const step = niceStep(visible, Math.max(2, Math.floor(widthPx / PX_PER_LABEL)));
  const from = t0 + win.a * span;
  const to = t0 + win.b * span;
  const out: AxisTick[] = [];
  // Every tick is aligned, not accumulated. Adding the step would put the whole
  // window on the grid of its FIRST label, and one daylight saving change is
  // enough to take every label after it off the local clock.
  //
  // Bounded by construction: the ladder cannot produce more than one label per
  // PX_PER_LABEL pixels, so this cannot run away at the zoom floor.
  for (let t = alignUp(from, step); t <= to; t = alignUp(t + 1, step)) {
    out.push({ t, x: (t - t0) / span, step });
    if (out.length > 64) break;
  }
  return out;
}

/** Where a tick sits, in the band's own coordinate system. */
export function axisX(tick: AxisTick, win: Window, widthPx: number): number {
  return toScreen(tick.x, win, widthPx);
}

const LOCALE: Record<Lang, string> = { de: "de-DE", en: "en-GB" };

/** A label, formatted for the step it belongs to.
 *
 *  Twenty four hour clock in both languages: an axis is scanned, not read, and
 *  an AM/PM suffix doubles the width of every label to say something the
 *  neighbouring labels already imply. */
export function axisLabel(t: number, step: number, lang: Lang): string {
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (step < MIN) return `${hm}:${pad(d.getSeconds())}`;
  if (step < HOUR) return hm;
  // At an hour or coarser the reader is looking at calendar days, and a bare
  // clock time repeats. Name the day.
  const day = new Intl.DateTimeFormat(LOCALE[lang], { weekday: "short" }).format(d);
  return `${day} ${hm}`;
}
