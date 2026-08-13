// Card 175. The trace is built while the reader is elsewhere — but AFTER the
// view they are on has rendered, never in the same render pass as it.
//
// The card named that distinction before anyone measured it: "during the wait"
// is right, "in the same render pass" is not. The build that closed the card in
// August did the second. What that costs in milliseconds is NOT claimed here —
// a figure once stood in this header and did not reproduce on a second machine,
// so the card withdraws it. What is claimed is where the work lands, and these
// tests pin the two halves of that: the scheduler that makes the mount wait, and
// the gate that decides which record it is waiting for.
//
// Both are driven through injected seams rather than the real window and the
// real React, because the properties being bought are WHICH channel and WHEN,
// and a sequence of renders. A real `requestIdleCallback` in a test would only
// prove that vitest has one.

import { describe, expect, it, vi } from "vitest";

import {
  arrivalOf,
  NOTHING_ON_SCREEN,
  traceWarmGate,
  type WarmHost,
  type WarmReact,
  scheduleWarm,
} from "./traceWarmup";

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

/**
 * A renderer, in the few lines this gate needs: hook slots, dependency
 * comparison, cleanups, and a setter that re-renders.
 *
 * The gate takes its three React calls as a seam for the same reason
 * `scheduleWarm` takes the browser's — the property being bought is a SEQUENCE
 * of renders (a record arrives, the browser goes idle, the reader flips back to
 * a record warmed a moment ago), and this project's vitest has no DOM to drive
 * one in. The stategraph tests render through `react-dom/server`, which never
 * runs an effect, so that road is closed too.
 *
 * Everything below therefore drives the code that ships. It is not a
 * restatement of the rule in test form: swap the shipped comparison for a
 * looser one and these go red.
 */
function mount(host: WarmHost): {
  render: (record: unknown, eligible: boolean) => boolean;
  value: () => boolean;
  unmount: () => void;
} {
  const refs: { current: unknown }[] = [];
  const cells: { value: unknown; set: (next: unknown) => void }[] = [];
  const committed: ({ deps: readonly unknown[]; cleanup: (() => void) | undefined } | undefined)[] = [];
  const queued: { slot: number; effect: () => (() => void) | void; deps: readonly unknown[] }[] = [];
  let args: { record: unknown; eligible: boolean } | null = null;
  let out = false;
  let refSlot = 0;
  let cellSlot = 0;
  let effectSlot = 0;

  const react: WarmReact = {
    useRef: <T>(initial: T): { current: T } => {
      const slot = refSlot++;
      refs[slot] ??= { current: initial };
      return refs[slot] as { current: T };
    },
    useState: <T>(initial: T): [T, (next: T) => void] => {
      const slot = cellSlot++;
      cells[slot] ??= {
        value: initial,
        set: (next: unknown): void => {
          cells[slot].value = next;
          pass();
        },
      };
      return [cells[slot].value as T, cells[slot].set as (next: T) => void];
    },
    useEffect: (effect, deps): void => {
      queued.push({ slot: effectSlot++, effect, deps });
    },
  };

  /** One render plus its commit — the effects whose deps moved re-run. */
  const pass = (): void => {
    if (args === null) throw new Error("nothing has rendered yet");
    refSlot = 0;
    cellSlot = 0;
    effectSlot = 0;
    queued.length = 0;
    out = traceWarmGate(args.record, args.eligible, react, host);
    for (const q of queued) {
      const was = committed[q.slot];
      const same =
        was !== undefined &&
        was.deps.length === q.deps.length &&
        was.deps.every((d, i) => Object.is(d, q.deps[i]));
      if (same) continue;
      was?.cleanup?.();
      committed[q.slot] = { deps: q.deps, cleanup: q.effect() ?? undefined };
    }
  };

  return {
    render: (record, eligible): boolean => {
      args = { record, eligible };
      pass();
      return out;
    },
    value: (): boolean => out,
    unmount: (): void => {
      for (const c of committed) c?.cleanup?.();
      committed.length = 0;
    },
  };
}

describe("what counts as a record arriving", () => {
  it("keeps the arrival it already has while the same record is on screen", () => {
    const first = arrivalOf(NOTHING_ON_SCREEN, "A", true);
    expect(arrivalOf(first, "A", true)).toBe(first);
  });

  it("is a NEW arrival for a record that was on screen before", () => {
    // Identity, not equality. The reader who compares two runs by flipping
    // between them opens A a second time, and the second open re-fetches the
    // events and folds the whole trace again — a build, not a no-op.
    const first = arrivalOf(NOTHING_ON_SCREEN, "A", true);
    const second = arrivalOf(arrivalOf(first, "B", true), "A", true);
    expect(second).not.toBe(first);
  });

  it("is a new arrival when the surface stops being one with a trace", () => {
    const onScreen = arrivalOf(NOTHING_ON_SCREEN, "A", true);
    expect(arrivalOf(onScreen, "A", false)).not.toBe(onScreen);
  });
});

describe("the warm gate answers for the record that is on screen NOW", () => {
  it("is cold on the render that opens a record, and warm only once idle has come", () => {
    const h = host(true);
    const app = mount(h);
    // The render that opens the record is the chat's own render pass. A gate
    // that says "warm" here builds 9,320 rows in it, which is the one thing
    // this card's story forbids.
    expect(app.render("A", true)).toBe(false);
    h.fireIdle();
    expect(app.value()).toBe(true);
  });

  it("goes cold the moment a different record arrives", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    h.fireIdle();
    expect(app.render("B", true)).toBe(false);
  });

  it("does not count a record warm because it was warmed BEFORE — the reader flipping back", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    h.fireIdle();
    expect(app.value()).toBe(true);
    // A → B → back to A before B's warm-up ever ran, which is what comparing
    // two runs looks like. A gate that remembers only the last record it warmed
    // answers "warm" on this very render — the render that re-opens A — and the
    // trace builds itself beside the chat again.
    expect(app.render("B", true)).toBe(false);
    expect(app.render("A", true)).toBe(false);
    h.fireIdle();
    expect(app.value()).toBe(true);
  });

  it("counts the same session opened a second time as a record arriving", () => {
    const h = host(true);
    const app = mount(h);
    const opened = { id: "20260805-155913-624f5baf" };
    app.render(opened, true);
    h.fireIdle();
    expect(app.value()).toBe(true);
    // `openSession` fetches the events again and folds them again, so the
    // second open of the session already on screen has a whole trace to build.
    // Handing in the id would make that arrival invisible.
    expect(app.render({ id: "20260805-155913-624f5baf" }, true)).toBe(false);
  });

  it("never warms a surface that has no trace to warm", () => {
    const h = host(true);
    const app = mount(h);
    expect(app.render("A", false)).toBe(false);
    expect(h.idleCalls).toHaveLength(0);
    h.fireIdle();
    expect(app.value()).toBe(false);
  });

  it("forgets a warm record when the reader leaves the surface and comes back", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    h.fireIdle();
    expect(app.value()).toBe(true);
    // Into a fleet and back out: the trace unmounted in between, so what
    // returns is a record arriving, not a record still warm.
    expect(app.render("A", false)).toBe(false);
    expect(app.render("A", true)).toBe(false);
  });

  it("stays warm across renders that change nothing, and arms only once for them", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    h.fireIdle();
    expect(app.render("A", true)).toBe(true);
    expect(app.render("A", true)).toBe(true);
    expect(h.idleCalls).toHaveLength(1);
  });

  it("lets the record the reader left behind cancel, so only the one they landed on warms", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    app.render("B", true);
    h.fireIdle(); // both armed tasks fire; the cancelled one must refuse
    expect(app.value()).toBe(true);
    expect(app.render("A", true)).toBe(false);
  });

  it("cancels an unfinished warm-up when the view goes away", () => {
    const h = host(true);
    const app = mount(h);
    app.render("A", true);
    app.unmount();
    expect(h.cancelled).toEqual([42]);
  });
});
