// Attaching an imported line's index to the trace row that came from it.
//
// The row and the event are two different objects, and the trace is not a fold
// over the stream alone (it also carries the frames THIS app sent). So the
// match runs on payload object identity, the same idiom swapTracePayloads
// already uses, and never on position: trace[i].seq === i + 1 happens to hold
// today, and a silent positional coupling is the same class of defect this
// card exists to remove.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { attachSources, sourceStats } from "./traceSource";
import { swapTracePayloads } from "./translate";

const ev = (text: string): RunEvent => ({ type: "text_delta", agentId: "main", text, ts: 1 });

/** Rows shaped like the trace's, in whatever order the caller hands over. */
const rowsFor = (events: readonly RunEvent[]) =>
  events.map((e, i) => ({ seq: i + 1, dir: "in" as const, ts: 1, type: e.type, payload: e as unknown }));

describe("attachSources", () => {
  it("matches rows by payload identity, not by position", () => {
    const events = [ev("a"), ev("b"), ev("c")];
    const origin = Int32Array.from([10, 11, 12]);
    // Deliberately shuffled: a positional implementation passes the naive test
    // and fails this one.
    const rows = [rowsFor(events)[2], rowsFor(events)[0], rowsFor(events)[1]];
    rows[0].payload = events[2];
    rows[1].payload = events[0];
    rows[2].payload = events[1];

    const out = attachSources(rows, events, origin);

    expect(out.map((r) => r.sourceLine)).toEqual([12, 10, 11]);
  });

  it("leaves a row untouched when no source matched", () => {
    const events = [ev("a")];
    const stranger = { seq: 1, dir: "out" as const, ts: 1, type: "user_message", payload: { hello: 1 } };
    const rows = [stranger];
    const out = attachSources(rows, events, Int32Array.from([3]));
    // Same object back: the memo and useSyncExternalStore rule swapTracePayloads
    // already obeys.
    expect(out[0]).toBe(rows[0]);
    expect(out[0].sourceLine).toBeUndefined();
  });

  it("leaves a frame the importer built without a source line", () => {
    const events = [ev("a"), ev("b")];
    const out = attachSources(rowsFor(events), events, Int32Array.from([-1, 4]));
    expect(out[0].sourceLine).toBeUndefined();
    expect(out[1].sourceLine).toBe(4);
  });

  it("survives a translation swap", () => {
    // The ordering pin. attachSources sets a field on the ROW; swapTracePayloads
    // spreads the row and replaces only its payload, so a row field survives.
    // Run it the other way round and the source is attached to payloads that
    // are no longer in the rows, and every frame silently loses its line.
    const original = [ev("hello"), ev("world")];
    const translated = [ev("hallo"), ev("welt")];
    const attached = attachSources(rowsFor(original), original, Int32Array.from([7, 8]));
    const swapped = swapTracePayloads(attached, original, translated);

    expect(swapped.map((r) => r.sourceLine)).toEqual([7, 8]);
    expect((swapped[0].payload as { text: string }).text).toBe("hallo");
  });

  it("never points past the end of the lines array", () => {
    const events = [ev("a"), ev("b")];
    // A short origin array must not invent an index for the events it does not
    // cover: an undefined read would land as NaN and render as a line number.
    const out = attachSources(rowsFor(events), events, Int32Array.from([1]));
    expect(out[0].sourceLine).toBe(1);
    expect(out[1].sourceLine).toBeUndefined();
  });

  it("returns the same array contents when there is nothing to attach", () => {
    const events = [ev("a")];
    const rows = rowsFor(events);
    const out = attachSources(rows, events, Int32Array.from([-1]));
    expect(out[0]).toBe(rows[0]);
  });
});

describe("sourceStats", () => {
  it("counts the lines that produced no frame at all", () => {
    // Four lines; line 1 produced two frames, line 3 produced one, lines 0 and
    // 2 produced none. The -1 frame is the importer's own and belongs to no
    // line, so it must not make line 0 look used.
    const stats = sourceStats({
      lines: ["a", "b", "c", "d"],
      origin: Int32Array.from([-1, 1, 1, 3]),
    });
    expect(stats.lines).toBe(4);
    expect(stats.frames).toBe(4);
    expect(stats.zeroLines).toBe(2);
  });

  it("reports no silent lines when every line produced a frame", () => {
    const stats = sourceStats({ lines: ["a", "b"], origin: Int32Array.from([0, 1]) });
    expect(stats.zeroLines).toBe(0);
  });

  it("counts every line as silent when the importer built everything", () => {
    const stats = sourceStats({ lines: ["a", "b"], origin: Int32Array.from([-1]) });
    expect(stats.zeroLines).toBe(2);
    expect(stats.frames).toBe(1);
  });
});
