// The file name is the only thing that survives the download folder.
//
// exportPlan folds the format marker into the same base that jsonlFilename caps
// at 64 characters, cutting from the END — so the marker is what gets eaten. The
// label budget was sized to protect the stamp and never accounted for the
// suffix that is appended after it.

import { describe, expect, it } from "vitest";
import { exportPlan } from "../components/ExportMenu";

/** 2026-07-28 14:37 UTC, the moment the live exports in this session were taken. */
const NOW = Date.UTC(2026, 6, 28, 14, 37);

describe("the jsonl file name keeps its format marker", () => {
  it("spells the marker out in full for a session id", () => {
    const plan = (format: "spectroscope" | "claude-code" | "vscode") =>
      exportPlan({
        kind: "chat",
        count: 266,
        label: "20260725-231417-2616ed6e",
        format,
        now: NOW,
      }).jsonlName;

    expect(plan("claude-code")).toContain(".claude-code.jsonl");
    expect(plan("vscode")).toContain(".vscode.jsonl");
  });

  // The case the marker exists for: a long label pushes the base to the cap on
  // its own, the suffix is truncated to nothing, and three different formats
  // land on ONE name — each export silently overwriting the last.
  it("gives three formats three names even when the label fills the budget", () => {
    const label = "incident-4712-postmortem-run";
    const name = (format: "spectroscope" | "claude-code" | "vscode") =>
      exportPlan({ kind: "chat", count: 266, label, format, now: NOW }).jsonlName;

    const names = [name("spectroscope"), name("claude-code"), name("vscode")];
    expect(new Set(names).size).toBe(3);
  });

  it("keeps the stamp no matter which format is chosen", () => {
    for (const format of ["spectroscope", "claude-code", "vscode"] as const) {
      const { jsonlName } = exportPlan({
        kind: "chat",
        count: 266,
        label: "incident-4712-postmortem-run",
        format,
        now: NOW,
      });
      expect(jsonlName).toContain("20260728-1437");
    }
  });
});
