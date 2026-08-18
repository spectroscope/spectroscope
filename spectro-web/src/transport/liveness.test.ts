// The liveness verdict, as pure arithmetic on a clock nobody has to wait for.
//
// Card 261. The verdict is expensive to get wrong in one direction: the server
// aborts a session's run when its socket goes away, so calling a healthy socket
// dead costs the operator the run. Every test here is really about that
// asymmetry — how much silence, and how many unanswered questions, before the
// transport is allowed to say so.

import { describe, expect, it } from "vitest";
import {
  freshLiveness,
  livenessTick,
  LIVENESS_WINDOW_MS,
  noteInbound,
  PROBE_AFTER_SILENCE_MS,
  PROBES_BEFORE_DEAD,
  PROBE_TIMEOUT_MS,
  type LivenessState,
} from "./liveness";

/** Runs the watch forward over a list of instants, collecting the verdicts. */
function run(from: LivenessState, instants: number[]): { state: LivenessState; actions: string[] } {
  let state = from;
  const actions: string[] = [];
  for (const now of instants) {
    const step = livenessTick(state, now);
    state = step.state;
    actions.push(step.action);
  }
  return { state, actions };
}

/** Every tick instant from `from` to `to`, LIVENESS_TICK_MS apart. */
function everyTick(from: number, to: number, step = 5000): number[] {
  const out: number[] = [];
  for (let at = from + step; at <= to; at += step) out.push(at);
  return out;
}

describe("a socket that is delivering", () => {
  it("is never asked anything at all", () => {
    let state = freshLiveness(0);
    const actions: string[] = [];
    for (const now of everyTick(0, LIVENESS_WINDOW_MS * 3)) {
      state = noteInbound(state, now - 1); // a frame just landed
      const step = livenessTick(state, now);
      state = step.state;
      actions.push(step.action);
    }
    expect(actions.every((a) => a === "wait")).toBe(true);
  });

  it("resets on any frame, whatever it was", () => {
    // A pong, an event, a fleet roster — proof of delivery is proof of delivery.
    let state = freshLiveness(0);
    state = run(state, everyTick(0, PROBE_AFTER_SILENCE_MS + 5000)).state;
    expect(state.probeSentAt).not.toBeNull();

    state = noteInbound(state, 30000);
    expect(state).toEqual({ lastInboundAt: 30000, probeSentAt: null, unanswered: 0 });
  });
});

describe("a socket that has gone quiet", () => {
  it("is probed once the stated silence has passed, and not before", () => {
    const state = freshLiveness(0);
    expect(livenessTick(state, PROBE_AFTER_SILENCE_MS - 1).action).toBe("wait");
    expect(livenessTick(state, PROBE_AFTER_SILENCE_MS).action).toBe("probe");
  });

  it("answers the probe and goes quiet again without ever being condemned", () => {
    // The five-minute tool call: silence, a probe, a pong, silence again.
    let state = freshLiveness(0);
    let step = livenessTick(state, 15000);
    expect(step.action).toBe("probe");
    state = noteInbound(step.state, 15010); // the pong

    const later = run(state, everyTick(15010, 15010 + PROBE_AFTER_SILENCE_MS - 5000));
    expect(later.actions.filter((a) => a === "drop")).toEqual([]);
    step = livenessTick(later.state, 15010 + PROBE_AFTER_SILENCE_MS);
    expect(step.action).toBe("probe");
  });

  it("is called dead only after the stated number of probes went unanswered", () => {
    const { actions } = run(freshLiveness(0), everyTick(0, LIVENESS_WINDOW_MS));
    expect(actions.filter((a) => a === "probe").length).toBe(PROBES_BEFORE_DEAD);
    expect(actions.at(-1)).toBe("drop");
    // And nothing before the window is up.
    const before = run(freshLiveness(0), everyTick(0, LIVENESS_WINDOW_MS - 5000));
    expect(before.actions).not.toContain("drop");
  });

  it("states a window that is the sum of its parts", () => {
    expect(LIVENESS_WINDOW_MS).toBe(PROBE_AFTER_SILENCE_MS + PROBES_BEFORE_DEAD * PROBE_TIMEOUT_MS);
  });
});

describe("a clock that jumped", () => {
  it("never condemns a socket on arithmetic alone — a probe has to go out first", () => {
    // The laptop that slept for an hour. One tick, one enormous `now`, and the
    // watch has never sent anything: the only honest verdict is to ask.
    const state = freshLiveness(0);
    const step = livenessTick(state, 3600_000);
    expect(step.action).toBe("probe");
    expect(step.state.probeSentAt).toBe(3600_000);
    expect(step.state.unanswered).toBe(0);
  });

  it("still needs real time to pass between the probe and the verdict", () => {
    // The probe goes out at the wake instant; a tick in the same instant
    // cannot judge it, because no time has passed for an answer to arrive in.
    const woken = livenessTick(freshLiveness(0), 3600_000).state;
    expect(livenessTick(woken, 3600_000).action).toBe("wait");
    expect(livenessTick(woken, 3600_000 + PROBE_TIMEOUT_MS - 1).action).toBe("wait");
  });
});
