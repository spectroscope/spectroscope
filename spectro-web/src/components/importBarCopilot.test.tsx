// Card 605, task 12: what the import bar says about a GitHub Copilot session
// folder. Every value is invented.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { dict, t } from "../i18n/i18n";
import { importBarAbout, importBarNote, type ImportBarState } from "./importBar";
import { ImportNoteBar } from "./ImportNoteBar";
import { drive, type El } from "../testkit/driveComponent";
import { read } from "../testkit/source";

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

describe("the bar points a lone events.jsonl at its folder (item 6)", () => {
  const copilot = { sessionId: "s-folder", alone: true as const };

  it("says the file is part of a folder, in both languages", () => {
    expect(importBarNote("en", { kind: "vscode-agent", copilot })).toBe(
      "This file is part of a Copilot session folder. Pick the folder to load its name, its workspace and its file snapshots too.",
    );
    expect(importBarNote("de", { kind: "vscode-agent", copilot })).toBe(
      "Diese Datei gehört zu einem Copilot-Session-Ordner. Wähle den Ordner, um auch Namen, Arbeitsordner und Dateischnappschüsse zu laden.",
    );
  });

  it("offers the folder pick only for a file that arrived alone", () => {
    expect(importBarAbout("en", { kind: "vscode-agent", copilot }).copilotFolder).toEqual({
      sessionId: "s-folder",
    });
    expect(
      importBarAbout("en", { kind: "vscode-agent", copilot: { sessionId: "s-folder" } }).copilotFolder,
    ).toBeUndefined();
    expect(importBarAbout("en", { kind: "claude-code" }).copilotFolder).toBeUndefined();
  });

  const bar = (lang: "en" | "de"): ImportBarState => ({
    sessionId: "import:vscode-agent:events.jsonl",
    file: "events.jsonl",
    stats: { lines: 12, frames: 20, zeroLines: 0 },
    counts: { prompts: 2, answers: 2 },
    ...importBarAbout(lang, { kind: "vscode-agent", copilot }),
  });

  it("shows a button that opens the folder picker", () => {
    const en = renderToStaticMarkup(
      <ImportNoteBar lang="en" bar={bar("en")} onClose={() => {}} onPickFolder={() => {}} />,
    );
    expect(en).toContain(">Pick the session folder …</button>");
    expect(en).toMatch(/<input type="file" hidden="" webkitdirectory=""/);
    const de = renderToStaticMarkup(
      <ImportNoteBar lang="de" bar={bar("de")} onClose={() => {}} onPickFolder={() => {}} />,
    );
    expect(de).toContain(">Session-Ordner wählen …</button>");
  });

  it("shows no such button for any other import", () => {
    const plain: ImportBarState = {
      sessionId: "import:vscode-agent:events.jsonl",
      file: "events.jsonl",
      stats: { lines: 12, frames: 20, zeroLines: 0 },
      counts: { prompts: 2, answers: 2 },
      ...importBarAbout("en", { kind: "vscode-agent", copilot: { sessionId: "s-folder" } }),
    };
    const html = renderToStaticMarkup(
      <ImportNoteBar lang="en" bar={plain} onClose={() => {}} onPickFolder={() => {}} />,
    );
    expect(html).not.toContain("Pick the session folder");
    expect(html).not.toContain("webkitdirectory");
  });

  it("hands the picked folder's files on", () => {
    const got: File[][] = [];
    const picked = [{ name: "events.jsonl" }, { name: "workspace.yaml" }] as unknown as File[];
    drive(
      <ImportNoteBar
        lang="en"
        bar={bar("en")}
        onClose={() => {}}
        onPickFolder={(files) => got.push(files)}
      />,
      [ImportNoteBar],
      [
        (tree: El[]) => {
          const input = tree.find((el) => el.type === "input");
          const target = { files: picked, value: "x" };
          (input?.props.onChange as unknown as (e: { target: typeof target }) => void)({ target });
          expect(target.value).toBe("");
        },
      ],
    );
    expect(got).toEqual([picked]);
  });
});

describe("App opens the dialog with the folder the bar picked (item 6)", () => {
  const app = read("../App.tsx", import.meta.url);
  const dialog = read("./ImportDialog.tsx", import.meta.url);

  it("hands the files and the shown session id to the dialog", () => {
    expect(app).toMatch(
      /onPickFolder=\{\(files\) => \{\s*setImportPick\(\{ files, sameSession: shownBar\.copilotFolder\?\.sessionId \?\? null \}\);\s*setImportOpen\(true\);/,
    );
    expect(app).toMatch(
      /initialFiles=\{importPick\?\.files\}\s+sameSession=\{importPick\?\.sameSession \?\? null\}/,
    );
  });

  it("lets the bar's files go once the dialog closes or loads", () => {
    const openImport = app.slice(app.indexOf("  const openImport = "), app.indexOf("setImportBar({"));
    expect(openImport).toMatch(/setImportOpen\(false\);\s*setImportPick\(null\);/);
    expect(app).toMatch(/onClose=\{\(\) => \{\s*setImportOpen\(false\);\s*setImportPick\(null\);/);
  });

  it("replaces the history entry only for the same session", () => {
    expect(app).toMatch(/note,\s*replace \? "apply" : "gesture",\s*wires,?\s*\)/);
    expect(dialog).toMatch(/replacesShown\(got\.source, props\.sameSession\)/);
  });

  it("the dialog takes the bar's files once, as a pick", () => {
    expect(dialog).toMatch(
      /if \(props\.initialFiles !== undefined && !tookInitial\.current\) \{\s*tookInitial\.current = true;\s*takeFiles\(props\.initialFiles\);/,
    );
  });

  it("the dialog marks a lone file pick", () => {
    expect(dialog).toMatch(/const source = picked \? pickedAlone\(loaded\.source\) : loaded\.source;/);
    expect(dialog).toMatch(
      /load\(\s*raw,\s*file\.name,\s*undefined,\s*undefined,\s*\{[\s\S]*?\},\s*true,\s*\)/,
    );
  });
});

describe("the dialog names a lone side file instead of calling it invalid (item 7)", () => {
  const dialog = read("./ImportDialog.tsx", import.meta.url);

  it("says so in both languages", () => {
    expect(t("en", "imp.copilot.sideFile")).toBe(
      "This is a side file of a Copilot session folder. Pick the folder, or its events.jsonl.",
    );
    expect(t("de", "imp.copilot.sideFile")).toBe(
      "Das ist eine Nebendatei eines Copilot-Session-Ordners. Wähle den Ordner oder seine events.jsonl.",
    );
  });

  it("checks a single pick or drop for a side file before it loads", () => {
    expect(dialog).toMatch(
      /\.then\(\(raw\) => \{\s*(?:\/\/[^\n]*\n\s*)?if \(copilotSideFile\(file\.name, raw\)\) \{\s*setError\(t\(lang, "imp\.copilot\.sideFile"\)\);\s*return;\s*\}\s*load\(/,
    );
  });

  it("lets the file picker offer the yaml and markdown side files", () => {
    expect(dialog).toMatch(/accept="[^"]*\.yaml[^"]*"/);
    expect(dialog).toMatch(/accept="[^"]*\.md[^"]*"/);
  });
});

describe("the dialog and the sidebar name the Copilot format (item 8)", () => {
  const DASH = /[\u2013\u2014]/;

  it("the dialog's description names all three and suggests the folder for Copilot", () => {
    for (const lang of ["en", "de"] as const) {
      const hint = t(lang, "imp.hint", { path: "~/.claude/projects/…/*.jsonl" });
      expect(hint, lang).toMatch(/spectroscope/);
      expect(hint, lang).toMatch(/Claude[ -]Code/);
      expect(hint, lang).toMatch(/Copilot/);
      expect(hint, lang).not.toMatch(DASH);
    }
    expect(t("en", "imp.hint", { path: "P" })).toContain("pick its session folder");
    expect(t("de", "imp.hint", { path: "P" })).toContain("wähle ihren Session-Ordner");
  });

  it("the Import button's title names all three, suggests the folder, and has no dash", () => {
    for (const lang of ["en", "de"] as const) {
      const title = t(lang, "nav.importTitle");
      expect(title, lang).toMatch(/spectroscope/);
      expect(title, lang).toMatch(/Claude[ -]Code/);
      expect(title, lang).toMatch(/Copilot[ -]Session[ -]?[Oo]rdner|Copilot session folder/);
      expect(title, lang).not.toMatch(DASH);
    }
  });

  it("every new import sentence of task 12 has no dash", () => {
    const keys = Object.keys(dict).filter(
      (k) => k.startsWith("imp.copilot.") || k === "filesTab.snapshot.entry",
    );
    expect(keys.length).toBeGreaterThanOrEqual(12);
    for (const key of keys) {
      for (const lang of ["en", "de"] as const) expect(t(lang, key), `${key} ${lang}`).not.toMatch(DASH);
    }
  });
});
