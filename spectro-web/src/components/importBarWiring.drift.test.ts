// Card 440: the bar App shows is the one the tests read. The text and the
// details control are pinned in importBar.test.ts and ImportNoteBar.test.tsx;
// this reads App.tsx off disk (no DOM in this suite, house rule) and checks
// that App builds the bar from the whole imported stream and renders it
// through that component, with no second copy of the old sentence beside it.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));
const dialog = stripComments(read("./ImportDialog.tsx", import.meta.url));

function openImport(): string {
  const at = app.indexOf("  const openImport = ");
  if (at < 0) throw new Error("App declares no openImport");
  return app.slice(at, app.indexOf("\n  };\n", at));
}

describe("App shows the import bar card 440 describes", () => {
  it("counts the conversation from the imported stream it opened", () => {
    expect(openImport()).toMatch(/setImportBar\(\{[\s\S]*counts: conversationCounts\(events\),/);
  });

  // One call gives the notes and whether the file is an agent's transcript, so
  // the bar cannot carry the subagent note and still call the file a session.
  it("builds the notes for special kinds of file in one place", () => {
    // Card 473 added the found sentence as its own field, in the same call, and
    // card 605 (task 10) the count of tool results the file recorded no output for.
    expect(openImport()).toMatch(
      /\.\.\.importBarAbout\(lang, \{\s*kind,\s*subagent,\s*run,\s*extra: note,\s*found: foundNote,\s*toolOutputs: source\.toolOutputs,?\s*\}\),/,
    );
    expect(openImport()).not.toContain("importBarNote(");
  });

  it("renders the bar through ImportNoteBar, keyed by the session it describes", () => {
    expect(app).toMatch(
      /shownBar !== null && \(\s*<ImportNoteBar\s+key=\{shownBar\.sessionId\}\s+lang=\{lang\}\s+bar=\{shownBar\}/,
    );
    expect(app).not.toContain('"imp.bar"');
    expect(app).not.toContain('className="import-note-bar"');
  });
});

// Card 605, task 10: the dialog says the count of tool results without output
// for every way a file arrives (a paste or pick, a store row, a folder pick),
// read off the source each one loaded, and never off the format alone.
describe("the import dialog states the tool output note from the loaded source", () => {
  it("sets the note from toolOutputNote on all three load paths", () => {
    const calls = [...dialog.matchAll(/setNote\(toolOutputNote\(lang, (\w+(?:\.\w+)*)\)\)/g)].map(
      (m) => m[1],
    );
    expect(calls).toEqual(["source.toolOutputs", "result.source.toolOutputs", "run.source.toolOutputs"]);
    expect(dialog).not.toContain('kind === "vscode-agent"');
    expect(dialog).not.toContain("imp.vscodeNote");
  });
});

// Card 605, task 11 item 7: a pick of several session files says how many it
// holds; only a pick of none says no session was found.
describe("the import dialog names a pick of several sessions", () => {
  it("maps the many group to its own message with the count", () => {
    expect(dialog).toMatch(
      /group\.kind === "many"\) \{\s*setError\(t\(lang, "imp\.err\.manySessions", \{ n: group\.count \}\)\);/,
    );
    expect(dialog).toMatch(/group\.kind === "none"\) \{\s*setError\(t\(lang, "imp\.err\.noSession"\)\);/);
  });
});
