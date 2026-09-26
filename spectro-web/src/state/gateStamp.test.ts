// Card 399: in auto mode no permission surface appears.
//
// The core emits permission_request, asks the broker, then emits
// permission_decision. In auto mode (and for a readonly session, and for a call
// the allowlist approves) the broker answers without asking anybody, so the two
// frames arrive one tick apart and the browser renders in between: the gate
// window opens for one frame and the working line drops out and comes back.
//
// The server now stamps such a request with `decidedBy` before it goes out,
// using the same labels the gate audit writes. These tests fold the event
// sequence one frame at a time and read the three things the owner sees at
// every step: the queue, the surface the queue draws, and the working line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { initialState, reduce, type UiState } from "./reducer";
import { gateQueue, gateSurface } from "./gateQueue";
import { showWorkingLine } from "../components/WorkingLine";

const CALL = "c399";

const runStart: RunEvent = {
  type: "run_start",
  runId: "r1",
  agentId: "main",
  prompt: "run the tests",
  provider: "anthropic",
  ts: 1000,
};

const toolCall: RunEvent = {
  type: "tool_call",
  agentId: "main",
  callId: CALL,
  name: "run_command",
  input: { command: "npm test" },
  ts: 1100,
};

/** The request exactly as a pre-card-399 server sends it: no stamp at all. */
const unmarkedRequest: RunEvent = {
  type: "permission_request",
  agentId: "main",
  callId: CALL,
  name: "run_command",
  input: { command: "npm test" },
  ts: 1200,
};

const markedRequest = (decidedBy: string): RunEvent => ({ ...unmarkedRequest, decidedBy }) as RunEvent;

const allowed: RunEvent = { type: "permission_decision", callId: CALL, allowed: true, ts: 1200 };

/** What the page draws after each dispatch: the fold, the gate surface in the
 *  chat and on the Lab, and whether the working line has a job. */
interface Frame {
  pending: number;
  surfaceChat: string;
  surfaceLab: string;
  workingLine: boolean;
}

function frameOf(state: UiState): Frame {
  const queue = gateQueue(state.pendingPermissions, []);
  return {
    pending: state.pendingPermissions.length,
    surfaceChat: gateSurface(queue, false),
    surfaceLab: gateSurface(queue, true),
    workingLine: showWorkingLine(state, true),
  };
}

/** Folds `events` onto a running session that has just made a tool call, and
 *  returns the frame before the first event plus one frame per event. */
function framesThrough(events: RunEvent[]): Frame[] {
  let state = reduce(reduce(initialState, runStart), toolCall);
  const frames = [frameOf(state)];
  for (const event of events) {
    state = reduce(state, event);
    frames.push(frameOf(state));
  }
  return frames;
}

describe("card 399, criterion 1: today's race, reproduced", () => {
  it("an unmarked request queues, opens the window and hides the working line until its decision", () => {
    const [before, afterRequest, afterDecision] = framesThrough([unmarkedRequest, allowed]);
    expect(before).toEqual({ pending: 0, surfaceChat: "none", surfaceLab: "none", workingLine: true });
    expect(afterRequest).toEqual({
      pending: 1,
      surfaceChat: "window",
      surfaceLab: "notice",
      workingLine: false,
    });
    expect(afterDecision).toEqual(before);
  });
});

describe("card 399, criterion 2: an already decided request never surfaces", () => {
  for (const decidedBy of ["mode:auto", "mode:readonly", "allowlist"]) {
    it(`a request stamped ${decidedBy} leaves the queue empty and the working line up across the pair`, () => {
      const decision: RunEvent = decidedBy === "mode:readonly" ? { ...allowed, allowed: false } : allowed;
      const frames = framesThrough([markedRequest(decidedBy), decision]);
      expect(frames).toHaveLength(3);
      for (const frame of frames) {
        expect(frame).toEqual({ pending: 0, surfaceChat: "none", surfaceLab: "none", workingLine: true });
      }
    });
  }
});

describe("card 399, criterion 3: a real ask is unchanged", () => {
  it("a request whose decidedBy is null queues exactly like an unmarked one", () => {
    const explicitNull = { ...unmarkedRequest, decidedBy: null } as RunEvent;
    expect(framesThrough([explicitNull, allowed])).toEqual(framesThrough([unmarkedRequest, allowed]));
  });

  it("the window stays open until the decision arrives, however many other frames pass", () => {
    const delta: RunEvent = { type: "text_delta", agentId: "worker-1", text: "meanwhile", ts: 1300 };
    const frames = framesThrough([unmarkedRequest, delta, delta, allowed]);
    expect(frames.slice(1, 4).map((f) => f.surfaceChat)).toEqual(["window", "window", "window"]);
    expect(frames.slice(1, 4).map((f) => f.workingLine)).toEqual([false, false, false]);
    expect(frames[4]?.surfaceChat).toBe("none");
  });
});

describe("card 399, criterion 6: an old recording stays a real ask", () => {
  // Recorded on 2026-07-23, before the stamp existed. Its request and its
  // decision carry the same millisecond.
  const RECORDING = new URL(
    "../../../docs/guide-assets/demo-home/.spectro/sessions/20260723-143524-pyspawn1.jsonl",
    import.meta.url,
  );
  const events = readFileSync(fileURLToPath(RECORDING), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as RunEvent);

  it("the fixture has a permission_request and no decidedBy anywhere", () => {
    expect(events.filter((e) => e.type === "permission_request")).toHaveLength(1);
    expect(readFileSync(fileURLToPath(RECORDING), "utf8")).not.toContain("decidedBy");
  });

  it("folding it up to its request queues the call, as a real ask", () => {
    const at = events.findIndex((e) => e.type === "permission_request");
    const request = events[at] as Extract<RunEvent, { type: "permission_request" }>;
    const state = events.slice(0, at + 1).reduce(reduce, initialState);
    expect(state.pendingPermissions.map((p) => p.callId)).toEqual([request.callId]);
    expect(gateSurface(gateQueue(state.pendingPermissions, []), false)).toBe("window");
  });
});
