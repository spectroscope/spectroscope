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

/** One frame at 60 Hz — the cadence a window somebody is looking at gets. */
const FRAME_MS = 16;

interface Timed extends PumpHost {
  /** Move the shared clock forward, running whatever falls due, in order. */
  advance(ms: number): void;
  now(): number;
}

/**
 * A host whose frame and timer share ONE clock, so which of them wins is
 * observable. The `clocks` rig above runs each callback by hand and therefore
 * cannot see order at all — which is how a 4 ms fallback slipped past it.
 */
function timed(): Timed {
  const due: { at: number; seq: number; run: () => void; handle: number }[] = [];
  let clock = 0;
  let next = 1;
  let seq = 0;
  const arm = (run: () => void, ms: number): number => {
    const handle = next++;
    due.push({ at: clock + ms, seq: seq++, run, handle });
    return handle;
  };
  const drop = (handle: number): void => {
    const at = due.findIndex((entry) => entry.handle === handle);
    if (at >= 0) due.splice(at, 1);
  };
  return {
    requestFrame: (run) => arm(run, FRAME_MS),
    cancelFrame: drop,
    setTimer: (run, ms) => arm(run, ms),
    clearTimer: drop,
    now: () => clock,
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        const ready = due.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at || a.seq - b.seq);
        if (ready.length === 0) break;
        const first = ready[0];
        drop(first.handle);
        clock = first.at;
        first.run();
      }
      clock = target;
    },
  };
}

describe("which clock wins when both are running", () => {
  it("a visible window folds on the frame, and the fallback is strictly later", () => {
    // The property the card calls load-bearing — "a visible window never sees
    // the timer, so the batching rule of the old transport is untouched" — was
    // asserted and never pinned: both rigs ran the callbacks by hand, so the
    // frame-versus-timer race could not be observed. Here it can.
    const host = timed();
    const foldedAt: number[] = [];
    const pump = createFlushPump(host, () => foldedAt.push(host.now()));

    pump.schedule();
    host.advance(FRAME_MS);
    expect(foldedAt).toEqual([FRAME_MS]); // the frame did it, at 16 ms

    host.advance(1000); // …and the fallback armed alongside never doubles it
    expect(foldedAt).toEqual([FRAME_MS]);
  });

  it("folds no more often than the frame through a second of flood", () => {
    // The other half of criterion 2: the fix may not make a WATCHED window
    // fold more often than it used to. At a 4 ms fallback this counts 200.
    const host = timed();
    let folds = 0;
    const pump = createFlushPump(host, () => (folds += 1));

    for (let ms = 0; ms < 1000; ms += 1) {
      pump.schedule();
      host.advance(1);
    }
    expect(folds).toBe(62); // 1000 ms at one fold per 16 ms frame
  });
});

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

  it("arms the fallback at 250 ms — the literal, not whatever the constant says", () => {
    // Card 261 review: the version of this test that compared the timer's
    // argument to HIDDEN_FLUSH_MS was a tautology. The reviewer set the
    // constant to 4 ms and all 31 transport tests stayed green, which turns
    // the fold into a 250-per-second interrupt under a text_delta flood.
    // 250 is a real choice: far enough behind a 16 ms frame that a composited
    // window never reaches this timer at all, near enough that a window
    // brought back to the front is current instead of replaying minutes.
    const host = clocks({ paints: false });
    createFlushPump(host, () => {}).schedule();
    expect(host.timerRequests).toEqual([{ ms: 250 }]);
    expect(HIDDEN_FLUSH_MS).toBe(250);
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
