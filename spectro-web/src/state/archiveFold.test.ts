// Card 431, stage 2: the archive fold in slices.
//
// Criterion 7: the sliced fold returns the state the one-shot fold returns.
// Criterion 8, the unit half: every slice is bounded by the budget and the fold
// yields to the browser between slices. Criterion 10: a superseded fold stops
// before its next slice and returns nothing. The browser half of criterion 8
// (long tasks and frame gaps on the owner's session) is measured in the card's
// evidence folder, not here.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { archiveEvents } from "../testkit/archiveEvents";
import { read, stripComments } from "../testkit/source";
import { SLICE_BUDGET_MS, foldArchive, foldArchiveSliced, yieldToBrowser } from "./archiveFold";
import { initialState, reduceAll, type UiState } from "./reducer";

const EVENTS = archiveEvents(10_000);

/** A clock that moves one millisecond each time it is read. */
function tickingClock(): () => number {
  let t = 0;
  return () => t++;
}

/** The event types reducer.ts folds, read off its source: the case labels and
 *  the `.type === "x"` checks of reduce, applyEvent and the agent roster. */
function foldedTypes(): Set<string> {
  const src = stripComments(read("./reducer.ts", import.meta.url));
  const roster = src.slice(src.indexOf("function foldAgents("), src.indexOf("function turnOwner("));
  const fold = src.slice(src.indexOf("export function reduce(state"), src.indexOf("export const reduceAll"));
  const text = roster + fold;
  return new Set([
    ...[...text.matchAll(/case "([a-z_]+)"/g)].map((m) => m[1]),
    ...[...text.matchAll(/\.type === "([a-z_]+)"/g)].map((m) => m[1]),
  ]);
}

describe("the fixture is a session worth folding", () => {
  it("has at least 10,000 events", () => {
    expect(EVENTS.length).toBeGreaterThanOrEqual(10_000);
  });

  it("covers every event type the reducer folds", () => {
    const folded = foldedTypes();
    // The reader is only as good as what it finds: a handful of types it must
    // see, or a changed source layout would make the set empty and this pass.
    for (const known of ["run_start", "tool_result", "user_message", "workspace_info", "agent_message"]) {
      expect(folded.has(known), known).toBe(true);
    }
    expect(folded.size).toBeGreaterThanOrEqual(30);
    const carried = new Set(EVENTS.map((e) => e.type as string));
    expect([...folded].filter((type) => !carried.has(type))).toEqual([]);
  });
});

describe("the sliced fold returns the one-shot state (criterion 7)", () => {
  const oneShot = foldArchive(EVENTS);

  it("folds turns, cards and agents, so an empty fold cannot pass", () => {
    expect(oneShot.turns.length).toBeGreaterThan(100);
    expect(Object.keys(oneShot.cards).length).toBeGreaterThan(100);
    expect(oneShot.agents.length).toBeGreaterThan(1);
    expect(oneShot.trace.length).toBe(EVENTS.length);
  });

  it("ends in a run the archive fold has to settle", () => {
    // The fixture's last run never ends, so the archive's normalizeReplay has
    // work to do, and a sliced fold that skipped it could not pass.
    const raw = reduceAll(initialState, EVENTS);
    expect(raw.running).toBe(true);
    expect(raw.pendingPermissions.length).toBeGreaterThan(0);
    expect(raw.pendingAsks.length).toBeGreaterThan(0);
    expect(oneShot.running).toBe(false);
    expect(oneShot.pendingPermissions).toEqual([]);
    expect(oneShot.pendingAsks).toEqual([]);
  });

  it("equals it field by field", async () => {
    let reports = 0;
    const sliced = await foldArchiveSliced(EVENTS, {
      isCurrent: () => true,
      onProgress: () => reports++,
      now: tickingClock(),
      budgetMs: 50,
      yieldToBrowser: () => Promise.resolve(),
    });
    expect(sliced).not.toBeNull();
    const got = sliced as UiState;
    // It really was sliced: one report before the first slice, one per slice.
    expect(reports).toBeGreaterThan(100);
    expect(Object.keys(got).sort()).toEqual(Object.keys(oneShot).sort());
    for (const key of Object.keys(oneShot) as Array<keyof UiState>) {
      expect(got[key], key).toEqual(oneShot[key]);
    }
  });

  it("equals it for an empty session", async () => {
    const sliced = await foldArchiveSliced([], {
      isCurrent: () => true,
      yieldToBrowser: () => Promise.resolve(),
    });
    expect(sliced).toEqual(foldArchive([]));
  });
});

describe("the fold yields to the browser between slices (criterion 8)", () => {
  it("ends a slice at the first event that reaches the budget, and yields before the next", async () => {
    // One clock read per event after the slice starts, one millisecond each:
    // a slice with a budget of n ms folds exactly n events.
    const steps: string[] = [];
    const sizes: number[] = [];
    let last = 0;
    await foldArchiveSliced(EVENTS.slice(0, 500), {
      isCurrent: () => true,
      now: tickingClock(),
      budgetMs: SLICE_BUDGET_MS,
      yieldToBrowser: () => {
        steps.push("yield");
        return Promise.resolve();
      },
      onProgress: (folded) => {
        steps.push(folded === 0 ? "start" : "slice");
        sizes.push(folded - last);
        last = folded;
      },
    });
    // The first report is the zero before any work; every one after it is a slice.
    const slices = sizes.slice(1);
    expect(slices.length).toBeGreaterThan(10);
    expect(Math.max(...slices)).toBeLessThanOrEqual(SLICE_BUDGET_MS);
    expect(slices.reduce((a, b) => a + b, 0)).toBe(500);
    // A yield comes before the first slice, so the JSON parse and the first
    // slice are two tasks, and one comes between every two slices.
    expect(steps.slice(0, 3)).toEqual(["start", "yield", "slice"]);
    for (let i = 1; i < steps.length; i++) {
      if (steps[i] === "slice") expect(steps[i - 1], `step ${i}`).toBe("yield");
    }
  });

  it("keeps the budget between the cost of yielding and a long task", () => {
    // Measured on the owner's big session on 2026-09-25, rounds alternating
    // with the one-shot fold (the card's evidence): a 12 ms budget made the
    // open 12 to 28 % slower in three sets, 24 ms between 0.4 % faster and
    // 5.7 % slower in four. Above 25 ms a slice plus a garbage collection pause
    // comes near the 50 ms that make a long task: at 48 ms, slices of 50 to
    // 53 ms were counted as long tasks.
    expect(SLICE_BUDGET_MS).toBeGreaterThanOrEqual(20);
    expect(SLICE_BUDGET_MS).toBeLessThanOrEqual(25);
  });

  it("yields through a real task boundary, not a microtask", async () => {
    let done = false;
    const pending = yieldToBrowser().then(() => {
      done = true;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(done).toBe(false);
    await pending;
    expect(done).toBe(true);
  });
});

describe("a superseded fold stops (criterion 10)", () => {
  it("runs no slice after the later navigation", async () => {
    let current = true;
    let reports = 0;
    let reportsAfter = 0;
    const result = await foldArchiveSliced(EVENTS, {
      isCurrent: () => current,
      now: tickingClock(),
      budgetMs: SLICE_BUDGET_MS,
      yieldToBrowser: () => Promise.resolve(),
      onProgress: () => {
        reports++;
        if (!current) reportsAfter++;
        // The second click lands while the third slice is done and the fold
        // is about to yield.
        if (reports === 4) current = false;
      },
    });
    expect(result).toBeNull();
    expect(reports).toBe(4);
    expect(reportsAfter).toBe(0);
  });

  it("runs no slice at all when the navigation came before the first one", async () => {
    let slices = 0;
    const result = await foldArchiveSliced(EVENTS, {
      isCurrent: () => false,
      yieldToBrowser: () => Promise.resolve(),
      onProgress: (folded) => {
        if (folded > 0) slices++;
      },
    });
    expect(result).toBeNull();
    expect(slices).toBe(0);
  });
});

describe("the fold reports how far it has got (criterion 9)", () => {
  it("counts from zero to the total, never backwards", async () => {
    const seen: Array<[number, number]> = [];
    const events: RunEvent[] = EVENTS.slice(0, 300);
    await foldArchiveSliced(events, {
      isCurrent: () => true,
      now: tickingClock(),
      yieldToBrowser: () => Promise.resolve(),
      onProgress: (folded, total) => seen.push([folded, total]),
    });
    expect(seen[0]).toEqual([0, 300]);
    expect(seen[seen.length - 1]).toEqual([300, 300]);
    for (let i = 1; i < seen.length; i++) expect(seen[i][0]).toBeGreaterThan(seen[i - 1][0]);
  });
});
