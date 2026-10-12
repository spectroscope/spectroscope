// Card 504, last fix round: the Lab's chat folds only the events the Lab has
// stepped, so a live session's goal_info and loop_info waited in the dam and
// the Lab's gear had no goal to clear. Goal and loop are the session's present
// state, not part of the recording: on the live run the Lab's chat takes them
// from the live record, as the main chat does.

import { describe, expect, it } from "vitest";
import { initialState, type UiState } from "../state/reducer";
import { labChatState, liveGoalLoopShown } from "./labChatState";
import { read, stripComments } from "../testkit/source";

const LIVE: UiState = {
  ...initialState,
  goal: { stated: true, outcome: "tests pass", check: "npm test exits 0", file: "" },
  goalVerdict: { outcome: "not-met", evidence: "2 failing" },
  loop: {
    active: true,
    loopId: "l1",
    pacing: "fixed",
    prompt: "check the build",
    intervalSeconds: 300,
    nextAt: 1_800_000_000_000,
    reason: null,
    keepalive: false,
  } as UiState["loop"],
  runTurn: 3,
};

describe("the Lab chat's goal and loop", () => {
  it("come from the live record while the Lab shows the live run", () => {
    const shown = labChatState(initialState, LIVE);
    expect(shown.goal).toBe(LIVE.goal);
    expect(shown.goalVerdict).toBe(LIVE.goalVerdict);
    expect(shown.loop).toBe(LIVE.loop);
    expect(shown.runTurn).toBe(3);
    expect(shown.turns, "the stepped chat itself stays the Lab's").toBe(initialState.turns);
  });

  it("stay the Lab's own for an archive", () => {
    expect(labChatState(initialState, null)).toBe(initialState);
  });

  it("keep the same object when nothing differs, so the chat does not redraw", () => {
    const stepped = {
      ...initialState,
      goal: LIVE.goal,
      goalVerdict: LIVE.goalVerdict,
      loop: LIVE.loop,
      runTurn: 3,
    };
    expect(labChatState(stepped, LIVE)).toBe(stepped);
  });
});

// Last fix round 2026-10-12: stepped back, the chat beside an old step does
// not show the present goal and loop; at the live end it does.
describe("when the Lab chat takes the live goal and loop", () => {
  const live = { goal: LIVE.goal, goalVerdict: LIVE.goalVerdict, loop: LIVE.loop, runTurn: 3 };

  it("at the live end of the live run", () => {
    expect(liveGoalLoopShown(true, 0, live)).toBe(live);
  });

  it("not while the Lab is stepped back on the live run", () => {
    expect(liveGoalLoopShown(true, 1, live)).toBeNull();
    expect(liveGoalLoopShown(true, 40, live)).toBeNull();
  });

  it("not for an archive, and not without a live record", () => {
    expect(liveGoalLoopShown(false, 0, live)).toBeNull();
    expect(liveGoalLoopShown(true, 0, null)).toBeNull();
  });
});

describe("the wiring", () => {
  const lab = stripComments(read("./LabView.tsx", import.meta.url));
  const app = stripComments(read("../App.tsx", import.meta.url));

  it("LabView hands its Chat the live goal and loop on the live run only", () => {
    expect(lab).toMatch(
      /labChatState\(st\.ui, liveGoalLoopShown\(replay === null, st\.queue\.length, props\.liveStatus \?\? null\)\)/,
    );
    expect(lab).not.toMatch(/state=\{st\.ui\}/);
  });

  it("App passes the live record's state to the Lab", () => {
    expect(app).toMatch(/liveStatus=\{viewingLive \? live : null\}/);
  });
});
