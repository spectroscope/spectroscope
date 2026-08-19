import { describe, expect, it } from "vitest";
import { PROGRESS_FIELDS, armedState, progressSummary, type ProgressCounts } from "./progressSection";
import { reachOf } from "./settingsReach";
import { SETTINGS_TAB_SECTIONS, sectionsOfTab } from "./settingsTabs";
import { SETTINGS_SECTIONS } from "../state/route";

// Card 281: the guard's three numbers get a face, and the face cannot disagree
// with itself.
describe("the progress section", () => {
  it("stands in the permissions room and owns an address", () => {
    expect(SETTINGS_SECTIONS).toContain("progress");
    expect(sectionsOfTab("permissions")).toContain("progress");
    // Exactly one room, or a deep link has two places to land.
    const rooms = Object.entries(SETTINGS_TAB_SECTIONS).filter(([, sections]) =>
      (sections as readonly string[]).includes("progress"),
    );
    expect(rooms).toHaveLength(1);
  });

  it("puts all three counts in one block, and that block is next-session", () => {
    // Measured, not assumed: both attached faces build the guard inside the
    // agent build and nothing re-reads it. reachOf throws on a mixed block, so
    // this call IS the assertion.
    expect(reachOf(PROGRESS_FIELDS)).toBe("next-session");
    expect(PROGRESS_FIELDS).toHaveLength(3);
  });

  it("keeps the turn cap and the leash budget in blocks of their own", () => {
    // Card 282, criterion 7. continuationBudget is re-read per prompt and
    // maxTurns is bound at the agent build, so one sentence cannot cover both.
    expect(reachOf(["maxTurns"])).toBe("next-session");
    expect(reachOf(["continuationBudget"])).toBe("live");
    expect(() => reachOf(["maxTurns", "continuationBudget"])).toThrow();
  });
});

describe("armed is a predicate and not a rendered word", () => {
  // Card 281, criterion 3 and the twin of ProgressSettingsArmedTest.java, which
  // asserts the SAME table against ProgressSettings.armed(). -1 is included on
  // purpose: the Java guards are all `<= 0`, so a negative is off, and a UI
  // reading `!== 0` would draw it armed.
  it.each([
    [0, "off"],
    [-1, "off"],
    [1, "armed"],
    [3, "armed"],
  ])("%i is %s", (value, expected) => {
    expect(armedState(value)).toBe(expected);
  });
});

describe("the summary cannot disagree with the chips", () => {
  const counts = (w: number, f: number, p: number): ProgressCounts => ({
    progressGuardWrites: w,
    progressGuardFailures: f,
    progressGuardPlanTurns: p,
  });

  it("counts exactly the controls whose chip says armed", () => {
    // Fed by the same function, so the two cannot drift: the summary is derived
    // from armedState over the same record the chips read.
    for (const c of [counts(3, 3, 0), counts(0, 0, 0), counts(0, 1, -1), counts(5, 5, 5)]) {
      const armed = PROGRESS_FIELDS.filter((f) => armedState(c[f]) === "armed").length;
      expect(progressSummary(c).armed).toBe(armed);
    }
  });

  it("says nothing is watching rather than zero of three", () => {
    // "0 of 3" reads as a configuration; the off state is a different sentence,
    // and the card asks for it by name.
    expect(progressSummary(counts(0, 0, 0)).key).toBe("set.progress.summaryOff");
    expect(progressSummary(counts(3, 0, 0)).key).toBe("set.progress.summary");
    expect(progressSummary(counts(-1, -1, -1)).key).toBe("set.progress.summaryOff");
  });
});
