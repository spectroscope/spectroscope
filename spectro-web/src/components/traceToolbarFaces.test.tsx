// Card 326 re-review: the MASTER face switch follows the session's origin too,
// not only the open row's own strip.
//
// The card filtered `facesFor` and wired it into TraceDetail, the strip inside
// an expanded row. The toolbar at the top of the trace — the control a reader
// meets first, and the one the owner pointed at ("das kann weg wenn wir einen
// spectro jsonl anschauen", "insight und wire kann weg") — went on mapping the
// raw {@link TRACE_FACES}. So a spectroscope session still offered Source with
// the tooltip "Open frames with the line of the imported file they were read
// from", on a session that imported no file, and a Claude import still offered
// Insight and Wire — the two the card had just measured as unanswerable there.
// The two controls sit one above the other and contradicted each other.
//
// Rendered, never grepped: this reads the buttons out of the markup the view
// actually produces, the way sourceTree.test.tsx reads the drawn nodes. And the
// expectation is DERIVED — `facesOf(origin)` decides, so a fourth import format
// or a fifth face moves this test with the rule instead of against it.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TraceView } from "./TraceView";
import { availableFace, facesOf, TRACE_FACES, TRACE_ORIGINS, type TraceFace } from "../state/traceFace";
import { currentTraceFace, setTraceFace } from "../state/traceFace";
import type { TraceEntry } from "../state/reducer";
import { t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

const lang = currentLang();

const ROWS: TraceEntry[] = [
  { seq: 1, dir: "in", ts: 1, type: "tool_call", sourceLine: 0, payload: { name: "read" } },
];

/** The file behind an import. Present for every origin here, because the
 *  question this file asks is what the ORIGIN offers — a view handed lines it
 *  has no origin for would be answering a different one. */
const LINES = ['{"type":"tool_call"}'];

/**
 * The master switch's own buttons, as faces.
 *
 * Sliced out by the group's aria name and read back through the dictionary, so
 * the assertion never types a face's label: a renamed button moves with the
 * dictionary and a renamed FACE fails to map, which is the failure we want.
 */
function toolbarFaces(html: string): TraceFace[] {
  const at = html.indexOf(`aria-label="${t(lang, "trace.faceAria")}"`);
  expect(at, "the master face switch is not in the markup at all").toBeGreaterThan(-1);
  const seg = html.slice(at, html.indexOf("</div>", at));
  const byLabel = new Map<string, TraceFace>(TRACE_FACES.map((f) => [t(lang, `trace.mode.${f}`), f]));
  const out: TraceFace[] = [];
  for (const m of seg.matchAll(/>([^<>]*)<\/button>/g)) {
    const face = byLabel.get(m[1]);
    expect(face, `the master switch draws a button "${m[1]}" that is no face`).toBeDefined();
    out.push(face!);
  }
  return out;
}

/** Which face the toolbar draws as the pressed one, or null when none is. */
function pressedFace(html: string): TraceFace | null {
  const at = html.indexOf(`aria-label="${t(lang, "trace.faceAria")}"`);
  const seg = html.slice(at, html.indexOf("</div>", at));
  const byLabel = new Map<string, TraceFace>(TRACE_FACES.map((f) => [t(lang, `trace.mode.${f}`), f]));
  for (const m of seg.matchAll(/aria-pressed="(true|false)"[^>]*>([^<>]*)<\/button>/g)) {
    if (m[1] === "true") return byLabel.get(m[2]) ?? null;
  }
  return null;
}

const draw = (origin: (typeof TRACE_ORIGINS)[number]): string =>
  renderToStaticMarkup(<TraceView entries={ROWS} origin={origin} sourceLines={LINES} />);

describe("the master face switch offers what the session can answer", () => {
  for (const origin of TRACE_ORIGINS) {
    it(`offers exactly ${origin}'s faces, in the toolbar's own order`, () => {
      expect(toolbarFaces(draw(origin))).toEqual(facesOf(origin));
    });
  }

  it("never draws a button the open row below it would refuse", () => {
    // The coherence the split controls broke: whatever the toolbar offers, the
    // row's own rule has to offer too, or one press lights a button while the
    // pane below shows something else.
    for (const origin of TRACE_ORIGINS) {
      for (const face of toolbarFaces(draw(origin))) {
        expect(facesOf(origin), `${face} on ${origin}`).toContain(face);
      }
    }
  });
});

describe("the pressed button is the face the rows actually land on", () => {
  const saved = currentTraceFace().face;

  it("lights the landing face when the stored master is not on offer here", () => {
    setTraceFace("wire");
    try {
      // `wire` is withdrawn on a foreign record, and availableFace lands the
      // rows on `structured`. A toolbar that stayed pressed on Wire would be
      // two controls disagreeing about one session.
      expect(pressedFace(draw("claude-code"))).toBe(availableFace("wire", facesOf("claude-code")));
      expect(pressedFace(draw("claude-code"))).toBe("structured");
    } finally {
      setTraceFace(saved);
    }
  });

  it("lights the stored master itself where the session can answer it", () => {
    setTraceFace("wire");
    try {
      expect(pressedFace(draw("native"))).toBe("wire");
    } finally {
      setTraceFace(saved);
    }
  });

  it("does not rewrite the stored master to the landing", () => {
    // AC 10's rule, one control higher: the reader's saved choice says what
    // they want, not what this file can show.
    setTraceFace("wire");
    try {
      draw("claude-code");
      expect(currentTraceFace().face).toBe("wire");
    } finally {
      setTraceFace(saved);
    }
  });
});
