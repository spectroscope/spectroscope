// Pins for how a lane is named. Imported Claude Code sessions carry a 26-char
// toolu_* id and a readable agent type in the label — the readable one belongs
// in the title, the id stays reachable as the chip.

import { describe, expect, it } from "vitest";
import { laneNames } from "./SpectrumView";

const lane = (id: string, label: string | null): { id: string; label: string | null } => ({ id, label });

describe("laneNames", () => {
  it("titles the lane with its label and demotes the id to the chip", () => {
    expect(laneNames(lane("toolu_01A09q9abcdefghijklmnop", "code-reviewer"))).toEqual({
      title: "code-reviewer",
      chip: "toolu_01A09q9abcdefghijklmnop",
    });
  });

  it("falls back to the id when there is no label — nothing is invented", () => {
    expect(laneNames(lane("main", null))).toEqual({ title: "main", chip: null });
  });

  it("treats a blank label as absent", () => {
    expect(laneNames(lane("main", "   "))).toEqual({ title: "main", chip: null });
  });

  it("trims a padded label", () => {
    expect(laneNames(lane("agent-2", " reviewer "))).toEqual({ title: "reviewer", chip: "agent-2" });
  });

  it("never repeats the title in the chip", () => {
    expect(laneNames(lane("worker-1", "worker-1"))).toEqual({ title: "worker-1", chip: null });
  });
});
