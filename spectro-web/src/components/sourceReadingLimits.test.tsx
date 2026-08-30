// Card 326 re-review: the three places the source pane's readings promised more
// than the pane can keep.
//
// THE CEILING. traceDetail.ts sets SOURCE_DISPLAY_CHARS with the reason spelled
// out — "a pane without a ceiling is a pane that freezes" — and verbatim and
// readable both obey it and SAY they capped. The tree reading, added by this
// card, walked straight past it: it hands the whole parsed value to JsonTree,
// which caps neither string leaves nor node counts. Measured over the owner's
// real corpus on 2026-08-30:
//
//   node -e '<walk ~/.claude/projects/**.jsonl, count lines over 65536 chars>'
//   files 7656  lines 963028  over 65536: 10617 (1.102%)  longest 2706596
//
// So one click in one row of one percent of that corpus builds a React tree over
// a 2.7 MB document. Nothing is lost by refusing: verbatim shows the line, says
// how much of it is on screen, and carries the "show all" button that lifts the
// ceiling on request.
//
// THE STRIP OVER A PANE WITH NO LINE. `built` and `missing` panes name no line
// at all, and the strip still offered all three readings above them — three
// buttons that change nothing, over a one-sentence pane with no copy button.
// traceFace.ts argues "a face with nothing behind it is not offered at all" and
// this card's own depth strip obeys it; the readings did not.
//
// THE FALLBACK. A reading this pane does not offer used to jump to `verbatim` —
// the one reading traceDetail.ts says makes the pane "look broken rather than
// faithful" and deliberately does not open on. It now lands the way a FACE
// lands: the nearest neighbour that is actually on offer.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceBody } from "./TraceView";
import {
  DETAIL_MODES,
  READINGS,
  SOURCE_DISPLAY_CHARS,
  availableReading,
  detailText,
  readingsFor,
  resolvedReading,
  sourceTree,
  type Reading,
  type SourcePane,
} from "./traceDetail";
import { t, type Lang } from "../i18n/i18n";

/** A document whose text is exactly the display ceiling: `{"t":"xxx…"}` is the
 *  six opening characters, the run, and the two closing ones. */
const atBudget = JSON.stringify({ t: "x".repeat(SOURCE_DISPLAY_CHARS - 8) });
const overBudget = JSON.stringify({ t: "x".repeat(SOURCE_DISPLAY_CHARS - 7) });
const PROSE = "starting the dev server, not JSON at all";
const SMALL = JSON.stringify({ type: "tool_call", name: "read" });

const lineOf = (text: string): SourcePane => ({
  kind: "line",
  text,
  lineNumber: 1,
  total: 1,
  siblings: 1,
  ordinal: 1,
});

const BUILT: SourcePane = { kind: "built" };
const MISSING: SourcePane = { kind: "missing", lineNumber: 9, total: 4 };

const render = (pane: SourcePane, reading: Reading, lang: Lang = "en"): string =>
  renderToStaticMarkup(<SourceBody pane={pane} reading={reading} lang={lang} depth="default" />);

describe("a line too long to draw is not drawn, and says which of the two reasons it is", () => {
  it("draws the tree right up to the pane's own ceiling", () => {
    expect(atBudget.length).toBe(SOURCE_DISPLAY_CHARS);
    expect(sourceTree(atBudget).parsed).toBe(true);
  });

  it("refuses one character past it", () => {
    expect(overBudget.length).toBe(SOURCE_DISPLAY_CHARS + 1);
    expect(sourceTree(overBudget).parsed).toBe(false);
  });

  it("calls the two refusals by different names", () => {
    // One sentence for both would say "this line is not a JSON object" about a
    // 2.7 MB document that is one — the pane lying about the file, which is the
    // defect the source face exists to remove.
    const tooLong = sourceTree(overBudget);
    const noDoc = sourceTree(PROSE);
    expect(tooLong.parsed).toBe(false);
    expect(noDoc.parsed).toBe(false);
    expect(tooLong.parsed === false && tooLong.why).toBe("tooLong");
    expect(noDoc.parsed === false && noDoc.why).toBe("noDocument");
  });

  it("says the length reason, and not the shape one, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const html = render(lineOf(overBudget), "tree", lang);
      expect(html, lang).toContain(t(lang, "trace.source.tooLong"));
      expect(html, lang).not.toContain(t(lang, "trace.source.noDocument"));
    }
  });

  it("says the shape reason, and not the length one, for prose", () => {
    for (const lang of ["de", "en"] as const) {
      const html = render(lineOf(PROSE), "tree", lang);
      expect(html, lang).toContain(t(lang, "trace.source.noDocument"));
      expect(html, lang).not.toContain(t(lang, "trace.source.tooLong"));
    }
  });

  it("builds no tree nodes for the refused line", () => {
    // The point of the ceiling. A sentence above a 2.7 MB tree would be a
    // sentence nobody reaches.
    expect(render(lineOf(overBudget), "tree")).not.toContain('class="json-tree"');
  });

  it("shows the line itself instead, capped and saying so", () => {
    const html = render(lineOf(overBudget), "tree");
    expect(html).toContain('class="trace-detail-raw');
    expect(html).toContain(t("en", "trace.source.showAll"));
  });

  it("resolves the reading away, so nothing downstream names a tree", () => {
    expect(resolvedReading("tree", overBudget)).not.toBe("tree");
    expect(resolvedReading("tree", atBudget)).toBe("tree");
  });

  it("still hands the WHOLE line to the clipboard", () => {
    // The ceiling caps the paint, never the copy — or the reader walks away
    // with a file they believe is complete.
    expect(detailText("source", "tool_call", null, { line: overBudget, reading: "tree" })).toBe(overBudget);
  });
});

describe("the reading strip is not drawn over a pane that shows no line", () => {
  it("offers nothing for a frame the importer built", () => {
    expect(readingsFor("source", BUILT)).toEqual([]);
  });

  it("offers nothing for a line the file does not have", () => {
    expect(readingsFor("source", MISSING)).toEqual([]);
  });

  it("offers all three where there is a line to read", () => {
    expect(readingsFor("source", lineOf(SMALL))).toEqual([...READINGS]);
  });

  it("leaves the wire pane's two alone — it has a line of its own", () => {
    expect(readingsFor("wire", null)).toEqual(["verbatim", "readable"]);
  });

  it("offers nothing on insight, which has one rendering", () => {
    expect(readingsFor("insight", null)).toEqual([]);
  });

  it("never offers a reading that is not one", () => {
    for (const mode of DETAIL_MODES) {
      for (const pane of [null, BUILT, MISSING, lineOf(SMALL)]) {
        for (const r of readingsFor(mode, pane)) {
          expect(READINGS, `${mode}/${pane?.kind ?? "none"}`).toContain(r);
        }
      }
    }
  });
});

describe("a reading this pane does not offer lands on its nearest neighbour", () => {
  it("takes tree to readable, not to the verbatim the pane refuses to open on", () => {
    expect(availableReading("tree", readingsFor("wire", null))).toBe("readable");
  });

  it("leaves a reading that IS on offer where it is", () => {
    for (const r of readingsFor("source", lineOf(SMALL))) {
      expect(availableReading(r, readingsFor("source", lineOf(SMALL)))).toBe(r);
    }
  });

  it("lands on something the pane offers, from every reading and every pane", () => {
    for (const mode of DETAIL_MODES) {
      for (const pane of [null, BUILT, MISSING, lineOf(SMALL)]) {
        const offered = readingsFor(mode, pane);
        if (offered.length === 0) continue;
        for (const r of READINGS) {
          expect(offered, `${r} on ${mode}/${pane?.kind ?? "none"}`).toContain(availableReading(r, offered));
        }
      }
    }
  });
});
