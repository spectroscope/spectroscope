// Trace detail modes: one wire line per frame; session_resume = the whole
// history as JSONL lines.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import {
  SOURCE_DISPLAY_CHARS,
  SOURCE_PANE_KINDS,
  copyLabel,
  detailLines,
  detailText,
  sourcePane,
  sourceSentence,
  withinBudget,
} from "./traceDetail";
import type { WithSource } from "../state/traceSource";
import { TRACE_ORIGINS, facesOf, readsForeignRecord } from "../state/traceFace";

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
  it("joins the wire face's lines with real newlines and pretty-prints insight", () => {
    const payload = { sessionId: "s", history };
    expect(detailText("wire", "session_resume", payload).split("\n")).toHaveLength(2);
    expect(detailText("wire", "session_resume", payload)).toBe(detailText("wire", "session_resume", payload));
    expect(detailText("insight", "session_resume", payload)).toContain("\n  ");
  });
});

// The source pane. Every case is a pure function of two things: whether an
// import is loaded at all, and whether THIS frame was read from one of its
// lines. Nothing here guesses.

/** A row as the pane sees it: a payload to key on, and maybe a line index.
 *
 *  It used to carry the frame's type and direction too, for the four cases that
 *  answered "no file was imported". Card 326 withdrew the source face from
 *  every session that has no file, so by the time this function is called a
 *  file is a fact and the only question left is which of its lines — if any —
 *  this frame was read from. */
const row = (payload: string, sourceLine?: number): { payload: unknown } & WithSource =>
  sourceLine === undefined ? { payload } : { payload, sourceLine };

const FILE = ["line zero", "line one", "line two", "line three"];

describe("sourcePane", () => {
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

// Card 326: the four sentences that answered "no file was imported" are gone,
// and this is the test that stops them coming back one at a time. The reachable
// set is DERIVED from the rule that withdrew them — the source face is offered
// only where the session reads a foreign record, and a foreign record is a file
// — rather than typed out here, where it would be a second copy of the same
// list.
describe("what the pane can still be asked", () => {
  it("has a case for a line, for a frame the importer built, and for a line the file lacks", () => {
    expect([...SOURCE_PANE_KINDS].sort()).toEqual(["built", "line", "missing"]);
  });

  // The withdrawal, walked over the origins rather than asserted about them:
  // every origin that offers the source face at all has a file behind it, so
  // no reachable call of sourcePane can be missing its lines. If a later card
  // offers source somewhere fileless, this goes red before the pane can say a
  // sentence it no longer has.
  it("is offered by no origin that has no file behind it", () => {
    for (const origin of TRACE_ORIGINS) {
      if (!facesOf(origin).includes("source")) continue;
      expect(readsForeignRecord(origin), origin).toBe(true);
    }
  });

  it("names a sentence for every case it can return, and never one it cannot", () => {
    const r = row("a");
    const reachable = [
      sourcePane(r, [r], FILE), // built
      sourcePane(row("b", 1), [], FILE), // line
      sourcePane(row("c", 99), [], FILE), // missing
    ];
    expect(new Set(reachable.map((p) => p.kind))).toEqual(new Set(SOURCE_PANE_KINDS));
    for (const pane of reachable) {
      expect(sourceSentence(pane), pane.kind).toBe(`trace.source.${pane.kind}`);
    }
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

    const copied = detailText("wire", "text_delta", wide);

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
