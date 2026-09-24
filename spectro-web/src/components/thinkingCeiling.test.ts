// Card 418: how tall the open thinking body may grow. The owner's rule of
// 2026-09-24: half the chat pane's visible height ("lass mal immer fünfzig
// Prozent von dem Chatfenster probieren"), never under a minimum, and the
// minimum is today's 240 px ("240 passt").
//
// The rule is a pure function and is pinned here with numbers. The wiring that
// hands it the pane's height runs against a fake pane and a fake observer,
// because this suite has no DOM. The effect body Chat's hook runs,
// startThinkingCeiling, runs against a stand-in for the browser's
// ResizeObserver put on globalThis, so the observer it really builds is the
// one under test. thinkingCeiling.drift.test.ts pins the other half: that the
// stylesheet reads what is published here, that the chat pane is the element
// that publishes it, and that the hook hands React the cleanup.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  THINKING_BODY_MAX_VAR,
  THINKING_FLOOR_PX,
  startThinkingCeiling,
  thinkingCeilingPx,
  watchThinkingCeiling,
} from "./thinkingCeiling";

/** A pane whose height a test can move, recording every value set on its style. */
function fakePane(height: number) {
  const published: string[] = [];
  const pane = {
    clientHeight: height,
    style: {
      setProperty: (name: string, value: string): void => {
        published.push(`${name}: ${value}`);
      },
    },
  };
  return { pane, published };
}

/** An observer factory that hands the test its callback and counts what it was asked to do. */
function fakeObserver() {
  const seen = { callback: null as (() => void) | null, observed: [] as unknown[], disconnects: 0 };
  const make = (callback: () => void) => {
    seen.callback = callback;
    return {
      observe: (target: unknown): void => {
        seen.observed.push(target);
      },
      disconnect: (): void => {
        seen.disconnects += 1;
      },
    };
  };
  const fire = (): void => {
    if (seen.callback === null) throw new Error("no observer was created");
    seen.callback();
  };
  return { seen, make, fire };
}

describe("the open thinking body's ceiling", () => {
  it("keeps today's 240 px as the floor", () => {
    expect(THINKING_FLOOR_PX).toBe(240);
  });

  it("is half the chat pane's visible height where half is more than the floor", () => {
    expect(thinkingCeilingPx(1000)).toBe(500);
    expect(thinkingCeilingPx(737)).toBe(368.5);
    expect(thinkingCeilingPx(482)).toBe(241);
  });

  it("never goes under 240 px on a short pane", () => {
    expect(thinkingCeilingPx(480)).toBe(240);
    expect(thinkingCeilingPx(400)).toBe(240);
    expect(thinkingCeilingPx(150)).toBe(240);
    expect(thinkingCeilingPx(0)).toBe(240);
  });
});

describe("the chat pane publishes the ceiling on itself", () => {
  it("publishes before any observer callback, so the first paint has it even in a hidden window", () => {
    const { pane, published } = fakePane(900);
    const { make } = fakeObserver();
    watchThinkingCeiling(pane, make);
    expect(published).toEqual([`${THINKING_BODY_MAX_VAR}: 450px`]);
  });

  it("observes the pane itself and publishes again each time it resizes", () => {
    const { pane, published } = fakePane(900);
    const { seen, make, fire } = fakeObserver();
    watchThinkingCeiling(pane, make);
    expect(seen.observed).toEqual([pane]);

    pane.clientHeight = 600;
    fire();
    pane.clientHeight = 300;
    fire();
    expect(published).toEqual([
      `${THINKING_BODY_MAX_VAR}: 450px`,
      `${THINKING_BODY_MAX_VAR}: 300px`,
      `${THINKING_BODY_MAX_VAR}: 240px`,
    ]);
  });

  it("hands back a stop function that disconnects the observer", () => {
    const { pane } = fakePane(900);
    const { seen, make } = fakeObserver();
    const stop = watchThinkingCeiling(pane, make);
    expect(seen.disconnects).toBe(0);
    stop();
    expect(seen.disconnects).toBe(1);
  });

  it("still publishes once where no ResizeObserver exists", () => {
    const { pane, published } = fakePane(700);
    const stop = watchThinkingCeiling(pane, () => null);
    expect(published).toEqual([`${THINKING_BODY_MAX_VAR}: 350px`]);
    expect(() => stop()).not.toThrow();
  });
});

/** One ResizeObserver the code under test built, as the stand-in recorded it. */
interface BuiltObserver {
  callback: () => void;
  observed: unknown[];
  disconnects: number;
}

/**
 * Puts a stand-in ResizeObserver on globalThis, the name the real code reaches
 * for, and records every instance built from it.
 */
function stubResizeObserver(): BuiltObserver[] {
  const built: BuiltObserver[] = [];
  class StandIn {
    private readonly record: BuiltObserver;
    constructor(callback: () => void) {
      this.record = { callback, observed: [], disconnects: 0 };
      built.push(this.record);
    }
    observe(target: unknown): void {
      this.record.observed.push(target);
    }
    disconnect(): void {
      this.record.disconnects += 1;
    }
  }
  vi.stubGlobal("ResizeObserver", StandIn);
  return built;
}

describe("the effect Chat runs on its transcript scroller", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds a real ResizeObserver on the pane and publishes again when it fires", () => {
    const built = stubResizeObserver();
    const { pane, published } = fakePane(900);
    startThinkingCeiling(pane as unknown as HTMLElement);
    expect(built).toHaveLength(1);
    expect(built[0].observed).toEqual([pane]);

    pane.clientHeight = 600;
    built[0].callback();
    expect(published).toEqual([`${THINKING_BODY_MAX_VAR}: 450px`, `${THINKING_BODY_MAX_VAR}: 300px`]);
  });

  it("returns a cleanup that disconnects the observer it built", () => {
    const built = stubResizeObserver();
    const { pane } = fakePane(900);
    const cleanup = startThinkingCeiling(pane as unknown as HTMLElement);
    expect(cleanup).toBeTypeOf("function");
    expect(built[0].disconnects).toBe(0);
    cleanup?.();
    expect(built[0].disconnects).toBe(1);
  });

  it("publishes once and returns a harmless cleanup where the platform has no ResizeObserver", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    const { pane, published } = fakePane(700);
    const cleanup = startThinkingCeiling(pane as unknown as HTMLElement);
    expect(published).toEqual([`${THINKING_BODY_MAX_VAR}: 350px`]);
    expect(cleanup).toBeTypeOf("function");
    expect(() => cleanup?.()).not.toThrow();
  });

  it("does nothing and returns no cleanup before the scroller is mounted", () => {
    const built = stubResizeObserver();
    expect(startThinkingCeiling(null)).toBeUndefined();
    expect(built).toHaveLength(0);
  });
});
