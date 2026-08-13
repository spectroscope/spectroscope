// Card 116, the disclosure half: the live window may drop rows, but the pane
// has to say so — and the number it says has to be a statement about the RECORD,
// not about the list the pane happens to draw.
//
// The reducer half is pinned in reducer.test.ts and it is exact: `traceDropped`
// counts record rows, and the row left on top carries seq `dropped + 1`. The
// pane, though, draws a list of its own making: `withResponseRows` splits every
// llm_exchange into two rows, `voiceRows` invents rows the socket never sent,
// and a synthetic system_context row sits on top at seq 0. Counting THAT list
// and calling the number "the record" is card 211's bug in a new place — two
// components with different beliefs about the same list.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduceAll, windowTrace, type TraceEntry } from "../state/reducer";
import { traceWithVoice } from "../wire/llmWire";
import { traceDisclosure } from "./traceDisclosure";
import { traceWindow } from "./traceWindow";

/** A stream of plain deltas — the cheapest thing that fills a window. */
const deltas = (n: number, from = 0): RunEvent[] =>
  Array.from(
    { length: n },
    (_, i) => ({ type: "text_delta", agentId: "main", text: "x", ts: from + i + 1 }) as RunEvent,
  );

/** One llm_exchange frame — the socket puts one in every live session since
 *  card 184 leg 3, and each one becomes TWO rows on screen. */
const exchange = (ts: number): RunEvent =>
  ({
    type: "llm_exchange",
    agentId: "main",
    xid: `x${ts}`,
    turn: 1,
    kind: "chat",
    provider: "p",
    model: "m",
    transport: "http",
    durationMs: 5,
    ts,
  }) as unknown as RunEvent;

describe("the disclosure counts the record, not the drawing (card 116)", () => {
  it("says nothing at all when the window never cut", () => {
    // A permanent "last 5000 of 5000" would teach the reader to ignore the line.
    const state = windowTrace(reduceAll(initialState, deltas(10)));
    expect(state.traceDropped).toBe(0);
    expect(traceDisclosure(state.trace, state.traceDropped)).toBeNull();
  });

  it("agrees with the seq of the first row of the record", () => {
    const state = windowTrace(reduceAll(initialState, deltas(9000)));
    const d = traceDisclosure(state.trace, state.traceDropped);
    expect(d).not.toBeNull();
    expect(d).toEqual({ shown: 5000, total: 9000, dropped: 4000, firstSeq: 4001 });
    // The two signals a reader will check against each other.
    expect(d?.firstSeq).toBe(d!.dropped + 1);
    expect(d?.firstSeq).toBe(state.trace[0].seq);
  });

  it("does not grow because the pane drew extra rows", () => {
    // THE DEFECT. The pane counted its own display list, which carries a second
    // row for every llm_exchange. The record dropped 4000 rows; the display list
    // is longer than the window, so the pane reported a total that never
    // existed and a "shown" no scrollbar could match.
    const frames = [...deltas(8996), exchange(8997), exchange(8998), exchange(8999), exchange(9000)];
    const state = windowTrace(reduceAll(initialState, frames));
    const display = traceWithVoice(state.trace, []);

    expect(state.trace.length).toBe(5000);
    expect(display.length).toBe(5004); // four exchanges, four extra rows
    expect(state.traceDropped).toBe(4000);

    const d = traceDisclosure(state.trace, state.traceDropped);
    expect(d?.shown).toBe(5000);
    expect(d?.total).toBe(9000);
    // What the display-counting version produced, and why it was wrong: a total
    // of 9004 for a run that streamed 9000 frames.
    expect(display.length + state.traceDropped).toBe(9004);
  });

  it("survives a record whose numbering the drawing renumbered", () => {
    // `traceWithVoice` renumbers the merged list from 1 when a voice exchange is
    // present, so the drawing's first seq is 1 while 4000 record rows are gone.
    // The disclosure reads the record, so it cannot be dragged along.
    const state = windowTrace(reduceAll(initialState, deltas(9000)));
    const d = traceDisclosure(state.trace, state.traceDropped);
    expect(d?.firstSeq).toBe(4001);
  });

  it("is empty-safe", () => {
    expect(traceDisclosure([] as TraceEntry[], 0)).toBeNull();
    expect(traceDisclosure([] as TraceEntry[], 12)).toBeNull();
  });
});

describe("the virtual window and the disclosure agree on how many rows exist", () => {
  // Card 211's bug was two components holding different beliefs about one list,
  // and this pane now has three readers of "how many rows": the disclosure, the
  // scrollbar arithmetic in traceWindow.ts, and the "{v} of {t}" count. They are
  // allowed to answer DIFFERENT questions — traceWindow is fed the filtered list
  // — but they must never disagree about the list they were handed.
  it("scrolls the whole window the disclosure claims is shown", () => {
    const state = windowTrace(reduceAll(initialState, deltas(9000)));
    const d = traceDisclosure(state.trace, state.traceDropped);
    expect(d?.shown).toBe(5000);

    // No filter, no open row: the virtual window is told exactly the rows the
    // disclosure says are on screen, and its spacers span all of them.
    const rowH = 20;
    const slice = traceWindow({
      scrollTop: 0,
      viewportH: 600,
      count: d!.shown,
      rowH,
      openIndex: -1,
      openH: 0,
      overscan: 8,
    });
    const spanned = slice.padTop + (slice.end - slice.start) * rowH + slice.padBottom;
    expect(spanned).toBe(d!.shown * rowH); // the scrollbar measures 5000 rows
    expect(slice.end).toBeLessThan(d!.shown); // and it did NOT build them all
  });

  it("never lets the window build a row the record does not have", () => {
    const state = windowTrace(reduceAll(initialState, deltas(9000)));
    const d = traceDisclosure(state.trace, state.traceDropped);
    const slice = traceWindow({
      scrollTop: 1e9, // scrolled past the end
      viewportH: 600,
      count: d!.shown,
      rowH: 20,
      openIndex: -1,
      openH: 0,
      overscan: 8,
    });
    expect(slice.end).toBeLessThanOrEqual(d!.shown);
    expect(state.trace[slice.end - 1]).toBeDefined();
  });
});
