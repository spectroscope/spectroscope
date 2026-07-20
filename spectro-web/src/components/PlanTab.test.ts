// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The component itself is covered by the TypeScript build (npm run build) like
// every other component here; the pure status→label mapping is what can drift.

import { describe, expect, it } from "vitest";
import { statusLabel } from "./PlanTab";

describe("PlanTab statusLabel", () => {
  it("translates the three wire statuses to English labels (the default)", () => {
    expect(statusLabel("pending")).toBe("open");
    expect(statusLabel("in_progress")).toBe("running …");
    expect(statusLabel("completed")).toBe("done");
  });

  it("translates to German when the chrome language is de", () => {
    expect(statusLabel("pending", "de")).toBe("offen");
    expect(statusLabel("in_progress", "de")).toBe("läuft …");
    expect(statusLabel("completed", "de")).toBe("fertig");
  });

  it("passes unknown statuses through unchanged (forward compatibility)", () => {
    expect(statusLabel("blocked")).toBe("blocked");
    expect(statusLabel("blocked", "de")).toBe("blocked");
  });
});
