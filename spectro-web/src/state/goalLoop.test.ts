// Card 504: the goal and the loop on the page, as pure folds.

import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { t as translate } from "../i18n/i18n";
import { initialState, reduce, reduceAll, type UiState } from "./reducer";
import {
  clearGoalFrame,
  clockOf,
  goalFrame,
  loopChipView,
  parseGoalInfo,
  parseLoopInfo,
  stopLoopFrame,
  type LoopInfo,
} from "./goalLoop";

const ev = (e: Record<string, unknown>): RunEvent => ({ ts: 1, ...e }) as unknown as RunEvent;

const LOOP = {
  type: "loop_info",
  sessionId: "s1",
  active: true,
  loopId: "ab12cd34",
  pacing: "self",
  prompt: "watch the build",
  intervalSeconds: null,
  nextAt: new Date(2026, 9, 11, 10, 42, 0).getTime(),
  reason: "the build takes two minutes",
  keepalive: false,
  held: false,
  fires: 2,
  startedAt: 1,
  endedReason: null,
  endUnseen: false,
  maxTurns: 150,
};

describe("the frames", () => {
  it("reads a goal_info frame and refuses one without its flag", () => {
    expect(
      parseGoalInfo({
        type: "goal_info",
        stated: true,
        outcome: "tests green",
        check: "npm test",
        file: "/g",
      }),
    ).toEqual({ stated: true, outcome: "tests green", check: "npm test", file: "/g" });
    expect(parseGoalInfo({ type: "goal_info" })).toBeNull();
  });

  it("reads a loop_info frame and refuses one without its flag", () => {
    const loop = parseLoopInfo(LOOP) as LoopInfo;
    expect(loop.active).toBe(true);
    expect(loop.pacing).toBe("self");
    expect(loop.maxTurns).toBe(150);
    expect(loop.reason).toBe("the build takes two minutes");
    expect(parseLoopInfo({ type: "loop_info" })).toBeNull();
  });

  it("sends the goal, clears it with an empty one, and stops the loop", () => {
    expect(goalFrame(" tests green ", " npm test ")).toEqual({
      type: "set_goal",
      outcome: "tests green",
      check: "npm test",
    });
    expect(clearGoalFrame()).toEqual({ type: "set_goal", outcome: "", check: "" });
    expect(stopLoopFrame()).toEqual({ type: "set_loop", action: "stop" });
  });
});

describe("the loop chip", () => {
  it("says the turn of the live run, the next wakeup and its reason", () => {
    const view = loopChipView(parseLoopInfo(LOOP), 7);
    expect(view).toEqual({
      turn: { n: 7, of: 150 },
      next: "10:42",
      reason: "the build takes two minutes",
      held: false,
      keepalive: false,
    });
  });

  it("says no turn between runs and nothing without a loop", () => {
    expect(loopChipView(parseLoopInfo(LOOP), null)?.turn).toBeNull();
    expect(loopChipView(null, 3)).toBeNull();
    expect(loopChipView(parseLoopInfo({ ...LOOP, active: false, endedReason: "user_abort" }), 3)).toBeNull();
  });

  it("writes the wall clock as HH:MM", () => {
    expect(clockOf(new Date(2026, 0, 2, 7, 5).getTime())).toBe("07:05");
  });
});

describe("the reducer", () => {
  it("keeps the goal in force from goal_info and the last verdict from goal_check", () => {
    let s: UiState = reduce(
      initialState,
      ev({
        type: "goal_info",
        sessionId: "s1",
        stated: true,
        outcome: "tests green",
        check: "npm test",
        file: "/g",
      }),
    );
    expect(s.goal?.outcome).toBe("tests green");
    s = reduce(
      s,
      ev({
        type: "goal_check",
        agentId: "main",
        outcome: "unmet",
        command: "npm test",
        exitCode: 1,
        judge: "exit_code",
        output: "",
        durationMs: 1,
        evidence: "exit 1",
      }),
    );
    expect(s.goalVerdict).toEqual({ outcome: "unmet", evidence: "exit 1" });
    s = reduce(s, ev({ type: "goal_info", stated: "broken" }));
    expect(s.goal?.outcome).toBe("tests green");
  });

  it("draws the two verdicts the Java check sends, failed and untested, with their own sentences", () => {
    // Live check 2026-10-12: the command check sends "failed", which the chat
    // drew through the fallback and the goal line not at all.
    for (const outcome of ["failed", "untested"]) {
      const s = reduce(
        initialState,
        ev({
          type: "goal_check",
          agentId: "main",
          outcome,
          command: "c",
          exitCode: 1,
          judge: "exit_code",
          output: "",
          durationMs: 1,
          evidence: "e",
        }),
      );
      const line = s.turns[s.turns.length - 1];
      expect(line.kind === "info" && line.infoKey).toBe(`info.goalCheck.${outcome}`);
    }
  });

  it("draws the cleared goal as its own line", () => {
    const s = reduce(
      initialState,
      ev({
        type: "goal_check",
        agentId: "main",
        outcome: "cleared",
        command: "npm test",
        exitCode: null,
        judge: "",
        output: "",
        durationMs: 0,
        evidence: "Goal cleared after an unrecoverable error (authentication)",
      }),
    );
    const line = s.turns[s.turns.length - 1];
    expect(line.kind).toBe("info");
    expect(line.kind === "info" && line.infoKey).toBe("info.goalCheck.cleared");
    expect(line.kind === "info" && line.infoVars?.reason).toBe("authentication");
    expect(s.goalVerdict?.outcome).toBe("cleared");
  });

  it("draws the goal's continuation as its own line", () => {
    const s = reduce(
      initialState,
      ev({
        type: "continuation",
        agentId: "main",
        decision: "goal_continued",
        continuation: 2,
        budget: 150,
        openSteps: 0,
        totalSteps: 0,
        inputTokens: 1,
        evidence: "continued",
      }),
    );
    const line = s.turns[s.turns.length - 1];
    expect(line.kind === "info" && line.infoKey).toBe("info.continuation.goal_continued");
  });

  it("keeps the loop from loop_info and says once why it ended", () => {
    let s = reduce(initialState, ev(LOOP));
    expect(s.loop?.active).toBe(true);
    expect(s.turns).toHaveLength(0);
    for (const reason of ["model_stopped", "aged_out", "user_abort"]) {
      let t = reduce(s, ev({ ...LOOP, active: false, nextAt: null, endedReason: reason }));
      t = reduce(t, ev({ ...LOOP, active: false, nextAt: null, endedReason: reason }));
      const lines = t.turns.filter(
        (turn) => turn.kind === "info" && turn.infoKey === `info.loop.ended.${reason}`,
      );
      expect(lines).toHaveLength(1);
      expect(t.loop?.active).toBe(false);
    }
    s = reduce(s, ev({ type: "loop_info" }));
    expect(s.loop?.active).toBe(true);
  });

  it("writes the end line a page missed when the server says nobody heard it (fix round 1)", () => {
    for (const reason of ["model_stopped", "aged_out", "user_abort"]) {
      // A fresh page attaches to a session whose loop ended while no window had it.
      const told = { ...LOOP, active: false, nextAt: null, endedReason: reason, endUnseen: true };
      let t = reduce(initialState, ev(told));
      t = reduce(t, ev(told));
      const lines = t.turns.filter(
        (turn) => turn.kind === "info" && turn.infoKey === `info.loop.ended.${reason}`,
      );
      expect(lines, reason).toHaveLength(1);
      expect(t.loop?.endUnseen).toBe(true);
      // The same end, heard before: a later page draws nothing.
      const heard = reduce(initialState, ev({ ...told, endUnseen: false }));
      expect(heard.turns, reason).toHaveLength(0);
    }
  });

  it("names both causes of model_stopped: a stop the model asked for and a missed tick (fix round 2)", () => {
    // LoopDriver ends a loop model_stopped for schedule_wakeup with stop: true
    // (the task is done) and for the second tick without a wakeup.
    const en = translate("en", "info.loop.ended.model_stopped");
    expect(en).toMatch(/model stopped it/);
    expect(en).toMatch(/no next wakeup/);
    const de = translate("de", "info.loop.ended.model_stopped");
    expect(de).toMatch(/Modell hat sie gestoppt/);
    expect(de).toMatch(/keinen nächsten Weckruf/);
  });

  it("writes one line when the end is seen as a change and carries the flag too", () => {
    let s = reduce(initialState, ev(LOOP));
    s = reduce(s, ev({ ...LOOP, active: false, nextAt: null, endedReason: "user_abort", endUnseen: true }));
    expect(s.turns.filter((turn) => turn.kind === "info")).toHaveLength(1);
  });

  it("follows the root run's turn while it is live", () => {
    const s = reduceAll(initialState, [
      ev({ type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", model: "m" }),
      ev({ type: "turn_start", agentId: "main", turn: 1 }),
      ev({ type: "turn_start", agentId: "w1", turn: 5 }),
      ev({ type: "turn_start", agentId: "main", turn: 2 }),
    ]);
    expect(s.runTurn).toBe(2);
    expect(reduce(s, ev({ type: "run_end", runId: "r1", stopReason: "end_turn" })).runTurn).toBeNull();
  });
});
