// Card 326: Source gains a THIRD reading beside Verbatim and Readable — the
// collapsible tree, the same one the Insight face draws.
//
// The owner: "machst du bei source im trace view noch neben dem Verbatim und
// Readable einen insight view der wie insight auch das higlighting macht und
// auch die optikon hat jsons auf und einzuklappen?"
//
// WHY THE READING IS NOT CALLED "insight". `Reading` and `DetailMode` are two
// vocabularies that meet in one function: copyLabel(mode, reading) already
// tests `mode !== "insight"`. A reading spelled the same word as a face would
// give that line two meanings, and the face called `insight` and the reading
// called `insight` would be different things a click apart on the same pane.
// The reading is called `tree`, which is what it is; the strip's label is the
// dictionary's business and the type's spelling is not.
//
// A reading is deliberately NOT a face (traceDetail.ts:40): a face answers
// "which of this frame's several selves am I looking at", a reading answers
// "how is this one being painted". The tree keeps that line — it paints the
// SOURCE LINE, and the Insight face paints OUR RunEvent. On a foreign import
// those are not the same document, which is the whole point of the card.

import { describe, expect, it } from "vitest";
import {
  READINGS,
  copyLabel,
  detailLines,
  detailText,
  readingsFor,
  resolvedReading,
  sourceTree,
  type SourcePane,
} from "./traceDetail";
import { readable, readableText } from "./readable";
import type { RunEvent } from "../events";

/** A real Claude Code transcript line, shortened: a record whose own fields
 *  are what the tree has to open. */
const LINE = JSON.stringify({
  type: "assistant",
  uuid: "3e010de0",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
});

/** A line that does not parse at all. Hand-edited files and concatenated logs
 *  both produce them, and the import dialog accepts whatever it is given. */
const PROSE = "2026-08-30 12:04:11  INFO  the run finished with 3 warnings";

/** A source pane with a line behind it — since the re-review of card 326
 *  {@link readingsFor} answers for the PANE, because `built` and `missing` name
 *  no line and had three buttons over them that changed nothing. */
const LINE_PANE: SourcePane = {
  kind: "line",
  text: LINE,
  lineNumber: 1,
  total: 1,
  siblings: 1,
  ordinal: 1,
};

describe("which readings each pane offers", () => {
  it("offers all three on the source pane", () => {
    expect(readingsFor("source", LINE_PANE)).toEqual([...READINGS]);
  });

  // A tree of our own wire line would BE the Insight face, one click to the
  // left. Two controls that render the same thing under two names is the defect
  // that retired `compact` (traceDetail.ts:26), and this card must not put it
  // back on the next pane over.
  it("does not offer the tree on the wire pane, where the insight face already is", () => {
    expect(readingsFor("wire", null)).toEqual(["verbatim", "readable"]);
  });

  it("offers no reading strip on the insight pane, which has one rendering", () => {
    expect(readingsFor("insight", null)).toEqual([]);
  });

  it("keeps every offered list in the strip's own order", () => {
    for (const mode of ["insight", "wire", "source"] as const) {
      const offered = readingsFor(mode, LINE_PANE);
      expect(offered, mode).toEqual(READINGS.filter((r) => offered.includes(r)));
    }
  });

  it("leaves no reading nobody can reach", () => {
    for (const reading of READINGS) {
      expect(
        (["insight", "wire", "source"] as const).some((m) => readingsFor(m, LINE_PANE).includes(reading)),
        `${reading} is offered by no pane at all`,
      ).toBe(true);
    }
  });
});

describe("a line that is no JSON document does not become an empty tree", () => {
  // Three lines, three separate bites. They fail for three different reasons —
  // one does not parse, one parses to something that is not a document, one is
  // a document that happens to be empty — and a single `it` over all three
  // would report the first and hide the rest.
  it("says no tree for prose", () => {
    expect(sourceTree(PROSE).parsed).toBe(false);
  });

  it("says no tree for a line that parses to a bare value", () => {
    // "null" and "12" are valid JSON and would draw a tree of one leaf. That is
    // an empty tree wearing a caret, which is the pane looking broken rather
    // than faithful.
    expect(sourceTree("null").parsed).toBe(false);
    expect(sourceTree("12").parsed).toBe(false);
    expect(sourceTree('"just a string"').parsed).toBe(false);
  });

  it("does draw a tree for an empty document, which IS what the line says", () => {
    expect(sourceTree("{}").parsed).toBe(true);
    expect(sourceTree("[]").parsed).toBe(true);
  });

  it("draws a tree over the parsed line for a real record", () => {
    const tree = sourceTree(LINE);
    expect(tree.parsed).toBe(true);
    expect(tree.parsed ? tree.value : null).toEqual(JSON.parse(LINE));
  });

  // ONE judgement, not two. The pane already says "This line is not a JSON
  // object or array. It stands here unchanged." on the readable reading, and
  // readable.ts owns the rule that produces it (a parse, plus the document
  // check). A second copy of that rule here would drift the first time either
  // side moved, and the two readings would disagree about the same line in the
  // same pane. The SIZE half of sourceTree's verdict is its own and is pinned
  // in sourceReadingLimits.test.ts; readable.ts has no opinion about length.
  it("agrees with the readable reading about what counts as a document", () => {
    for (const line of [
      LINE,
      PROSE,
      "{}",
      "[]",
      "null",
      "12",
      '"just a string"',
      "",
      '{"truncated": "mid-str',
      "  ",
      '{"a":1}   ',
    ]) {
      expect(sourceTree(line).parsed, JSON.stringify(line)).toBe(readable(line).parsed);
    }
  });
});

describe("the reading the pane can actually give", () => {
  // A button that says "Copy formatted" while handing over a raw log line is
  // this card's own defect in miniature. So the reading is RESOLVED against
  // the line before anything downstream names it.
  it("keeps the tree when the line is a document", () => {
    expect(resolvedReading("tree", LINE)).toBe("tree");
  });

  it("falls to verbatim when the tree was asked for over a line that is no document", () => {
    expect(resolvedReading("tree", PROSE)).toBe("verbatim");
  });

  it("falls to verbatim when there is no line at all", () => {
    // The `built` and `missing` panes name no line; asking them for a tree has
    // to answer something, and the bytes are the only honest answer.
    expect(resolvedReading("tree", undefined)).toBe("verbatim");
  });

  it("leaves the two older readings exactly as they were", () => {
    for (const line of [LINE, PROSE, undefined]) {
      expect(resolvedReading("verbatim", line)).toBe("verbatim");
      expect(resolvedReading("readable", line)).toBe("readable");
    }
  });
});

describe("what the copy button hands over, and what it calls itself", () => {
  // Three readings, three payloads, three labels — one assertion each. Two
  // cases falling with one message would be one case.
  it("hands over the line itself on verbatim, and says copy", () => {
    expect(detailText("source", "text_delta", {}, { line: LINE, reading: "verbatim" })).toBe(LINE);
    expect(copyLabel("source", "verbatim")).toBe("copy");
  });

  it("hands over the opened-out rendering on readable, and says so", () => {
    expect(detailText("source", "text_delta", {}, { line: LINE, reading: "readable" })).toBe(
      readableText(LINE),
    );
    expect(copyLabel("source", "readable")).toBe("copyReadable");
  });

  // A tree is not text. What a reader can carry away from it is the document
  // the tree is OF, laid out the way the tree lays it out — which is the same
  // thing the Insight face's copy button hands over, and pointedly not the
  // pane's own line breaks.
  it("hands over the parsed line, formatted, on the tree — and says that", () => {
    expect(detailText("source", "text_delta", {}, { line: LINE, reading: "tree" })).toBe(
      JSON.stringify(JSON.parse(LINE), null, 2),
    );
    expect(copyLabel("source", "tree")).toBe("copyTree");
  });

  // Belt and braces on the resolution above: even asked directly for a tree of
  // a line that has none, the clipboard gets the line rather than an empty
  // string or the word "undefined".
  it("hands over the line unchanged when a tree was asked for and there is none", () => {
    expect(detailText("source", "text_delta", {}, { line: PROSE, reading: "tree" })).toBe(PROSE);
    expect(copyLabel("source", resolvedReading("tree", PROSE))).toBe("copy");
  });

  it("has a name for every reading, and no two share one", () => {
    const labels = READINGS.map((r) => copyLabel("source", r));
    expect(new Set(labels).size, labels.join(" ")).toBe(READINGS.length);
  });

  // The face called insight has no reading strip, so its copy button keeps the
  // one word it always had. The reading called tree must not reach in and
  // rename it.
  it("leaves the insight FACE's copy button alone", () => {
    for (const reading of READINGS) {
      expect(copyLabel("insight", reading), reading).toBe("copy");
    }
  });
});

describe("several opened lines, as trees", () => {
  // A session_resume carries the whole re-uploaded history and expands to one
  // wire line per event; the text readings join those with a blank line
  // between them (traceDetail.ts). A SOURCE reading never does: a frame was
  // read from exactly ONE line of the file, however many wire lines its
  // payload makes, and joining would put a file nobody wrote in the clipboard.
  const history = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
    { type: "text_delta", agentId: "main", text: "line1\nline2", ts: 2 },
  ] as RunEvent[];
  const payload = { sessionId: "s", history };

  it("still joins the wire face's several lines", () => {
    expect(detailLines("session_resume", payload)).toHaveLength(2);
    expect(detailText("wire", "session_resume", payload).split("\n")).toHaveLength(2);
  });

  it("hands the source tree ONE document, not the payload's several lines", () => {
    const text = detailText("source", "session_resume", payload, { line: LINE, reading: "tree" });
    expect(text).toBe(JSON.stringify(JSON.parse(LINE), null, 2));
    expect(text).not.toContain("\n\n");
  });

  it("reads the frame's own line and not the payload it was turned into", () => {
    // The line and the payload disagree on purpose here, which is the ordinary
    // state of affairs for a foreign import: 51.2% of Claude Code file lines
    // stand behind two or more frames, so the payload is never the line.
    const text = detailText("source", "session_resume", payload, { line: LINE, reading: "tree" });
    expect(text).toContain("3e010de0");
    expect(text).not.toContain("run_start");
  });
});
