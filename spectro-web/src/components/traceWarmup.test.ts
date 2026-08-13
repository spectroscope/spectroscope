// Card 175. The trace is built while the reader is elsewhere — but AFTER the
// view they are on has painted, never in the same render pass as it.
//
// The card named that distinction before anyone measured it: "during the wait"
// is right, "in the same render pass" is not. The build that closed the card in
// August did the second, and the counterfactual says what it costs. Same
// 9,319-row session, same machine, the first blocked task of opening it:
// 563/601/621/637 ms with the trace mounted beside the chat, 361/367/412/481 ms
// with it absent. Roughly 220 ms, on the critical path of the view the reader is
// actually looking at, every time a session is opened.
//
// So the mount waits for idle. These tests pin the scheduler that makes it wait,
// and they pin it through an injected host rather than the real window, because
// the point of the primitive is WHICH channel it uses and WHEN — a real
// `requestIdleCallback` in a test would only prove that vitest has one.

import { describe, expect, it, vi } from "vitest";

import { scheduleWarm, type WarmHost } from "./traceWarmup";

/** A host that records what was asked of it and fires nothing on its own. */
function host(withIdle: boolean): WarmHost & {
  idleCalls: { timeout: number }[];
  timerCalls: number[];
  cancelled: number[];
  cleared: number[];
  fireIdle: () => void;
  fireTimer: () => void;
} {
  const idleTasks: (() => void)[] = [];
  const timerTasks: (() => void)[] = [];
  const rec = {
    idleCalls: [] as { timeout: number }[],
    timerCalls: [] as number[],
    cancelled: [] as number[],
    cleared: [] as number[],
    fireIdle: (): void => idleTasks.forEach((t) => t()),
    fireTimer: (): void => timerTasks.forEach((t) => t()),
    setTimeout: (task: () => void, ms: number): number => {
      rec.timerCalls.push(ms);
      timerTasks.push(task);
      return 7;
    },
    clearTimeout: (id: number): void => {
      rec.cleared.push(id);
    },
  } as WarmHost & ReturnType<typeof host>;
  if (withIdle) {
    rec.requestIdleCallback = (task: () => void, opts: { timeout: number }): number => {
      rec.idleCalls.push(opts);
      idleTasks.push(task);
      return 42;
    };
    rec.cancelIdleCallback = (id: number): void => {
      rec.cancelled.push(id);
    };
  }
  return rec;
}

describe("the trace warms off the critical path of the view the reader is on", () => {
  it("never runs the task in the pass that armed it", () => {
    const task = vi.fn();
    const h = host(true);
    scheduleWarm(task, h);
    // The whole point. A warm-up that runs synchronously is the trap this card
    // names: it does not move the cost, it moves the delay onto the chat.
    expect(task).not.toHaveBeenCalled();
  });

  it("asks for idle time, with a deadline so a page that never rests still warms", () => {
    const h = host(true);
    scheduleWarm(() => {}, h);
    expect(h.idleCalls).toHaveLength(1);
    expect(h.timerCalls).toHaveLength(0);
    // A live stream can keep the main thread busy for as long as it runs. Without
    // a deadline the warm-up would be starved for the whole run and the press
    // would pay the full mount — no worse than before this card, but not the fix
    // either. The deadline is generous on purpose: it is a floor under the
    // guarantee, not a schedule.
    expect(h.idleCalls[0].timeout).toBeGreaterThanOrEqual(1000);
  });

  it("falls back to a timer where the host has no idle callback", () => {
    const task = vi.fn();
    const h = host(false);
    scheduleWarm(task, h);
    expect(h.timerCalls).toHaveLength(1);
    expect(task).not.toHaveBeenCalled();
    h.fireTimer();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("runs the task when idle arrives", () => {
    const task = vi.fn();
    const h = host(true);
    scheduleWarm(task, h);
    h.fireIdle();
    expect(task).toHaveBeenCalledTimes(1);
  });

  it("cancels through the channel it armed, and only that one", () => {
    const withIdle = host(true);
    scheduleWarm(() => {}, withIdle)();
    expect(withIdle.cancelled).toEqual([42]);
    expect(withIdle.cleared).toEqual([]);

    const withTimer = host(false);
    scheduleWarm(() => {}, withTimer)();
    expect(withTimer.cleared).toEqual([7]);
    expect(withTimer.cancelled).toEqual([]);
  });

  it("a cancelled warm-up never runs, so a record the reader left behind stops building", () => {
    const task = vi.fn();
    const h = host(true);
    const cancel = scheduleWarm(task, h);
    cancel();
    h.fireIdle();
    // The fake host fires whatever was armed; the guard is that the task itself
    // refuses once cancelled. Switching sessions three times in a second must
    // not queue three traces.
    expect(task).not.toHaveBeenCalled();
  });
});
