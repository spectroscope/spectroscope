// The bar that states what an import was: file, lines, frames, silent lines,
// and that nothing was written to disk. Its own comment says it belongs to the
// SESSION rather than to the dialog, and that is the whole rule: a bar naming a
// file the reader is no longer looking at is a label that means something
// different from what it says, which is the defect this card exists to remove.
//
// Found live: import a transcript, then click a stored session in the sidebar.
// The header eyebrow switches to "archive" and the bar keeps naming the
// imported file.
import { describe, expect, it } from "vitest";
import { shownImportBar } from "./importBar";

const bar = {
  sessionId: "import:claude-code:four-readings.jsonl",
  file: "four-readings.jsonl",
  stats: { lines: 3711, frames: 5602, zeroLines: 1304 },
  note: null,
};

describe("which session the import bar belongs to", () => {
  it("shows it for the session it describes", () => {
    expect(shownImportBar(bar, bar.sessionId)).toBe(bar);
  });

  it("drops it the moment another session is opened", () => {
    expect(shownImportBar(bar, "20260726-172215-1a2b3c4d")).toBeNull();
  });

  it("drops it when the reader goes back to the live session", () => {
    expect(shownImportBar(bar, null)).toBeNull();
  });

  it("has nothing to show when nothing was imported", () => {
    expect(shownImportBar(null, "20260726-172215-1a2b3c4d")).toBeNull();
    expect(shownImportBar(null, null)).toBeNull();
  });

  // A second import replaces the first: same shape, different id, and the old
  // bar must not survive the swap for even one render.
  it("shows the second import rather than the first", () => {
    const next = { ...bar, sessionId: "import:claude-code:other.jsonl", file: "other.jsonl" };
    expect(shownImportBar(next, next.sessionId)?.file).toBe("other.jsonl");
    expect(shownImportBar(bar, next.sessionId)).toBeNull();
  });
});
