// Card 605, task 12: what the import bar says about a GitHub Copilot session
// folder. Every value is invented.

import { describe, expect, it } from "vitest";
import { importBarNote } from "./importBar";

describe("the bar names who recorded a Copilot folder and when (item 2)", () => {
  const copilot = {
    sessionId: "s-ide",
    workspace: { name: "x", cwd: "/w", client: "copilot-intellij", createdAt: "2026-11-10T08:00:00.000Z" },
  };

  it("says it in both languages", () => {
    expect(importBarNote("en", { kind: "vscode-agent", copilot })).toBe(
      "Recorded by copilot-intellij on 2026-11-10.",
    );
    expect(importBarNote("de", { kind: "vscode-agent", copilot })).toBe(
      "Aufgezeichnet von copilot-intellij am 2026-11-10.",
    );
  });

  it("says nothing when the folder names no client or no readable date", () => {
    for (const workspace of [
      { ...copilot.workspace, client: null },
      { ...copilot.workspace, createdAt: null },
      { ...copilot.workspace, createdAt: "yesterday" },
    ]) {
      expect(importBarNote("en", { kind: "vscode-agent", copilot: { ...copilot, workspace } })).toBeNull();
    }
    expect(importBarNote("en", { kind: "vscode-agent", copilot: { sessionId: null } })).toBeNull();
  });

  it("comes before the tool output note", () => {
    expect(
      importBarNote("en", { kind: "vscode-agent", copilot, toolOutputs: { missing: 2, total: 5 } }),
    ).toBe(
      "Recorded by copilot-intellij on 2026-11-10. 2 of 5 tool results in this file recorded no output; those stay empty.",
    );
  });
});
