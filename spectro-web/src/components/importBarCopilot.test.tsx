// Card 605, task 12: what the import bar says about a GitHub Copilot session
// folder. Every value is invented.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { importBarAbout, importBarNote, type ImportBarState } from "./importBar";
import { ImportNoteBar } from "./ImportNoteBar";

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

describe("the bar says a session was still running when it was picked (item 4)", () => {
  const copilot = { sessionId: "s-1", live: { records: 1234 } };

  it("says it in both languages, with the count of records", () => {
    expect(importBarNote("en", { kind: "vscode-agent", copilot })).toBe(
      "This session was still running when it was picked; the import holds the 1,234 records written up to then.",
    );
    expect(importBarNote("de", { kind: "vscode-agent", copilot })).toBe(
      "Diese Session lief noch, als sie gewählt wurde; der Import enthält die 1.234 Einträge, die bis dahin geschrieben waren.",
    );
  });

  it("counts one record in the singular", () => {
    const one = { sessionId: "s-1", live: { records: 1 } };
    expect(importBarNote("en", { kind: "vscode-agent", copilot: one })).toBe(
      "This session was still running when it was picked; the import holds the 1 record written up to then.",
    );
    expect(importBarNote("de", { kind: "vscode-agent", copilot: one })).toBe(
      "Diese Session lief noch, als sie gewählt wurde; der Import enthält den 1 Eintrag, der bis dahin geschrieben war.",
    );
  });

  it("follows who recorded it, on the bar on screen", () => {
    const both = {
      ...copilot,
      workspace: { name: null, cwd: null, client: "github/cli", createdAt: "2026-11-10T08:00:00.000Z" },
    };
    const bar: ImportBarState = {
      sessionId: "import:vscode-agent:events.jsonl",
      file: "events.jsonl",
      stats: { lines: 1234, frames: 900, zeroLines: 0 },
      counts: { prompts: 1, answers: 1 },
      ...importBarAbout("en", { kind: "vscode-agent", copilot: both }),
    };
    const html = renderToStaticMarkup(<ImportNoteBar lang="en" bar={bar} onClose={() => {}} />);
    expect(html).toContain(
      "Recorded by github/cli on 2026-11-10. This session was still running when it was picked; the import holds the 1,234 records written up to then.",
    );
  });
});
