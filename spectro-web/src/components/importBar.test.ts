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
import { childrenNote, shownImportBar, subagentNote } from "./importBar";

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

// Saying what the file is (card 152).
//
// A subagent transcript that imports as an ordinary session is a second false
// statement on top of the first: the reader is told this is a session, when it
// is one agent lifted out of somebody else's run. The file names its own agent
// on every line, and names the session it ran under and the kind of agent it
// was, so the bar can say all three without inventing any of them.
//
// The rule of import/sourceNotes.ts applies here word for word: a fact the file
// does not carry produces NOTHING. No empty clause, no placeholder id.
describe("what the bar says about a subagent transcript", () => {
  it("says nothing at all about an ordinary session", () => {
    expect(subagentNote("en", undefined)).toBeNull();
    expect(subagentNote("de", null)).toBeNull();
  });

  it("names the agent, its kind and the session it came out of", () => {
    const note = subagentNote("en", {
      agentId: "a0b476c3c018",
      sessionId: "902488ae-c4cf-49ef-a57c-cd914740bee2",
      attributionAgent: "general-purpose",
    });
    expect(note).toContain("a0b476c3c018");
    expect(note).toContain("902488ae-c4cf-49ef-a57c-cd914740bee2");
    expect(note).toContain("general-purpose");
  });

  it("says it in German too", () => {
    const note = subagentNote("de", { agentId: "a0b476c3c018", sessionId: "s-1" });
    expect(note).toContain("a0b476c3c018");
    expect(note).toContain("s-1");
    expect(note).not.toMatch(/\{[a-z]+\}/); // no unfilled slot reaches the screen
  });

  it("drops the session clause when the file does not name one", () => {
    const note = subagentNote("en", { agentId: "lone" }) ?? "";
    expect(note).toContain("lone");
    expect(note.toLowerCase()).not.toContain("session ");
    expect(note).not.toContain("undefined");
  });

  it("drops the kind clause when the file does not name one", () => {
    const note = subagentNote("en", { agentId: "lone", sessionId: "s-1" }) ?? "";
    expect(note).toContain("s-1");
    expect(note).not.toContain("undefined");
  });
});

// Card 291: the bar says what came along with the session.
//
// A run import merges the children's own transcripts into the stream, and the
// bar states the count. When some sidecars could not be joined it says that
// too — honest, like the worker chip: a silent skip would read as "the run had
// fewer children", which is a claim about somebody else's session.
describe("what the bar says about a run import's children", () => {
  it("says nothing about a lone-file import", () => {
    expect(childrenNote("en", undefined)).toBeNull();
    expect(childrenNote("de", null)).toBeNull();
  });

  it("says nothing when the run had no sidecars at all", () => {
    expect(
      childrenNote("en", { workspace: null, childrenMerged: 0, childrenSkipped: 0, childrenUnrecorded: 0 }),
    ).toBeNull();
  });

  it("counts the merged children, in both languages", () => {
    const run = {
      workspace: "/workspaces/demo",
      childrenMerged: 2,
      childrenSkipped: 0,
      childrenUnrecorded: 0,
    };
    expect(childrenNote("en", run)).toContain("2");
    expect(childrenNote("en", run)).toContain("merged");
    expect(childrenNote("de", run)).toContain("2");
    expect(childrenNote("de", run)).not.toMatch(/\{[a-z]+\}/);
    // Nothing was skipped, so nothing claims it was.
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("skip");
  });

  it("says when a workflow named an agent that left no transcript", () => {
    // Card 297: neither merged nor skipped — there was nothing there to skip.
    // Without its own clause the agent simply vanishes, and a run that
    // reports four agents shows three with nothing admitting the fourth.
    const run = { workspace: null, childrenMerged: 3, childrenSkipped: 0, childrenUnrecorded: 1 };
    expect(childrenNote("en", run)?.toLowerCase()).toContain("no transcript");
    expect(childrenNote("en", run)).toContain("1");
    expect(childrenNote("de", run)).toContain("1");
    expect(childrenNote("de", run)).not.toMatch(/\{[a-z]+\}/);
    // Nothing was skipped, so nothing claims it was.
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("skip");
  });

  it("stays silent about agents no run ever named", () => {
    const run = { workspace: null, childrenMerged: 2, childrenSkipped: 0, childrenUnrecorded: 0 };
    expect(childrenNote("en", run)?.toLowerCase()).not.toContain("transcript");
  });

  it("says when children were skipped", () => {
    const run = { workspace: null, childrenMerged: 1, childrenSkipped: 2, childrenUnrecorded: 0 };
    expect(childrenNote("en", run)?.toLowerCase()).toContain("skipped");
    expect(childrenNote("en", run)).toContain("2");
    expect(childrenNote("de", run)).toContain("2");
  });
});
