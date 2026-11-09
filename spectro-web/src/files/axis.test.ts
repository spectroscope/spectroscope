// Card 604: the time axis of the files timeline. A gap longer than two minutes
// between two drawn events takes two minutes of width and leaves a break mark
// that carries the real length; inside a stretch, time runs linearly. The live
// check of 2026-11-09 found a 16.2-day session with every mark in the first
// percent of the axis and 33 overlapping labels.

import { describe, expect, it } from "vitest";
import type { Lang } from "../i18n/i18n";
import { axisMap, gapText, tickText, timeTicks } from "./axis";

const DAY = 86_400;
const HOUR = 3_600;

/** One event every `step` seconds from `from` to `to`, both included. */
function burst(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = from; t <= to; t += step) out.push(t);
  return out;
}

// Sixteen days: two hours of work, five days idle, two hours of work, five
// days idle, then work every 100 s to the end of the sixteenth day.
const A_END = 2 * HOUR;
const B_START = A_END + 5 * DAY;
const B_END = B_START + 2 * HOUR;
const C_START = B_END + 5 * DAY;
const END = 16 * DAY;
const LONG = [...burst(0, A_END, 30), ...burst(B_START, B_END, 30), ...burst(C_START, END, 100)];

/** Width of an axis label in pixels: 11 px JetBrains Mono, 7.06 px a character measured live on 2026-11-09, rounded up. */
const labelWidth = (text: string): number => text.length * 7.1;

describe("the files timeline's axis", () => {
  it("anIdleSessionSpreadsItsMarksOverTheAxis", () => {
    expect(LONG[LONG.length - 1]).toBe(END);
    const map = axisMap(LONG);
    const xs = LONG.map((t) => map.toX(t));
    // Positions never run backwards.
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    // The largest stretch of the width without a mark, edges included.
    let empty = Math.max(xs[0], map.span - xs[xs.length - 1]);
    for (let i = 1; i < xs.length; i++) empty = Math.max(empty, xs[i] - xs[i - 1]);
    expect(empty / map.span).toBeLessThanOrEqual(0.01);
    // Two breaks, each carrying its real length and standing in the middle of its two minutes.
    expect(map.breaks.map((b) => b.gap)).toEqual([5 * DAY, 5 * DAY]);
    expect(map.breaks.map((b) => b.at)).toEqual([map.toX(A_END) + 60, map.toX(B_END) + 60]);
    expect(map.toX(B_START) - map.toX(A_END)).toBe(120);
  });

  it("theLabelsStayFewAndApart", () => {
    const map = axisMap(LONG);
    const ticks = timeTicks(map);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks[0]).toEqual({ pos: 0, value: 0 });
    for (const lang of ["en", "de"] as Lang[]) {
      const px = ticks.map((tick) => (tick.pos / map.span) * 1000);
      const texts = ticks.map((tick) => tickText(lang, tick.value));
      for (let i = 1; i < ticks.length; i++) {
        const apart = px[i] - px[i - 1];
        expect(apart, `${texts[i - 1]} to ${texts[i]}`).toBeGreaterThanOrEqual(
          Math.max(labelWidth(texts[i - 1]), labelWidth(texts[i])),
        );
      }
      // No two labels read the same.
      expect(new Set(texts).size).toBe(texts.length);
    }
    // A label prints the real time at its place, not the place.
    for (const tick of ticks) expect(tick.value).toBeCloseTo(map.fromX(tick.pos), 6);
    expect(ticks[ticks.length - 1].value).toBeGreaterThan(10 * DAY);
    // The labels reach the end of the axis, not only its first part.
    expect(map.span - ticks[ticks.length - 1].pos).toBeLessThan(map.span / 5);
  });

  it("aLabelInsideABreakMovesToWhereTheWorkResumes", () => {
    // 550 s of work, a day idle, 600 s of work: the span is 1,270 and the step
    // 300, so the tick at 600 falls inside the break (550 to 670) and moves to
    // 670, where the work resumes.
    const map = axisMap([...burst(0, 550, 10), ...burst(550 + DAY, 1150 + DAY, 10)]);
    expect(map.span).toBe(1270);
    expect(map.breaks).toEqual([{ at: 610, gap: DAY }]);
    const ticks = timeTicks(map);
    for (const tick of ticks) {
      for (const b of map.breaks) {
        const inside = tick.pos > b.at - 60 && tick.pos < b.at + 60;
        expect(inside, `tick at ${tick.pos}`).toBe(false);
      }
    }
    expect(ticks).toContainEqual({ pos: 670, value: 550 + DAY });
  });

  it("aRunWithoutIdleGapsMapsLinearly", () => {
    const map = axisMap(burst(0, 40, 2));
    expect(map.breaks).toEqual([]);
    expect(map.span).toBe(40);
    for (const t of [0, 1, 13.7, 20, 39.9, 40]) {
      expect(map.toX(t)).toBeCloseTo(t, 9);
      expect(map.fromX(t)).toBeCloseTo(t, 9);
    }
    // The labels of a 40 s run, as before the change.
    expect(timeTicks(map)).toEqual([0, 10, 20, 30, 40].map((s) => ({ pos: s, value: s })));
    expect(timeTicks(map).map((tick) => tickText("en", tick.value))).toEqual([
      "0 s",
      "10 s",
      "20 s",
      "30 s",
      "40 s",
    ]);
  });

  it("fromXUndoesToXInsideTheStretches", () => {
    const map = axisMap(LONG);
    for (const t of [
      0,
      17,
      1234.5,
      A_END,
      B_START,
      B_START + 77.25,
      B_END,
      C_START + 12_345.6,
      END - 1,
      END,
    ]) {
      expect(Math.abs(map.fromX(map.toX(t)) - t), String(t)).toBeLessThan(1e-6);
    }
  });

  it("aLongRunWithoutBreaksStillKeepsSevenLabels", () => {
    // Four days of work, a call every 100 s: no break, and more than seven
    // times the largest step of the old table (43,200 s).
    const map = axisMap(burst(0, 4 * DAY, 100));
    expect(map.breaks).toEqual([]);
    const ticks = timeTicks(map);
    expect(ticks.length).toBeLessThanOrEqual(7);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    // Seven labels a step of 43,200 s apart would stop at three quarters of the axis.
    expect(map.span - ticks[ticks.length - 1].pos).toBeLessThan(map.span / 5);
  });

  it("labelsAndBreaksSayTheTimeInItsUnit", () => {
    expect([0, 12.5, 90, 14_400, 11 * DAY].map((s) => tickText("en", s))).toEqual([
      "0 s",
      "12.5 s",
      "1.5 min",
      "4 h",
      "11 d",
    ]);
    expect([0, 12.5, 90, 14_400, 11 * DAY].map((s) => tickText("de", s))).toEqual([
      "0 s",
      "12,5 s",
      "1,5 Min.",
      "4 Std.",
      "11 T",
    ]);
    expect(gapText("en", 3 * DAY + 4 * HOUR + 59)).toBe("3 d 4 h idle");
    expect(gapText("de", 3 * DAY + 4 * HOUR + 59)).toBe("3 T 4 Std. Pause");
    expect(gapText("en", 5 * DAY)).toBe("5 d idle");
    expect(gapText("en", 130)).toBe("2 min 10 s idle");
    expect(gapText("de", 130)).toBe("2 Min. 10 s Pause");
  });
});
