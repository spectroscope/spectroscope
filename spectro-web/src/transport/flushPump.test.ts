// The fold trigger, driven by hand.
//
// Card 261. The one property that matters here cannot be observed in a browser
// at all — a window nobody is looking at renders no frame, so the way to prove
// the batch still folds is to build a host whose requestFrame NEVER runs its
// callback. That is exactly what an occluded window is.

import { describe, expect, it } from "vitest";
import { createFlushPump, HIDDEN_FLUSH_MS, type PumpHost } from "./flushPump";

interface Clocks extends PumpHost {
  /** Run the pending frame callback, as a compositor would. */
  paint(): void;
  /** Run the pending timer callback, as a clock would. */
  ticks(): (() => void)[];
  frameRequests: number;
  timerRequests: { ms: number }[];
  cancelledFrames: number[];
  clearedTimers: number[];
}

/** A host whose two clocks are separate and fire only when told. */
function clocks(options: { paints: boolean }): Clocks {
  const frames = new Map<number, () => void>();
  const timers = new Map<number, () => void>();
  let next = 1;
  const host: Clocks = {
    frameRequests: 0,
    timerRequests: [],
    cancelledFrames: [],
    clearedTimers: [],
    requestFrame(run) {
      host.frameRequests += 1;
      const handle = next++;
      if (options.paints) frames.set(handle, run);
      return handle;
    },
    cancelFrame(handle) {
      host.cancelledFrames.push(handle);
      frames.delete(handle);
    },
    setTimer(run, ms) {
      host.timerRequests.push({ ms });
      const handle = next++;
      timers.set(handle, run);
      return handle;
    },
    clearTimer(handle) {
      host.clearedTimers.push(handle);
      timers.delete(handle);
    },
    paint() {
      const pending = [...frames.values()];
      frames.clear();
      for (const run of pending) run();
    },
    ticks() {
      const pending = [...timers.values()];
      timers.clear();
      return pending;
    },
  };
  return host;
}

describe("a window nobody is looking at", () => {
  it("folds the batch even though no frame ever comes", () => {
    // The defect verbatim: requestAnimationFrame is armed and never fires.
    const host = clocks({ paints: false });
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    pump.schedule();
    host.paint(); // an occluded window: nothing to run
    expect(folds).toBe(0);

    for (const run of host.ticks()) run();
    expect(folds).toBe(1);
  });

  it("arms the fallback at the stated interval, not at some other number", () => {
    const host = clocks({ paints: false });
    createFlushPump(host, () => {}).schedule();
    expect(host.timerRequests).toEqual([{ ms: HIDDEN_FLUSH_MS }]);
  });

  it("keeps folding, batch after batch, with no frame in sight", () => {
    const host = clocks({ paints: false });
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    for (let round = 0; round < 3; round += 1) {
      pump.schedule();
      for (const run of host.ticks()) run();
    }
    expect(folds).toBe(3);
    expect(pump.pending()).toBe(false);
  });
});

describe("a window somebody is looking at", () => {
  it("folds on the frame and the fallback never gets to double it", () => {
    const host = clocks({ paints: true });
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    pump.schedule();
    host.paint();
    expect(folds).toBe(1);

    // The fallback that was armed alongside must be gone, not merely late.
    for (const run of host.ticks()) run();
    expect(folds).toBe(1);
  });

  it("still folds once per frame however many events arrive between folds", () => {
    // The batching rule of the original transport, unchanged.
    const host = clocks({ paints: true });
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    for (let delta = 0; delta < 500; delta += 1) pump.schedule();
    expect(host.frameRequests).toBe(1);
    host.paint();
    expect(folds).toBe(1);
  });
});

describe("disarming", () => {
  it("cancel() takes down both clocks, so a closed socket folds nothing later", () => {
    const host = clocks({ paints: true });
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    pump.schedule();
    pump.cancel();
    expect(pump.pending()).toBe(false);
    expect(host.cancelledFrames.length).toBe(1);
    expect(host.clearedTimers.length).toBe(1);

    host.paint();
    for (const run of host.ticks()) run();
    expect(folds).toBe(0);
  });
});
