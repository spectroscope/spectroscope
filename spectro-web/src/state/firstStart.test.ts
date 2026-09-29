// Card 455: the order of the first-start dialogs. The mode screen comes first,
// only learn goes on to the tutorial question, and the backend sheet waits for
// both. One dialog at a time.

import { describe, expect, it } from "vitest";
import { firstStartDialog, lightTutorialAnswer } from "./firstStart";
import type { LevelingSnapshot } from "./leveling";

function snapshot(introSeen: boolean, mode: LevelingSnapshot["mode"] = "ladder"): LevelingSnapshot {
  return {
    mode,
    introSeen,
    level: 0,
    levelId: "dark-frame",
    ladder: { schemaVersion: 1, levels: [], criteria: [] },
    marks: {},
    remaining: [],
    history: [],
  };
}

describe("the first-start dialog order", () => {
  it("a fresh install shows the mode screen first, even with the backend sheet due", () => {
    expect(
      firstStartDialog({ modeChosen: false, viewMode: "learn", snapshot: snapshot(false), backendDue: true }),
    ).toBe("mode");
  });

  it("shows the mode screen before the leveling state has arrived", () => {
    expect(
      firstStartDialog({ modeChosen: false, viewMode: "learn", snapshot: null, backendDue: false }),
    ).toBe("mode");
  });

  it("after learn, the tutorial question comes next", () => {
    expect(
      firstStartDialog({ modeChosen: true, viewMode: "learn", snapshot: snapshot(false), backendDue: true }),
    ).toBe("tutorial");
  });

  it("after light, the tutorial question never shows, and the backend sheet waits for the answer", () => {
    const pending = firstStartDialog({
      modeChosen: true,
      viewMode: "light",
      snapshot: snapshot(false),
      backendDue: true,
    });
    expect(pending).not.toBe("tutorial");
    expect(pending).toBeNull();
    // Once the server has taken light's answer, the backend sheet follows.
    expect(
      firstStartDialog({
        modeChosen: true,
        viewMode: "light",
        snapshot: snapshot(true, "off"),
        backendDue: true,
      }),
    ).toBe("backend");
  });

  it("an existing home that answered the tutorial sees the mode screen once, then no tutorial", () => {
    expect(
      firstStartDialog({
        modeChosen: false,
        viewMode: "learn",
        snapshot: snapshot(true, "checklist"),
        backendDue: false,
      }),
    ).toBe("mode");
    for (const viewMode of ["learn", "light"] as const) {
      const after = firstStartDialog({
        modeChosen: true,
        viewMode,
        snapshot: snapshot(true, "checklist"),
        backendDue: false,
      });
      expect(after, viewMode).toBeNull();
      expect(after, viewMode).not.toBe("tutorial");
    }
  });

  it("the backend sheet shows once the questions are answered and it is due", () => {
    expect(
      firstStartDialog({ modeChosen: true, viewMode: "learn", snapshot: snapshot(true), backendDue: true }),
    ).toBe("backend");
    expect(firstStartDialog({ modeChosen: true, viewMode: "learn", snapshot: null, backendDue: true })).toBe(
      "backend",
    );
    expect(
      firstStartDialog({ modeChosen: true, viewMode: "learn", snapshot: snapshot(true), backendDue: false }),
    ).toBeNull();
  });
});

describe("what light answers for the tutorial question", () => {
  it("answers an open tutorial question with off, once the mode screen is done", () => {
    expect(lightTutorialAnswer({ modeChosen: true, viewMode: "light", snapshot: snapshot(false) })).toBe(
      "off",
    );
  });

  it("leaves an answered tutorial alone", () => {
    expect(
      lightTutorialAnswer({ modeChosen: true, viewMode: "light", snapshot: snapshot(true, "ladder") }),
    ).toBeNull();
  });

  it("does not answer for learn, nor before the mode screen is done, nor without a snapshot", () => {
    expect(
      lightTutorialAnswer({ modeChosen: true, viewMode: "learn", snapshot: snapshot(false) }),
    ).toBeNull();
    expect(
      lightTutorialAnswer({ modeChosen: false, viewMode: "light", snapshot: snapshot(false) }),
    ).toBeNull();
    expect(lightTutorialAnswer({ modeChosen: true, viewMode: "light", snapshot: null })).toBeNull();
    // The positive case beside the three negatives.
    expect(lightTutorialAnswer({ modeChosen: true, viewMode: "light", snapshot: snapshot(false) })).toBe(
      "off",
    );
  });
});
