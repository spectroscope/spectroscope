// Card 604: the files tab's own cursor. It starts where a route opened the tab,
// stays where the person put it while a live session grows, follows the end
// otherwise, and steps from one file call to the next (C2: it never drives the
// session's stepper).

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { cursorLimit, initialCursor, stepCall, type Cursor } from "./cursor";
import { foldFiles } from "./fold";

const T0 = 1_760_000_000_000;

function stamp(events: object[]): RunEvent[] {
  return events.map((e, i) => ({ ts: T0 + i * 1000, ...e }) as unknown as RunEvent);
}

const call = (callId: string, name: string, input: unknown) => ({
  type: "tool_call",
  agentId: "main",
  callId,
  name,
  input,
});
const result = (callId: string) => ({
  type: "tool_result",
  agentId: "main",
  callId,
  output: "ok",
  isError: false,
  durationMs: 5,
});

/** File calls at 1, 4 and 8; a web fetch at 6 that is no file call. */
const EVENTS = stamp([
  { type: "run_start", runId: "r1", agentId: "main", prompt: "go", workspace: "/ws" },
  call("c1", "read_file", { path: "a.ts" }),
  result("c1"),
  { type: "user_message", text: "and now?" },
  call("c2", "edit_file", { path: "a.ts", old_string: "1", new_string: "2" }),
  result("c2"),
  call("w1", "web_fetch", { url: "https://example.com" }),
  result("w1"),
  call("c3", "run_command", { command: "echo hi > out.txt" }),
  result("c3"),
]);

const CALLS = foldFiles(EVENTS).calls;

describe("the files tab's cursor", () => {
  it("startsAtTheRouteEvent", () => {
    expect(initialCursor(EVENTS, EVENTS[7])).toEqual({ follow: false, at: 7 });
    expect(initialCursor(EVENTS, EVENTS[0])).toEqual({ follow: false, at: 0 });
    expect(initialCursor(EVENTS, null)).toEqual({ follow: true });
  });

  it("aStartFromAnotherSessionFollows", () => {
    const other = stamp([
      { type: "run_start", runId: "r2", agentId: "main", prompt: "x" },
      call("o1", "read_file", {}),
    ]);
    expect(initialCursor(EVENTS, other[1])).toEqual({ follow: true });
    // An equal copy is still another object: the start is matched by identity.
    expect(initialCursor(EVENTS, { ...EVENTS[4] } as RunEvent)).toEqual({ follow: true });
    // The twin: the very same object places the cursor.
    expect(initialCursor(EVENTS, EVENTS[4])).toEqual({ follow: false, at: 4 });
  });

  it("aPlacedCursorStaysWhenEventsArrive", () => {
    const longer = [...EVENTS, ...stamp([call("c9", "read_file", { path: "b.ts" }), result("c9")])];
    expect(longer.length).toBeGreaterThan(EVENTS.length);
    expect(cursorLimit({ follow: false, at: 5 }, EVENTS)).toBe(5);
    expect(cursorLimit({ follow: false, at: 5 }, longer)).toBe(5);
    // A cursor that follows the end moves with it.
    expect(cursorLimit({ follow: true }, EVENTS)).toBe(EVENTS.length - 1);
    expect(cursorLimit({ follow: true }, longer)).toBe(longer.length - 1);
  });

  it("stepCallMovesToTheNextFileCall", () => {
    expect(CALLS.map((c) => c.callIndex)).toEqual([1, 4, 8]);
    const at = (n: number): Cursor => ({ follow: false, at: n });
    // Forward: the web fetch at 6 and the results are no file calls.
    expect(stepCall(CALLS, at(1), EVENTS, 1)).toEqual(at(4));
    expect(stepCall(CALLS, at(4), EVENTS, 1)).toEqual(at(8));
    // Back.
    expect(stepCall(CALLS, at(8), EVENTS, -1)).toEqual(at(4));
    expect(stepCall(CALLS, at(4), EVENTS, -1)).toEqual(at(1));
    // From between two calls, to the nearest one in that direction.
    expect(stepCall(CALLS, at(6), EVENTS, 1)).toEqual(at(8));
    expect(stepCall(CALLS, at(6), EVENTS, -1)).toEqual(at(4));
    // A following cursor stands at the end: back is the last call, forward goes nowhere.
    expect(stepCall(CALLS, { follow: true }, EVENTS, -1)).toEqual(at(8));
    expect(stepCall(CALLS, { follow: true }, EVENTS, 1)).toEqual({ follow: true });
    // The ends hold.
    expect(stepCall(CALLS, at(8), EVENTS, 1)).toEqual(at(8));
    expect(stepCall(CALLS, at(1), EVENTS, -1)).toEqual(at(1));
    // Only the calls handed in count: with the first left out, back from 4 stays.
    expect(stepCall(CALLS.slice(1), at(4), EVENTS, -1)).toEqual(at(4));
  });
});
