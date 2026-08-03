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

/** A row as the pane sees it: a payload to key on, and maybe a line index. */
const row = (payload: string, sourceLine?: number): { payload: unknown } & WithSource =>
  sourceLine === undefined ? { payload } : { payload, sourceLine };

const FILE = ["line zero", "line one", "line two", "line three"];

describe("sourcePane", () => {
  // A native session HAS no separate source, and saying so is not the same as
  // saying "nothing here". The wire line IS the stored line for these, byte for
  // byte, which is the claim export/jsonl.ts pins across 8882 lines.
  it("says the wire line is the stored line when there is no import", () => {
    const r = row("a");
    expect(sourcePane(r, [r], null).kind).toBe("none");
    expect(sourcePane(r, [r], undefined).kind).toBe("none");
  });

  // The synthetic system_context at seq 0, the up-front provider_info, the
  // closing run_end: real frames that no single line of the file produced.
  it("says the importer built a frame with no source line", () => {
    const r = row("a");
    expect(sourcePane(r, [r], FILE).kind).toBe("built");
  });

  it("hands back the whole line, and counts it from one", () => {
    const r = row("a", 2);

    expect(sourcePane(r, [r], FILE)).toEqual({
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

    expect(sourcePane(rows[1], rows, lines)).toMatchObject({
      kind: "line",
      siblings: 3,
      ordinal: 2,
      lineNumber: 8,
    });
    expect(sourcePane(rows[0], rows, lines)).toMatchObject({ ordinal: 1 });
    expect(sourcePane(rows[2], rows, lines)).toMatchObject({ ordinal: 3 });
    expect(sourcePane(rows[3], rows, lines)).toMatchObject({ siblings: 1, ordinal: 1 });
  });

  // The guard that keeps a lost line from being reported as a frame the
  // importer built. Both sentences would be wrong, but only one of them would
  // be believed.
  it("says so when the frame points past the end of the file", () => {
    const r = row("a", 9);
    expect(sourcePane(r, [r], FILE)).toEqual({ kind: "missing", lineNumber: 10, total: 4 });
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

  // Copying prettified text while the reader believes they copied the source is
  // its own defect, so the button says which of the two it took.
  it("names what it copies", () => {
    expect(copyLabel("source", "readable")).toBe("copyReadable");
    expect(copyLabel("source", "verbatim")).toBe("copy");
    expect(copyLabel("wire", "readable")).toBe("copyReadable");
    expect(copyLabel("insight", "readable")).toBe("copy"); // insight has no reading strip
  });
});
