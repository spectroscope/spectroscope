// Trace detail modes: one wire line per frame; session_resume = the whole
// history as JSONL lines; wire/compact text is line-identical.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import {
  SOURCE_DISPLAY_CHARS,
  copyLabel,
  detailLines,
  detailText,
  sourcePane,
  sourceSentence,
  traceProvenance,
  withinBudget,
} from "./traceDetail";
import type { WithSource } from "../state/traceSource";

const history = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
  { type: "text_delta", agentId: "main", text: "line1\nline2", ts: 2 },
] as RunEvent[];

describe("detailLines", () => {
  it("renders an ordinary frame as exactly one line", () => {
    const lines = detailLines("tool_call", { name: "read_file", input: { path: "a" } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('{"name":"read_file","input":{"path":"a"}}');
  });

  it("renders session_resume as one JSONL line per history event", () => {
    const lines = detailLines("session_resume", { sessionId: "s", history });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"type":"run_start"');
    // real newlines inside a field stay escaped - the line is ONE wire line
    expect(lines[1]).toContain("\\n");
    expect(lines[1].includes("\n")).toBe(false);
  });

  it("falls back to the plain payload when session_resume has no history", () => {
    expect(detailLines("session_resume", { sessionId: "s" })).toHaveLength(1);
  });
});

describe("detailText", () => {
  it("joins compact/wire lines with real newlines and pretty-prints insight", () => {
    const payload = { sessionId: "s", history };
    expect(detailText("wire", "session_resume", payload).split("\n")).toHaveLength(2);
    expect(detailText("compact", "session_resume", payload)).toBe(
      detailText("wire", "session_resume", payload),
    );
    expect(detailText("insight", "session_resume", payload)).toContain("\n  ");
  });
});

// The source pane. Every case is a pure function of two things: whether an
// import is loaded at all, and whether THIS frame was read from one of its
// lines. Nothing here guesses.

/** A row as the pane sees it: a payload to key on, the frame's own type and
 *  direction, and maybe a line index. An ordinary inbound wire event unless a
 *  test says otherwise, because that is what most rows are. */
const row = (
  payload: string,
  sourceLine?: number,
  type = "text_delta",
  dir: "in" | "out" = "in",
): { payload: unknown; type: string; dir: "in" | "out" } & WithSource =>
  sourceLine === undefined ? { payload, type, dir } : { payload, type, dir, sourceLine };

const FILE = ["line zero", "line one", "line two", "line three"];

describe("sourcePane", () => {
  // A native session HAS no separate source, and saying so is not the same as
  // saying "nothing here". The wire line IS the stored line for these, byte for
  // byte, which is the claim export/jsonl.ts pins across 8882 lines.
  it("says the wire line is the stored line when there is no import", () => {
    const r = row("a");
    expect(sourcePane(r, [r], null, "stored").kind).toBe("none");
    expect(sourcePane(r, [r], undefined, "stored").kind).toBe("none");
  });

  // The synthetic system_context at seq 0, the up-front provider_info, the
  // closing run_end: real frames that no single line of the file produced.
  it("says the importer built a frame with no source line", () => {
    const r = row("a");
    expect(sourcePane(r, [r], FILE, "stored").kind).toBe("built");
  });

  it("hands back the whole line, and counts it from one", () => {
    const r = row("a", 2);

    expect(sourcePane(r, [r], FILE, "stored")).toEqual({
      kind: "line",
      text: "line two",
      lineNumber: 3, // the number a reader counts to when opening the file
      total: 4,
      siblings: 1,
      ordinal: 1,
    });
  });

  // 2599 of 6431 records in the measured file fan out to exactly three frames.
  // Three rows then carry the same line, and a pane that showed it three times
  // without saying so would look like a bug in the importer.
  it("counts the siblings of a shared line", () => {
    const rows = [row("a", 7), row("b", 7), row("c", 7), row("d", 1)];
    const lines = Array.from({ length: 9 }, (_, i) => `line ${i}`);

    expect(sourcePane(rows[1], rows, lines, "stored")).toMatchObject({
      kind: "line",
      siblings: 3,
      ordinal: 2,
      lineNumber: 8,
    });
    expect(sourcePane(rows[0], rows, lines, "stored")).toMatchObject({ ordinal: 1 });
    expect(sourcePane(rows[2], rows, lines, "stored")).toMatchObject({ ordinal: 3 });
    expect(sourcePane(rows[3], rows, lines, "stored")).toMatchObject({ siblings: 1, ordinal: 1 });
  });

  // The guard that keeps a lost line from being reported as a frame the
  // importer built. Both sentences would be wrong, but only one of them would
  // be believed.
  it("says so when the frame points past the end of the file", () => {
    const r = row("a", 9);
    expect(sourcePane(r, [r], FILE, "stored")).toEqual({ kind: "missing", lineNumber: 10, total: 4 });
  });
});

// "There is no file" is not one statement, it is four, and three of them are
// false when said as the fourth. The byte-for-byte sentence is a promise about
// a stored line; a frame with no stored line behind it, a scenario compiled in
// this browser and another process's frames each need their own.
describe("what the source pane says when no file is loaded", () => {
  // Every frame the app makes for the screen or sends over the socket. The
  // synthetic system_context is the top row of EVERY live trace, so this is the
  // first thing a reader who picks the source face sees.
  const unstored = [
    row("a", undefined, "system_context", "out"),
    row("b", undefined, "session_resume", "out"),
    row("c", undefined, "user_message", "out"),
    row("d", undefined, "workspace_info"),
    row("e", undefined, "provider_info"),
    row("f", undefined, "permission_mode_info"),
    row("g", undefined, "otlp_export"),
    row("h", undefined, "fleet_roster"),
    row("i", undefined, "fleet_event"),
  ];

  it("does not claim a stored line for a frame no file holds", () => {
    for (const r of unstored) {
      expect(sourcePane(r, unstored, null, "stored").kind, r.type).toBe("unstored");
    }
  });

  // A scenario is compiled in the browser out of the DSL. It was never on a
  // wire and never on a disk, so "the wire line is the stored line" is false on
  // both halves.
  it("says a scenario was compiled here", () => {
    const r = row("a");
    expect(sourcePane(r, [r], null, "scenario").kind).toBe("scenario");
  });

  // An entered fleet shows frames from other processes, possibly on other
  // machines. "Produced here" is the one thing they are not.
  it("says a fleet's frames came from another process", () => {
    const r = row("a");
    expect(sourcePane(r, [r], null, "fleet").kind).toBe("fleet");
  });

  // The frame-level fact wins over the session-level one: a scenario's system
  // context was built by this app for this screen, not compiled from the DSL.
  it("keeps the frame's own answer inside a scenario and inside a fleet", () => {
    const sys = row("a", undefined, "system_context", "out");
    expect(sourcePane(sys, [sys], null, "scenario").kind).toBe("unstored");
    expect(sourcePane(sys, [sys], null, "fleet").kind).toBe("unstored");
  });

  // The one case the byte-for-byte sentence is true for, kept.
  it("still says the wire line is the stored line for a stored frame", () => {
    const r = row("a");
    expect(sourcePane(r, [r], null, "stored").kind).toBe("none");
  });
});

// The "none" sentence has a second half that is not about the source at all:
// "The wire line is the stored line, byte for byte." That is a claim about the
// face NEXT to this one, and applying a translation makes it false.
//
// App.tsx swaps every trace row's payload for the translated event
// (swapTracePayloads) and the wire face renders JSON.stringify of that. There
// is no import, so `lines` is null, provenance is "stored", the frame is one a
// file holds, and the pane says byte for byte over a payload the translator
// rebuilt. The pane exists to stop exactly this claim being made where it is
// not true, and it was the one making it.
//
// Kept out of sourcePane on purpose: which bytes a file holds is a fact about
// the file, and whether a translation is on screen is a fact about the screen.
// Two facts, one sentence, so the sentence is chosen where they meet.
describe("the sentence the pane says", () => {
  it("drops the byte-for-byte half while a translation is showing", () => {
    const r = row("a");
    const pane = sourcePane(r, [r], null, "stored");

    expect(pane.kind).toBe("none");
    expect(sourceSentence(pane, false)).toBe("trace.source.none");
    expect(sourceSentence(pane, true)).toBe("trace.source.noneTranslated");
  });

  it("leaves every other case saying what it always said", () => {
    // None of them claims the wire line is anything, so a translation changes
    // nothing about them. A blanket "a translation is showing" note on all of
    // them would be noise attached to sentences it does not touch.
    const built = row("b", undefined, "text_delta");
    const unstored = row("c", undefined, "workspace_info");
    for (const pane of [
      sourcePane(unstored, [unstored], null, "stored"),
      sourcePane(built, [built], null, "scenario"),
      sourcePane(built, [built], null, "fleet"),
      sourcePane(built, [built], FILE, "stored"),
    ]) {
      expect(sourceSentence(pane, true), pane.kind).toBe(`trace.source.${pane.kind}`);
    }
  });
});

// The same three answers, read off the ids the app already carries. One
// classifier, so the header's word and the pane's sentence cannot drift.
describe("traceProvenance", () => {
  it("reads a live session and an archive as produced here", () => {
    expect(traceProvenance(null, null)).toBe("stored");
    expect(traceProvenance("20260726-172215", null)).toBe("stored");
  });

  it("reads a compiled scenario as a scenario, entered or not", () => {
    expect(traceProvenance("scenario:fanout", null)).toBe("scenario");
    expect(traceProvenance(null, "scenario:fleet-review")).toBe("scenario");
  });

  it("reads an entered fleet as another process", () => {
    expect(traceProvenance(null, "ctx-7")).toBe("fleet");
    expect(traceProvenance("20260726-172215", "ctx-7")).toBe("fleet");
  });

  // An import has its file, so it never reaches these sentences; it must not
  // be read as a fleet or a scenario on the way there either.
  it("leaves an import to its own lines", () => {
    expect(traceProvenance("import:claude-code:session.jsonl", null)).toBe("stored");
  });
});

describe("withinBudget", () => {
  it("leaves a line that fits alone", () => {
    expect(withinBudget("short")).toEqual({ text: "short", shown: 5, total: 5, capped: false });
  });

  it("caps a long line and says how much of it is on screen", () => {
    const long = "x".repeat(SOURCE_DISPLAY_CHARS + 100);

    const cut = withinBudget(long);

    expect(cut.capped).toBe(true);
    expect(cut.shown).toBe(SOURCE_DISPLAY_CHARS);
    expect(cut.total).toBe(SOURCE_DISPLAY_CHARS + 100);
    expect(cut.text.length).toBe(SOURCE_DISPLAY_CHARS);
  });

  // A cut between the two halves of one character would put a broken glyph on
  // screen and call it the file's bytes.
  it("never cuts a surrogate pair in half", () => {
    const cut = withinBudget(`${"x".repeat(9)}\u{1F600}tail`, 10);

    expect(cut.text).toBe("x".repeat(9));
    expect(cut.shown).toBe(9);
  });
});

describe("what the copy button hands over", () => {
  const line = '{"type":"user","message":{"content":"one\\ntwo"}}';

  it("copies the whole source line, not the truncated display", () => {
    const huge = `{"pad":"${"x".repeat(200_000)}"}`;

    expect(withinBudget(huge).capped).toBe(true);
    expect(detailText("source", "text_delta", {}, { line: huge, reading: "verbatim" })).toBe(huge);
  });

  it("copies the exact line for a verbatim source, escapes and all", () => {
    expect(detailText("source", "text_delta", {}, { line, reading: "verbatim" })).toBe(line);
  });

  it("copies the prettified text for a readable source", () => {
    const copied = detailText("source", "text_delta", {}, { line, reading: "readable" });

    expect(copied).not.toBe(line);
    expect(copied).toContain("one\ntwo"); // the real break, not the escape
  });

  it("hands over nothing when the frame has no line, so the button is not offered", () => {
    expect(detailText("source", "text_delta", {}, { reading: "verbatim" })).toBe("");
    expect(detailText("source", "text_delta", {})).toBe("");
  });

  it("leaves the wire pane's verbatim copy exactly as it was", () => {
    const payload = { sessionId: "s", history };
    expect(detailText("wire", "session_resume", payload, { reading: "verbatim" })).toBe(
      detailText("wire", "session_resume", payload),
    );
  });

  it("prettifies the wire pane too, because our own lines carry escapes", () => {
    const copied = detailText("wire", "text_delta", { text: "one\ntwo" }, { reading: "readable" });

    expect(copied).toContain("one\ntwo");
  });

  // The compact pane WRAPS on screen (owner 2026-08-03: "compact und raw sehen
  // noch sehr gleich aus ... text/word wrap an, damit man den ganzen json inhalt
  // sieht"), and wrapping is the one thing the clipboard must not learn. A copy
  // that pasted the pane's line breaks would paste a file nobody wrote, so the
  // wrap lives in the stylesheet and this text stays one line per wire line.
  it("copies a wrapped compact pane as one line per wire line", () => {
    const wide = { text: "x".repeat(4000) };

    const copied = detailText("compact", "text_delta", wide);

    expect(copied.split("\n")).toHaveLength(1);
    expect(copied).toBe(detailText("wire", "text_delta", wide));
    expect(copied).toHaveLength(JSON.stringify(wide).length);
  });

  // Copying prettified text while the reader believes they copied the source is
  // its own defect, so the button says which of the two it took.
  it("names what it copies", () => {
    expect(copyLabel("source", "readable")).toBe("copyReadable");
    expect(copyLabel("source", "verbatim")).toBe("copy");
    expect(copyLabel("wire", "readable")).toBe("copyReadable");
    expect(copyLabel("insight", "readable")).toBe("copy"); // insight has no reading strip
  });
});
