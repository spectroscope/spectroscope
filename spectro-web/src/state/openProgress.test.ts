// Card 431, criterion 9: the count on the loading sign. The fold reports after
// every slice; the store passes a reading on at most every 100 ms and at least
// every 250 ms, and only the surface listens to it, so the chat never renders
// for a count.

import { describe, expect, it } from "vitest";
import { PROGRESS_EVERY_MS, createOpenProgress, openCount, openWire } from "./openProgress";

/** A store on a clock the test moves, with its notifications counted. */
function store() {
  let t = 0;
  const progress = createOpenProgress(() => t);
  const told: number[] = [];
  progress.subscribe(() => told.push(t));
  return {
    progress,
    told,
    at: (ms: number) => {
      t = ms;
    },
  };
}

describe("the progress store", () => {
  it("has nothing to show before a fold reports", () => {
    expect(createOpenProgress(() => 0).read()).toBeNull();
  });

  it("passes the first reading of an open on at once", () => {
    const s = store();
    s.progress.report(1, 0, 91_956);
    expect(s.told).toEqual([0]);
    expect(s.progress.read()).toEqual({ ticket: 1, folded: 0, total: 91_956 });
  });

  it("holds readings back for 100 ms after the last one it passed on", () => {
    const s = store();
    s.progress.report(1, 0, 1000);
    s.at(PROGRESS_EVERY_MS - 1);
    s.progress.report(1, 10, 1000);
    expect(s.told).toEqual([0]);
    // The reading on screen stays the one that was passed on.
    expect(s.progress.read()).toEqual({ ticket: 1, folded: 0, total: 1000 });
    s.at(PROGRESS_EVERY_MS);
    s.progress.report(1, 20, 1000);
    expect(s.told).toEqual([0, PROGRESS_EVERY_MS]);
    expect(s.progress.read()).toEqual({ ticket: 1, folded: 20, total: 1000 });
  });

  it("passes the last reading on at once", () => {
    const s = store();
    s.progress.report(1, 0, 1000);
    s.at(5);
    s.progress.report(1, 1000, 1000);
    expect(s.told).toEqual([0, 5]);
  });

  it("passes a new open's first reading on at once", () => {
    const s = store();
    s.progress.report(1, 0, 1000);
    s.at(3);
    s.progress.report(2, 0, 500);
    expect(s.told).toEqual([0, 3]);
    expect(s.progress.read()).toEqual({ ticket: 2, folded: 0, total: 500 });
  });

  it("updates at least every 250 ms while a fold reports every slice", () => {
    const s = store();
    // A report after each slice, 34 ms apart, for about three seconds. With the
    // 24 ms budget the longest gap between frames during the fold of the
    // owner's big session was 25.9 to 33.6 ms (Chrome, 2026-09-25).
    for (let ms = 0, folded = 0; ms <= 3000; ms += 34, folded += 400) {
      s.at(ms);
      s.progress.report(1, Math.min(folded, 91_956), 91_956);
    }
    expect(s.told.length).toBeGreaterThan(20);
    for (let i = 1; i < s.told.length; i++) {
      const gap = s.told[i] - s.told[i - 1];
      expect(gap, `gap ${i}`).toBeLessThanOrEqual(250);
    }
  });

  it("lets a listener go", () => {
    let t = 0;
    const progress = createOpenProgress(() => t);
    let calls = 0;
    const stop = progress.subscribe(() => calls++);
    progress.report(1, 0, 10);
    stop();
    t = 1000;
    progress.report(1, 5, 10);
    expect(calls).toBe(1);
  });
});

describe("the count, in the reader's language", () => {
  it("groups digits in English", () => {
    expect(openCount("en", 40_000, 91_956)).toBe("40,000 of 91,956 events");
  });

  it("groups digits in German", () => {
    expect(openCount("de", 40_000, 91_956)).toBe("40.000 von 91.956 Ereignissen");
  });

  it("says one event as one", () => {
    expect(openCount("en", 0, 1)).toBe("0 of 1 event");
    expect(openCount("de", 1, 1)).toBe("1 von 1 Ereignis");
  });
});

// Card 473: an import that brings its wire reads it under the same sign, and
// the sign says so instead of repeating the finished event count.
describe("the wire read, on the same sign", () => {
  it("passes the first wire reading of an open on at once, even inside the quiet time", () => {
    const s = store();
    s.at(1000);
    s.progress.report(7, 10, 10);
    s.at(1010);
    s.progress.report(7, 20, 100, "wire");
    expect(s.told).toEqual([1000, 1010]);
    expect(s.progress.read()).toEqual({ ticket: 7, folded: 20, total: 100, unit: "wire" });
  });

  it("says how far the wire is read, as a share", () => {
    expect(openWire("en", 24, 100)).toBe("reading the wire: 24%");
    expect(openWire("de", 24, 100)).toBe("Wire wird gelesen: 24 %");
    expect(openWire("en", 0, 0)).toBe("reading the wire: 0%");
  });
});
