// Card 440: the bar App shows is the one the tests read. The text and the
// details control are pinned in importBar.test.ts and ImportNoteBar.test.tsx;
// this reads App.tsx off disk (no DOM in this suite, house rule) and checks
// that App builds the bar from the whole imported stream and renders it
// through that component, with no second copy of the old sentence beside it.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const app = stripComments(read("../App.tsx", import.meta.url));

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
    expect(openImport()).toMatch(/\.\.\.importBarAbout\(lang, \{ kind, subagent, run, extra: note \}\),/);
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
