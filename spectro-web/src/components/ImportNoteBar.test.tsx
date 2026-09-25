// Card 440: the import bar reads as a sentence, and the importer's own numbers
// (lines, frames, lines it could not match) sit one click away behind a small
// details control, for whoever wants to check them.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ImportBarState } from "./importBar";
import { ImportNoteBar } from "./ImportNoteBar";

const bar: ImportBarState = {
  sessionId: "import:claude-code:four-readings.jsonl",
  file: "four-readings.jsonl",
  stats: { lines: 3711, frames: 5602, zeroLines: 110 },
  counts: { prompts: 14, answers: 293 },
  note: null,
  agentTranscript: false,
};

const render = (lang: "en" | "de", state: ImportBarState = bar): string =>
  renderToStaticMarkup(<ImportNoteBar lang={lang} bar={state} onClose={() => {}} />);

describe("the import bar on screen", () => {
  it("says what was opened, as a status the reader can dismiss", () => {
    const html = render("en");
    expect(html).toContain('role="status"');
    expect(html).toContain("Opened four-readings.jsonl: 14 prompts, 293 answers.");
    expect(html).toMatch(/<button type="button" class="ghost">Close<\/button>/);
  });

  it("keeps the raw numbers behind a closed details control", () => {
    const html = render("en");
    expect(html).toMatch(
      /<details class="import-note-details"><summary>Details<\/summary>[^<]*<span>Lines in the file: 3,711 · Frames: 5,602 · Not matched: 110<\/span><\/details>/,
    );
    expect(html).not.toMatch(/<details[^>]*\sopen/);
  });

  it("keeps them there in German too", () => {
    const html = render("de");
    expect(html).toContain("four-readings.jsonl geöffnet: 14 Eingaben, 293 Antworten.");
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("Zeilen in der Datei: 3.711 · Frames: 5.602 · Nicht zugeordnet: 110");
    expect(html).toMatch(/<button type="button" class="ghost">Schließen<\/button>/);
  });

  // Owner call 2, option D: this bar has 110 unmatched lines, and still no
  // sentence outside the details control names lines or frames.
  it("shows the raw numbers only inside the details control", () => {
    const opened = { en: "Opened four-readings.jsonl", de: "four-readings.jsonl geöffnet" };
    for (const lang of ["en", "de"] as const) {
      const outside = render(lang).replace(/<details[\s\S]*<\/details>/, "");
      expect(outside, lang).toContain(opened[lang]);
      expect(outside, lang).not.toMatch(/\b(lines?|frames?|Zeilen?)\b|110/i);
    }
  });
});
