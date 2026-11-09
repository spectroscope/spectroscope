// Card 604: the time axis of the files timeline. A session can sit idle for
// days between two prompts, and on an axis linear in wall time every mark then
// crowds into the first percent of the width. Here a gap longer than `maxGap`
// seconds between two drawn events takes the width of `maxGap` and leaves a
// break mark that carries its real length. Inside a stretch, and inside a
// collapsed gap, time runs linearly, so a run without a long gap maps one to
// one and the mapping can be undone.

import { t, type Lang } from "../i18n/i18n";

/** A collapsed gap: where its mark stands on the axis, and how long it really was in seconds. */
export interface AxisBreak {
  at: number;
  gap: number;
}

export interface AxisMap {
  /** The axis position of a time in seconds from the start of the run. */
  toX(t: number): number;
  /** The time in seconds at an axis position; undoes `toX`. */
  fromX(x: number): number;
  breaks: readonly AxisBreak[];
  /** The axis runs from 0 to `span`. */
  span: number;
}

/** A gap longer than this many seconds collapses to this width. */
export const MAX_GAP = 120;

/**
 * The mapping of an axis whose drawn events stand at `times` (seconds from the
 * start of the run, in any order). The axis starts at 0 whatever the first
 * time is; the last time ends it.
 */
export function axisMap(times: readonly number[], maxGap = MAX_GAP): AxisMap {
  const ts = [0, ...times.filter((v) => Number.isFinite(v) && v > 0)].sort((a, b) => a - b);
  const pts: number[] = [];
  for (const v of ts) if (pts.length === 0 || v > pts[pts.length - 1]) pts.push(v);
  const xs: number[] = [0];
  const breaks: AxisBreak[] = [];
  for (let i = 1; i < pts.length; i++) {
    const gap = pts[i] - pts[i - 1];
    if (gap > maxGap) breaks.push({ at: xs[i - 1] + maxGap / 2, gap });
    xs.push(xs[i - 1] + Math.min(gap, maxGap));
  }
  const last = pts.length - 1;
  const span = xs[last];
  // Linear between two neighbouring points of `from`, carried over to `to`; past the last point, one to one.
  const along = (from: number[], to: number[], v: number): number => {
    if (v <= 0) return 0;
    if (v >= from[last]) return to[last] + (v - from[last]);
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (from[mid] <= v) lo = mid;
      else hi = mid;
    }
    return to[lo] + ((v - from[lo]) * (to[hi] - to[lo])) / (from[hi] - from[lo]);
  };
  return {
    toX: (v) => along(pts, xs, v),
    fromX: (x) => along(xs, pts, x),
    breaks,
    span,
  };
}

/** A label on the axis: where it stands, and the time (or call number) it prints. */
export interface AxisTick {
  pos: number;
  value: number;
}

/** No more labels than this on the axis. */
export const MAX_TICKS = 7;

const SECOND_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200,
];
const CALL_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];

/**
 * The smallest step from `table` that labels `span` with at most `max`
 * intervals; past the table's end the steps go on as `unit` times 1, 2 and 5
 * and their powers of ten, so a step is found for any finite span.
 */
export function niceStep(span: number, table: readonly number[], unit: number, max: number): number {
  if (!(span > 0) || !Number.isFinite(span)) return table[0];
  for (const s of table) if (span / s <= max) return s;
  for (let m = 1; ; m *= 10) for (const f of [1, 2, 5]) if (span / (unit * f * m) <= max) return unit * f * m;
}

/**
 * The labels of a timed axis, placed in the collapsed domain: a step from the
 * table along the axis, at most `max` labels. A label that would fall inside a
 * collapsed gap moves to where the work resumes. A label closer than three
 * quarters of a step to the one before it, or reading the same, is left out,
 * so a label of two units never runs into its neighbour.
 */
export function timeTicks(map: AxisMap, max = MAX_TICKS, maxGap = MAX_GAP): AxisTick[] {
  const step = niceStep(map.span, SECOND_STEPS, 86_400, max);
  const out: AxisTick[] = [];
  let lastText = "";
  for (let k = 0; k * step <= map.span + 1e-9 && out.length < max; k++) {
    let pos = k * step;
    for (const b of map.breaks) {
      if (pos > b.at - maxGap / 2 && pos < b.at + maxGap / 2) pos = b.at + maxGap / 2;
    }
    const value = map.fromX(pos);
    const text = timeText("en", value);
    const prev = out[out.length - 1];
    if (prev !== undefined && (pos - prev.pos < step * 0.75 || text === lastText)) continue;
    out.push({ pos, value });
    lastText = text;
  }
  return out;
}

/** The labels of an axis that counts calls: call 1 to `calls`, at most `max` of them. */
export function callTicks(calls: number, max = MAX_TICKS): AxisTick[] {
  const step = niceStep(calls, CALL_STEPS, 100_000, max);
  const out: AxisTick[] = [];
  for (let k = 1; k * step <= calls && out.length < max; k++) out.push({ pos: k * step, value: k * step });
  return out;
}

type Unit = "d" | "h" | "min" | "s";
const UNITS: readonly [Unit, number][] = [
  ["d", 86_400],
  ["h", 3_600],
  ["min", 60],
  ["s", 1],
];

/** One decimal at most. */
const round1 = (v: number): number => Math.round(v * 10) / 10;

const unitText = (lang: Lang, unit: Unit, n: string): string =>
  t(lang, `filesTab.timeline.unit.${unit}`, { n });

/**
 * A time as the axis labels, the cursor readout and the break titles print it.
 * Under a minute in seconds with one decimal ("7.4 s"); `fixed` keeps the
 * decimal of a whole second ("3.0 s"), as the cursor does. From a minute on in
 * whole units, the largest it reaches and the next one when that is not zero
 * ("1 min 30 s", "3 h 52 min", "11 d").
 */
export function timeText(lang: Lang, seconds: number, fixed = false): string {
  const r = round1(Math.max(0, seconds));
  if (r < 60) {
    const digits = { minimumFractionDigits: fixed ? 1 : 0, maximumFractionDigits: 1 };
    return unitText(lang, "s", r.toLocaleString(lang, digits));
  }
  const whole = Math.floor(r);
  const i = UNITS.findIndex(([, size]) => whole >= size);
  const [unit, size] = UNITS[i];
  const parts = [unitText(lang, unit, Math.floor(whole / size).toLocaleString(lang))];
  const next = UNITS[i + 1];
  if (next !== undefined) {
    const rest = Math.floor((whole % size) / next[1]);
    if (rest > 0) parts.push(unitText(lang, next[0], rest.toLocaleString(lang)));
  }
  return parts.join(" ");
}

/** A break mark's title: the idle time, "3 d 4 h idle". */
export function gapText(lang: Lang, seconds: number): string {
  return t(lang, "filesTab.timeline.idle", { gap: timeText(lang, seconds) });
}
