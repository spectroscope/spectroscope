// The axis under the lanes. Steps come off a fixed ladder so the labels are
// readable numbers rather than whatever the span divided by eight happened to
// be, and they align to the WALL CLOCK rather than to t0: a reader looking at
// four calendar days wants "Thu 09:00", not "t+63.6h".
//
// axisTicks returns instants and domain fractions only, so this suite is free of
// any timezone. Formatting is tested by shape, which is also timezone free.

import { describe, expect, it } from "vitest";
import { axisLabel, axisTicks, niceStep } from "./timeAxis";
import { fit } from "./viewport";

const SEC = 1_000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

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

describe("niceStep", () => {
  it("only ever returns a rung of the ladder", () => {
    for (let ms = 500; ms < 30 * DAY; ms = Math.floor(ms * 1.7) + 1) {
      expect(LADDER).toContain(niceStep(ms, 8));
    }
  });

  it("climbs: a wider window never gets a finer step", () => {
    let last = 0;
    for (let ms = SEC; ms < 20 * DAY; ms = Math.floor(ms * 1.3) + 1) {
      const step = niceStep(ms, 8);
      expect(step).toBeGreaterThanOrEqual(last);
      last = step;
    }
  });

  it("picks a step a reader can divide in their head", () => {
    // Four days across eight labels is 12 hours, not 11.28.
    expect(niceStep(4 * DAY, 8)).toBe(12 * HOUR);
    expect(niceStep(90 * MIN, 8)).toBe(15 * MIN);
    expect(niceStep(10 * SEC, 8)).toBe(2 * SEC);
  });

  it("never returns zero, whatever it is handed", () => {
    for (const bad of [0, -1, NaN, Infinity, 1]) {
      expect(niceStep(bad, 8)).toBeGreaterThan(0);
    }
    expect(niceStep(DAY, 0)).toBeGreaterThan(0);
  });
});

describe("axisTicks", () => {
  // A stream that starts at an awkward instant: 09:37:23.412 on some day.
  const t0 = 1_754_000_243_412;
  const t1 = t0 + 4 * DAY;

  it("aligns to the LOCAL clock, not to t0", () => {
    // The stream starts at 09:37:23.412. A step laid down from t0 would label
    // 21:37:23 and 09:37:23, which is not a time anybody reads off an axis.
    const ticks = axisTicks(fit(), t0, t1, 1000);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tk of ticks) {
      const d = new Date(tk.t);
      expect(d.getSeconds()).toBe(0);
      expect(d.getMilliseconds()).toBe(0);
      expect(d.getMinutes()).toBe(0);
      // Four days at eight labels is a twelve hour step: local noon and midnight.
      expect(d.getHours() % 12).toBe(0);
    }
    // And so none of them is the stream's own ragged start.
    expect(ticks.some((tk) => tk.t === t0)).toBe(false);
  });

  it("keeps a constant step between neighbours", () => {
    const ticks = axisTicks({ a: 0.2, b: 0.3 }, t0, t1, 1000);
    expect(ticks.length).toBeGreaterThan(1);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].t - ticks[i - 1].t).toBe(ticks[i].step);
    }
  });

  it("returns domain fractions the band can position with, never screen pixels", () => {
    for (const tk of axisTicks(fit(), t0, t1, 1000)) {
      expect(tk.x).toBeGreaterThanOrEqual(0);
      expect(tk.x).toBeLessThanOrEqual(1);
    }
  });

  it("returns only what the window contains", () => {
    const win = { a: 0.5, b: 0.55 };
    const ticks = axisTicks(win, t0, t1, 1000);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tk of ticks) {
      expect(tk.x).toBeGreaterThanOrEqual(win.a);
      expect(tk.x).toBeLessThanOrEqual(win.b);
    }
  });

  it("stays a readable handful of labels at every depth, including the floor", () => {
    let win = fit();
    for (let i = 0; i < 30; i++) {
      const ticks = axisTicks(win, t0, t1, 1000);
      expect(ticks.length).toBeLessThanOrEqual(24);
      const w = (win.b - win.a) / 2;
      const mid = (win.a + win.b) / 2;
      win = { a: mid - w / 2, b: mid + w / 2 };
    }
  });

  it("stays calm on an empty domain and an unmeasured viewport", () => {
    expect(axisTicks(fit(), 5, 5, 1000)).toEqual([]);
    expect(axisTicks(fit(), t0, t1, 0)).toEqual([]);
  });
});

describe("axisTicks across a daylight saving change", () => {
  // The one window where "aligned to the local clock" and "a constant number of
  // milliseconds apart" stop being the same sentence. The module promises the
  // wall clock, so the wall clock is what these pin.
  const withTz = <T>(tz: string, body: () => T): T => {
    const before = process.env.TZ;
    process.env.TZ = tz;
    try {
      return body();
    } finally {
      process.env.TZ = before;
    }
  };

  /** Three days across the EU fall-back on 2026-10-25, when Berlin repeats 02:00. */
  const from = Date.UTC(2026, 9, 24, 10);
  const to = Date.UTC(2026, 9, 27, 10);

  it("lands every label on a whole local step, on both sides of the change", () => {
    const hours = withTz("Europe/Berlin", () =>
      axisTicks(fit(), from, to, 900).map((tk) => {
        const d = new Date(tk.t);
        return `${d.getHours()}:${d.getMinutes()}`;
      }),
    );
    expect(hours.length).toBeGreaterThan(3);
    // A 12 h step means local noon and local midnight. Nothing else.
    expect(hours).toEqual(hours.map(() => expect.stringMatching(/^(0|12):0$/)));
  });

  it("holds in a zone whose shift is not a whole hour", () => {
    // Lord Howe moves by 30 minutes, so a drifting grid cannot hide behind
    // still landing on something that looks like a round hour.
    const bad = withTz("Australia/Lord_Howe", () =>
      axisTicks(fit(), Date.UTC(2026, 3, 3, 0), Date.UTC(2026, 3, 7, 0), 900).filter(
        (tk) => new Date(tk.t).getMinutes() !== 0,
      ),
    );
    expect(bad).toEqual([]);
  });

  it("absorbs the shift in the real gap rather than in the label", () => {
    // The honest consequence of choosing the wall clock: one interval really is
    // 13 hours long, because that day really was 25 hours long.
    const gaps = withTz("Europe/Berlin", () => {
      const ticks = axisTicks(fit(), from, to, 900);
      return ticks.slice(1).map((tk, i) => tk.t - ticks[i].t);
    });
    expect(gaps).toContain(13 * HOUR);
    expect(gaps.every((g) => g === 12 * HOUR || g === 13 * HOUR)).toBe(true);
  });
});

describe("axisLabel", () => {
  const t = 1_754_000_243_412;

  it("reads seconds when the step is finer than a minute", () => {
    expect(axisLabel(t, 5 * SEC, "en")).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("drops to hour and minute once the step is a minute or more", () => {
    expect(axisLabel(t, 5 * MIN, "en")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("names the day once the step reaches hours, because four days of relative time is unreadable", () => {
    expect(axisLabel(t, 6 * HOUR, "en")).toMatch(/^\S+ \d{2}:\d{2}$/);
    expect(axisLabel(t, 2 * DAY, "en")).toMatch(/^\S+ \d{2}:\d{2}$/);
  });

  it("speaks both languages", () => {
    // Same instant, same shape, and the two locales do not have to agree on the
    // word for the day, only that there is one.
    expect(axisLabel(t, 6 * HOUR, "de")).toMatch(/^\S+ \d{2}:\d{2}$/);
    expect(axisLabel(t, 5 * MIN, "de")).toMatch(/^\d{2}:\d{2}$/);
  });

  it("uses a 24 hour clock in both, so no label carries AM or PM", () => {
    for (const lang of ["en", "de"] as const) {
      for (const step of [5 * SEC, 5 * MIN, 6 * HOUR]) {
        expect(axisLabel(t, step, lang)).not.toMatch(/[AP]M/i);
      }
    }
  });
});
