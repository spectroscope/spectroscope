// The menu's only logic worth pinning is the NAME the file arrives under and
// the one case where the control must refuse. A folder of exports is read weeks
// later by someone who was not in the room: if the name loses the session or
// the date, the file is a mystery, and if a name can be steered by a label that
// came out of an imported file, the save dialog is not ours any more.

import { describe, expect, it } from "vitest";
import { exportPlan } from "./ExportMenu";

/** Pinned so the stamp is the same on every machine and in every zone. */
const NOW = Date.UTC(2026, 6, 27, 12, 3, 0);

const plan = (over: Partial<Parameters<typeof exportPlan>[0]> = {}) =>
  exportPlan({ kind: "chat", count: 7, label: "20260727-090503-ab12cd34", now: NOW, ...over });

describe("exportPlan — the file names", () => {
  it("names the html after the view, the session and the moment", () => {
    expect(plan().htmlName).toBe("spectroscope-chat-20260727-090503-ab12cd34-20260727-1203.html");
  });

  it("names the text feed's html after ITS view", () => {
    expect(plan({ kind: "text" }).htmlName).toBe(
      "spectroscope-text-20260727-090503-ab12cd34-20260727-1203.html",
    );
  });

  it("names the jsonl after the session and the moment", () => {
    expect(plan().jsonlName).toBe("spectroscope-session-20260727-090503-ab12cd34-20260727-1203.jsonl");
  });

  it("says in the name which language a translated stream was exported in", () => {
    expect(plan({ translatedTo: "de" }).jsonlName).toBe(
      "spectroscope-session-20260727-090503-ab12cd34-20260727-1203.translated-de.jsonl",
    );
  });

  it("carries the same session and moment into both files", () => {
    // The point of the naming: the two exports of one click sort next to each
    // other, and a reader can tell they are two views of one session.
    const p = plan();
    expect(p.htmlName).toContain("20260727-090503-ab12cd34");
    expect(p.jsonlName).toContain("20260727-090503-ab12cd34");
    expect(p.htmlName).toContain("20260727-1203");
    expect(p.jsonlName).toContain("20260727-1203");
  });

  it("still says the kind and the date when there is no session label", () => {
    // A live view before the first run has no id. The name stays honest: it
    // claims a kind and a moment, and claims no session.
    const p = plan({ label: null });
    expect(p.htmlName).toBe("spectroscope-chat-20260727-1203.html");
    expect(p.jsonlName).toBe("spectroscope-session-20260727-1203.jsonl");
  });

  it("keeps the date when the label is long — truncation eats the label, never the stamp", () => {
    const p = plan({ label: "incident ".repeat(40) });
    expect(p.htmlName.endsWith("-20260727-1203.html")).toBe(true);
    expect(p.jsonlName.endsWith("-20260727-1203.jsonl")).toBe(true);
    expect(p.jsonlName.length).toBeLessThan(100);
  });

  it("never lets an imported file's name steer the save dialog", () => {
    // The label can be the name of a file someone else wrote.
    const p = plan({ label: '../../etc/passwd "x' });
    for (const name of [p.htmlName, p.jsonlName]) {
      expect(name).not.toContain("/");
      expect(name).not.toContain("..");
      expect(name).not.toContain('"');
    }
    expect(p.jsonlName).toContain("etc-passwd");
  });

  it("normalizes the language tag it prints", () => {
    expect(plan({ translatedTo: "pt-BR" }).jsonlName).toContain(".translated-pt-br.jsonl");
  });
});

describe("exportPlan — the empty view", () => {
  it("refuses a stream with nothing in it", () => {
    expect(exportPlan({ kind: "chat", count: 0, now: NOW }).enabled).toBe(false);
  });

  it("offers the export as soon as the stream carries one event", () => {
    expect(exportPlan({ kind: "chat", count: 1, now: NOW }).enabled).toBe(true);
  });

  it("still hands back usable names, so the disabled control has nothing to hide", () => {
    const p = exportPlan({ kind: "text", count: 0, now: NOW });
    expect(p.htmlName).toBe("spectroscope-text-20260727-1203.html");
    expect(p.jsonlName).toBe("spectroscope-session-20260727-1203.jsonl");
  });
});

describe("exportPlan — the jsonl target names the file", () => {
  // Three exports of one session land in one folder, and the extension is the
  // same for all three. Without a segment saying which shape is inside, the
  // only way to tell a Claude Code transcript from a spectroscope stream is to
  // open it.
  it("leaves the app's own format unmarked", () => {
    expect(exportPlan({ kind: "chat", count: 2, now: NOW, format: "spectroscope" }).jsonlName).toBe(
      "spectroscope-session-20260727-1203.jsonl",
    );
  });

  it("marks a Claude Code transcript", () => {
    expect(exportPlan({ kind: "chat", count: 2, now: NOW, format: "claude-code" }).jsonlName).toContain(
      ".claude-code.jsonl",
    );
  });

  it("marks a VS Code export", () => {
    expect(exportPlan({ kind: "chat", count: 2, now: NOW, format: "vscode" }).jsonlName).toContain(
      ".vscode.jsonl",
    );
  });

  it("keeps the language tag last, so a translated foreign export says both", () => {
    const name = exportPlan({
      kind: "chat",
      count: 2,
      now: NOW,
      format: "vscode",
      translatedTo: "de",
    }).jsonlName;
    expect(name).toContain(".vscode");
    expect(name.endsWith(".translated-de.jsonl")).toBe(true);
  });

  it("defaults to the app's own format when none was chosen", () => {
    expect(exportPlan({ kind: "chat", count: 2, now: NOW }).jsonlName).not.toContain(".vscode");
  });
});
