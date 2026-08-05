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
import { attachSources, noteAnchors, sourceStats } from "./traceSource";
import { detectAndLoad } from "../import/detect";
import ccNoConvo from "../import/fixtures/cc-noconvo.jsonl?raw";
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

  it("counts only what really carries no conversation, on a real file", () => {
    // cc-noconvo.jsonl is nine records lifted verbatim out of real transcripts
    // in ~/.claude/projects: a queue operation with its content, a user turn,
    // a todo list of four items, an edited file with its snippet, a queued
    // command, a mode, a last-prompt, a custom-title and an assistant turn.
    //
    // Before card 141 this file reported seven silent lines out of nine, which
    // is what made the owner ask whether the importer was broken. Four of the
    // seven produce frames now. What is left is the three the census really
    // puts on the pile: mode says "normal" on every line of every file,
    // last-prompt is a pointer into the file, custom-title is its name.
    const { source } = detectAndLoad(ccNoConvo);
    const stats = sourceStats(source);
    expect(stats.lines).toBe(9);
    expect(stats.zeroLines).toBe(3);
    const silent = source.lines.filter((_, i) => ![...source.origin].includes(i));
    expect(silent.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
      "mode",
      "last-prompt",
      "custom-title",
    ]);
  });
});

// One record fans out to several frames all the time: an assistant line
// produces a turn_start, a text and a usage, sometimes a provider_info in front
// of them. Its notes belong on ONE of those rows, not on four, so the chip
// reads as a fact about the turn instead of as a repeated decoration.
describe("which row wears a line's notes", () => {
  const row = (seq: number, type: string, sourceLine?: number) => ({
    seq,
    dir: "in" as const,
    ts: 1,
    type,
    payload: {},
    ...(sourceLine === undefined ? {} : { sourceLine }),
  });

  it("puts them on the turn_start the line produced", () => {
    const anchors = noteAnchors([
      row(1, "provider_info", 7),
      row(2, "turn_start", 7),
      row(3, "text_delta", 7),
      row(4, "usage", 7),
    ]);
    expect(anchors.get(7)).toBe(2);
  });

  // A user line produces no turn_start at all: its first frame is a run_start,
  // a tool_result or an agent_message, whichever the record turned into.
  it("falls back to the line's first frame when there is no turn_start", () => {
    const anchors = noteAnchors([row(1, "tool_result", 4), row(2, "text_delta", 4)]);
    expect(anchors.get(4)).toBe(1);
  });

  // The ground row is a reading of WHERE the run stood, not of what the record
  // says, and it is emitted in front of everything the line produced. Measured
  // over the 167 session transcripts under ~/.claude/projects, 10 lines had
  // their chip taken by it, all of them "written by task-notification" moving
  // onto a row that reads "cwd A -> B": the file nowhere says the directory
  // move was written by a task-notification.
  it("does not let the ground row take the chip from the line's own frame", () => {
    const anchors = noteAnchors([
      row(1, "ground_info", 9),
      row(2, "tool_result", 9),
      row(3, "text_delta", 9),
    ]);
    expect(anchors.get(9)).toBe(2);
  });

  it("still prefers the turn_start over both", () => {
    const anchors = noteAnchors([row(1, "ground_info", 3), row(2, "turn_start", 3), row(3, "usage", 3)]);
    expect(anchors.get(3)).toBe(2);
  });

  // A ground move on a line that produced nothing else is the one place the
  // reading may wear the chip: it is the only row that line has.
  it("keeps the reading when it is the line's only row", () => {
    expect(noteAnchors([row(1, "ground_info", 5)]).get(5)).toBe(1);
  });

  it("keeps each line's anchor apart", () => {
    const anchors = noteAnchors([row(1, "turn_start", 1), row(2, "usage", 1), row(3, "turn_start", 2)]);
    expect([...anchors.entries()]).toEqual([
      [1, 1],
      [2, 3],
    ]);
  });

  it("has nothing to anchor on a session with no source at all", () => {
    expect(noteAnchors([row(1, "turn_start"), row(2, "usage")]).size).toBe(0);
  });
});
