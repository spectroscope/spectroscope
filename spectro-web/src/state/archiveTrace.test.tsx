// Card 435: an archive's trace is built when it is first needed.
//
// Criterion 2: the fold without the trace gives today's chat state.
// Criterion 3: the lazy build gives today's rows, the merged llm-wire
// exchanges included, row by row over 10,044 events.
// Criterion 7, the unit half: the build runs in the slices of card 431's fold,
// reports its count and stops when its archive leaves the screen.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RunEvent } from "../events";
import { archiveEvents } from "../testkit/archiveEvents";
import { mergeLlmExchanges, type LlmExchangeMeta } from "../wire/llmWire";
import { buildTraceSliced, foldArchive, foldArchiveDeferred, foldArchiveDeferredSliced } from "./archiveFold";
import { createArchiveTrace, useArchiveRowCount, useRecordedTrace, type ArchiveTrace } from "./archiveTrace";
import { createOpenProgress } from "./openProgress";
import { initialState, reduceAll, type TraceEntry, type UiState } from "./reducer";
import { attachSources } from "./traceSource";
import { swapTracePayloads } from "./translate";

const EVENTS = archiveEvents(10_000);

/** Yields that resolve at once, and a budget of one event per slice unless a test names one. */
const INSTANT = { yieldToBrowser: () => Promise.resolve() };

/** A clock that moves one millisecond each time it is read. */
function tickingClock(): () => number {
  let t = 0;
  return () => t++;
}

/** The ids the fixture's own llm_exchange frames carry. */
const RECORDED_XIDS = EVENTS.filter((e) => e.type === ("llm_exchange" as string)).map(
  (e) => (e as unknown as { xid: string }).xid,
);

function exchange(xid: string, ts: number, durationMs: number): LlmExchangeMeta {
  return {
    xid,
    agentId: "root",
    turn: 1,
    kind: "chat",
    provider: "ollama",
    model: "m",
    transport: "http",
    url: "http://localhost:11434/api/chat",
    status: 200,
    requestBytes: 100,
    responseBytes: 200,
    responseLines: 3,
    aborted: false,
    fidelity: "bytes",
    durationMs,
    ts,
  };
}

/** An index as the server answers it: most exchanges are already frames in the
 *  file, a few are not, some of those with a duration (they bring a request row
 *  too) and one with none. */
const TS = EVENTS.map((e) => (e as { ts?: number }).ts ?? 0);
const INDEX: LlmExchangeMeta[] = [
  ...RECORDED_XIDS.slice(0, 50).map((xid, i) => exchange(xid, TS[100 + i], 20)),
  exchange("fresh-early", TS[3] + 0.5, 2),
  exchange("fresh-middle", TS[5000], 40),
  exchange("fresh-late", TS[TS.length - 1] + 10, 0),
  exchange("fresh-middle", TS[5000], 40),
];

/** The rows of a trace, once they have landed. */
function landed(trace: ArchiveTrace): Promise<TraceEntry[]> {
  const now = trace.read();
  if (now !== null) return Promise.resolve(now);
  return new Promise((resolve) => {
    const off = trace.subscribe(() => {
      const rows = trace.read();
      if (rows === null) return;
      off();
      resolve(rows);
    });
  });
}

/** Lets every pending promise run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the chat is unchanged (criterion 2)", () => {
  const today = foldArchive(EVENTS);

  it("today's fold holds turns, cards and agents, so an empty fold cannot pass", () => {
    expect(today.turns.length).toBeGreaterThan(100);
    expect(Object.keys(today.cards).length).toBeGreaterThan(100);
    expect(today.agents.length).toBeGreaterThan(1);
    expect(today.trace.length).toBe(EVENTS.length);
  });

  const compare = (got: UiState): void => {
    expect(got.turns.length).toBeGreaterThan(100);
    expect(Object.keys(got).sort()).toEqual(Object.keys(today).sort());
    for (const key of Object.keys(today) as Array<keyof UiState>) {
      if (key === "trace" || key === "traceDropped") continue;
      expect(got[key], key).toEqual(today[key]);
    }
    expect(got.trace).toEqual([]);
    expect(got.traceDropped).toBe(0);
  };

  it("in one go, field by field without trace and traceDropped", () => {
    compare(foldArchiveDeferred(EVENTS).state);
  });

  it("in slices, field by field without trace and traceDropped", async () => {
    let reports = 0;
    const folded = await foldArchiveDeferredSliced(EVENTS, {
      ...INSTANT,
      isCurrent: () => true,
      now: tickingClock(),
      budgetMs: 50,
      onProgress: () => reports++,
    });
    expect(folded).not.toBeNull();
    expect(reports).toBeGreaterThan(100);
    compare(folded!.state);
  });

  it("stops in slices like the fold it replaces", async () => {
    let current = true;
    let reports = 0;
    const folded = await foldArchiveDeferredSliced(EVENTS, {
      ...INSTANT,
      isCurrent: () => current,
      now: tickingClock(),
      budgetMs: 24,
      onProgress: () => {
        reports++;
        if (reports === 3) current = false;
      },
    });
    expect(folded).toBeNull();
    expect(reports).toBe(3);
  });
});

describe("the trace is unchanged when it opens (criterion 3)", () => {
  const todayRows = mergeLlmExchanges(foldArchive(EVENTS).trace, INDEX);

  it("the index merges something, so the comparison covers the merge", () => {
    expect(todayRows.length).toBe(EVENTS.length + 5);
    expect(todayRows.filter((r) => r.type === "llm_request").length).toBeGreaterThan(1);
  });

  const lazy = (index: string | null): ArchiveTrace =>
    createArchiveTrace(foldArchiveDeferred(EVENTS).recipe, index, {
      slicing: { ...INSTANT, now: tickingClock(), budgetMs: 200 },
      progress: createOpenProgress(() => 0),
    });

  it("builds today's rows, row by row, with the llm-wire exchanges merged", async () => {
    const trace = lazy("20260923-145313-ada4053d");
    trace.request();
    trace.supplyIndex(INDEX);
    const rows = await landed(trace);
    expect(rows).toHaveLength(todayRows.length);
    for (let i = 0; i < rows.length; i++) expect(rows[i], `row ${i}`).toStrictEqual(todayRows[i]);
  });

  it("builds today's rows for an archive with no index to ask (an import, a scenario)", async () => {
    const plain = foldArchive(EVENTS).trace;
    const trace = lazy(null);
    trace.request();
    const rows = await landed(trace);
    expect(rows).toHaveLength(EVENTS.length);
    for (let i = 0; i < rows.length; i++) expect(rows[i], `row ${i}`).toStrictEqual(plain[i]);
  });

  it("gives the import's line numbers and the translation's payloads what today's rows give them", async () => {
    const trace = lazy(null);
    trace.request();
    const rows = await landed(trace);
    const plain = foldArchive(EVENTS).trace;
    const origin = EVENTS.map((_, i) => (i % 7 === 0 ? -1 : i * 2));
    const sourced = attachSources(rows, EVENTS, origin);
    const sourcedToday = attachSources(plain, EVENTS, origin);
    expect(sourced.filter((r) => r.sourceLine !== undefined).length).toBeGreaterThan(1000);
    expect(sourced).toStrictEqual(sourcedToday);
    const translated = EVENTS.map((e, i) => (i % 5 === 0 ? ({ ...e } as RunEvent) : e));
    const swapped = swapTracePayloads(rows, EVENTS, translated);
    expect(swapped.filter((r, i) => r.payload !== rows[i].payload).length).toBeGreaterThan(1000);
    expect(swapped).toStrictEqual(swapTracePayloads(plain, EVENTS, translated));
  });

  it("stamps a frame without a ts with the clock of the fold, as the eager fold did", async () => {
    const events = [
      { type: "run_start", runId: "r1", agentId: "root", prompt: "p", model: "m1", ts: 5 },
      { type: "turn_start", agentId: "root", turn: 1 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 9 },
    ] as unknown as RunEvent[];
    const clock = vi.spyOn(Date, "now").mockReturnValue(111);
    const eager = reduceAll(initialState, events).trace;
    const folded = foldArchiveDeferred(events);
    clock.mockReturnValue(222);
    const trace = createArchiveTrace(folded.recipe, null, { slicing: INSTANT });
    trace.request();
    const rows = await landed(trace);
    expect(rows[1].ts).toBe(111);
    expect(rows).toStrictEqual(eager);
  });
});

describe("the build runs in slices, counts and stops (criterion 7)", () => {
  it("yields before every slice and reports rows built of the events, under the trace's id", async () => {
    const { recipe } = foldArchiveDeferred(EVENTS.slice(0, 500));
    const steps: string[] = [];
    const rows = await buildTraceSliced(recipe, {
      isCurrent: () => true,
      now: tickingClock(),
      budgetMs: 24,
      yieldToBrowser: () => {
        steps.push("yield");
        return Promise.resolve();
      },
      onProgress: (built, total) => {
        expect(total).toBe(500);
        steps.push(built === 0 ? "start" : "slice");
      },
    });
    expect(rows).toHaveLength(500);
    expect(steps.slice(0, 3)).toEqual(["start", "yield", "slice"]);
    expect(steps.filter((s) => s === "slice").length).toBeGreaterThan(10);
    for (let i = 1; i < steps.length; i++) {
      if (steps[i] === "slice") expect(steps[i - 1], `step ${i}`).toBe("yield");
    }
  });

  it("reports to its progress store under its own id", async () => {
    const progress = createOpenProgress(tickingClock());
    const seen: number[] = [];
    progress.subscribe(() => {
      const r = progress.read();
      if (r !== null) seen.push(r.ticket);
    });
    const trace = createArchiveTrace(foldArchiveDeferred(EVENTS.slice(0, 300)).recipe, null, {
      slicing: { ...INSTANT, now: tickingClock(), budgetMs: 10 },
      progress,
    });
    trace.request();
    await landed(trace);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set([trace.id]));
    expect(progress.read()).toEqual({ ticket: trace.id, folded: 300, total: 300 });
  });

  it("builds nothing before it is asked, and once however often it is asked", async () => {
    let yields = 0;
    const trace = createArchiveTrace(foldArchiveDeferred(EVENTS.slice(0, 200)).recipe, null, {
      slicing: {
        now: tickingClock(),
        budgetMs: 1000,
        yieldToBrowser: () => {
          yields++;
          return Promise.resolve();
        },
      },
    });
    await settle();
    expect(yields).toBe(0);
    expect(trace.read()).toBeNull();
    trace.request();
    trace.request();
    await landed(trace);
    trace.request();
    await settle();
    // One slice holds all 200 events at this budget: one yield before it.
    expect(yields).toBe(1);
  });

  it("waits for the index of a stored session before the rows land, and merges it", async () => {
    const trace = createArchiveTrace(foldArchiveDeferred(EVENTS).recipe, "s", {
      slicing: { ...INSTANT, now: tickingClock(), budgetMs: 500 },
    });
    let notified = 0;
    trace.subscribe(() => notified++);
    trace.request();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(trace.read()).toBeNull();
    expect(notified).toBe(0);
    trace.supplyIndex(INDEX);
    trace.supplyIndex([]); // the first index handed in counts
    const rows = await landed(trace);
    expect(rows).toHaveLength(EVENTS.length + 5);
    expect(notified).toBe(1);
    expect(trace.read()).toBe(rows);
  });

  it("stops before its next slice when its archive leaves the screen", async () => {
    let slices = 0;
    let trace: ArchiveTrace | null = null;
    trace = createArchiveTrace(foldArchiveDeferred(EVENTS).recipe, null, {
      slicing: { ...INSTANT, now: tickingClock(), budgetMs: 24 },
      progress: {
        report: (_id, built) => {
          if (built > 0) slices++;
          if (slices === 3) trace?.stop();
        },
        read: () => null,
        subscribe: () => () => {},
      },
    });
    trace.request();
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slices).toBe(3);
    expect(trace.read()).toBeNull();
    trace.request();
    await settle();
    expect(slices).toBe(3);
  });
});

describe("the one accessor (criterion 4, its behaviour)", () => {
  function Probe(props: { live: UiState; archive: ArchiveTrace | null }): string {
    const rows = useRecordedTrace(props.live, props.archive);
    return rows === null ? "none" : `rows:${rows.length}`;
  }
  const render = (live: UiState, archive: ArchiveTrace | null): string =>
    renderToStaticMarkup(<Probe live={live} archive={archive} />);

  it("hands the live fold's own rows through", () => {
    const live = reduceAll(initialState, EVENTS.slice(0, 40));
    expect(render(live, null)).toBe("rows:40");
  });

  it("hands an archive's rows through once they are built, and nothing before", async () => {
    const live = reduceAll(initialState, EVENTS.slice(0, 40));
    const trace = createArchiveTrace(foldArchiveDeferred(EVENTS.slice(0, 70)).recipe, null, {
      slicing: INSTANT,
    });
    expect(render(live, trace)).toBe("none");
    trace.request();
    await landed(trace);
    expect(render(live, trace)).toBe("rows:70");
  });
});

// Review finding 2 (2026-09-25): the trace tab's count came with the built
// rows, about 0.8 s after the chat, and the tabs to its right moved. The count
// is now known before a row is built: at once without an index to ask, and
// once the index is in with one. It must be the count the build gives.
describe("the count the trace tab shows before the rows", () => {
  const todayRows = mergeLlmExchanges(foldArchive(EVENTS).trace, INDEX);

  it("the fixture's own exchange frames overlap the index, so the count covers the dedupe", () => {
    expect(RECORDED_XIDS.length).toBeGreaterThanOrEqual(50);
    expect(todayRows.length).toBe(EVENTS.length + 5);
  });

  const traceOf = (index: string | null, events: RunEvent[] = EVENTS): ArchiveTrace =>
    createArchiveTrace(foldArchiveDeferred(events).recipe, index, {
      slicing: { ...INSTANT, now: tickingClock(), budgetMs: 500 },
      progress: createOpenProgress(() => 0),
    });

  it("holds the least number of rows, one per event, from the start", () => {
    expect(traceOf("s").leastRows).toBe(EVENTS.length);
    expect(traceOf(null).leastRows).toBe(EVENTS.length);
  });

  it("knows today's count once the index is in, before a row is built, and the build gives that count", async () => {
    const trace = traceOf("s");
    let told = 0;
    trace.subscribeCount(() => told++);
    expect(trace.rowCount()).toBeNull();
    trace.supplyIndex(INDEX);
    expect(trace.rowCount()).toBe(todayRows.length);
    expect(told).toBe(1);
    expect(trace.read()).toBeNull();
    trace.supplyIndex([]); // the first index handed in counts
    expect(trace.rowCount()).toBe(todayRows.length);
    expect(told).toBe(1);
    trace.request();
    const rows = await landed(trace);
    expect(rows).toHaveLength(todayRows.length);
    expect(trace.rowCount()).toBe(rows.length);
  });

  it("knows it at once when there is no index to ask (an import, a scenario)", async () => {
    const trace = traceOf(null);
    expect(trace.rowCount()).toBe(foldArchive(EVENTS).trace.length);
    trace.request();
    const rows = await landed(trace);
    expect(trace.rowCount()).toBe(rows.length);
  });

  it("counts an empty index, and one that brings only exchanges the file holds, as the merge does", () => {
    const events = EVENTS.slice(0, 2_000);
    const held = RECORDED_XIDS.filter((xid) =>
      events.some((e) => (e as unknown as { xid?: string }).xid === xid),
    );
    expect(held.length).toBeGreaterThan(0);
    const plain = foldArchive(events).trace;
    for (const index of [[], held.map((xid, i) => exchange(xid, TS[i], 20))]) {
      const trace = traceOf("s", events);
      trace.supplyIndex(index);
      expect(trace.rowCount()).toBe(mergeLlmExchanges(plain, index).length);
      expect(trace.rowCount()).toBe(events.length);
    }
  });

  it("hands the count through its hook: nothing before it is known, the number after", () => {
    function Probe(props: { archive: ArchiveTrace | null }): string {
      const count = useArchiveRowCount(props.archive);
      return count === null ? "unknown" : `count:${count}`;
    }
    const render = (archive: ArchiveTrace | null): string =>
      renderToStaticMarkup(<Probe archive={archive} />);
    const trace = traceOf("s");
    expect(render(null)).toBe("unknown");
    expect(render(trace)).toBe("unknown");
    trace.supplyIndex(INDEX);
    expect(render(trace)).toBe(`count:${todayRows.length}`);
    expect(render(traceOf(null))).toBe(`count:${EVENTS.length}`);
  });
});
