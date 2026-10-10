// Card 366, AC 7: the gauge NAMES the window it measured against.
// Card 377: and the window is what it DIVIDES by, whenever the run's threshold
// was derived from one. The compaction point stays on the surface as a mark on
// the ring and a second clause under the line.
//
// WHY THE POPOVER IS RENDERED ON ITS OWN. There is no DOM in this gate (no
// jsdom), so the popover cannot be opened by a click — and the ring's button is
// all that renders while it is closed. The popover is therefore its own pure
// component, exported for exactly this reason: its markup is the half that has
// content, and the half the owner has been reading a denominator off for two
// months without being told where the denominator came from.
//
// THE RING ITSELF IS RENDERED TOO, and separately, because the chip is what he
// looks at while working and it renders when the popover does not.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPopover, ContextRing } from "./ContextRing";
import { contextGauge } from "./contextRingMath";
import type { ContextSnapshot } from "../state/reducer";

const snapshot = (extra: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  turn: 3,
  messages: 12,
  estimatedTokens: 8100,
  threshold: 175_257,
  parts: [{ label: "system prompt", chars: 1200, estTokens: 300 }],
  ...extra,
});

const render = (context: ContextSnapshot | null, lastInputTokens = 24_100): string => {
  const gauge = contextGauge(context?.threshold, context?.contextWindow, context?.thresholdSource);
  return renderToStaticMarkup(
    <ContextPopover
      lastInputTokens={lastInputTokens}
      context={context}
      gauge={gauge}
      shownPct={Math.round((lastInputTokens / gauge.denominator.value) * 100)}
      onWindowOverride={undefined}
      aiCredits={null}
    />,
  );
};

const renderRing = (context: ContextSnapshot | null, lastInputTokens: number): string =>
  renderToStaticMarkup(
    <ContextRing
      lastInputTokens={lastInputTokens}
      context={context}
      onWindowOverride={undefined}
      aiCredits={null}
    />,
  );

/** The whole headline, not a substring of it. */
const headline = (html: string): string => {
  const m = /<p class="context-line tabular">(.*?)<\/p>/.exec(html);
  if (m === null) throw new Error(`no context line in: ${html}`);
  return m[1];
};

/** Which of the three tones the ring's progress arc is drawn in. */
const toneOf = (html: string): string => {
  const m = /stroke="var\(--(ok|warn|error)\)"/.exec(html);
  if (m === null) throw new Error(`no tone in: ${html}`);
  return m[1];
};

/** The two endpoints of the ring's compaction mark, read attribute by attribute. */
const markOf = (html: string): { x1: string; y1: string; x2: string; y2: string } => {
  const line = /<line class="context-ring-mark"[^>]*>/.exec(html);
  if (line === null) throw new Error(`no compaction mark in: ${html}`);
  const attr = (name: string): string => {
    const m = new RegExp(` ${name}="([^"]*)"`).exec(line[0]);
    if (m === null) throw new Error(`no ${name} on: ${line[0]}`);
    return m[1];
  };
  return { x1: attr("x1"), y1: attr("y1"), x2: attr("x2"), y2: attr("y2") };
};

describe("the context popover names its own window (card 366)", () => {
  it("names the PUBLISHED window with no origin when the operator typed the threshold", () => {
    // The FRAME here is one the harness can really emit: an override paired
    // with the published ceiling: 1,000,000 for claude-opus under a 50,000
    // somebody typed. Under an override the probe is never run
    // (CompactionThreshold.derive, the IntSupplier form), so a loaded figure
    // can never ride an "override" frame.
    //
    // CARD 377 LEFT THIS CASE ALONE ON PURPOSE: the operator's own number stays
    // the headline, so the window is still a caption and still has no stated
    // origin. It is the only shape in which the caption line still renders.
    const html = render(
      snapshot({ threshold: 50_000, contextWindow: 1_000_000, thresholdSource: "override" }),
    );

    expect(html).toContain("window · 1M");
    expect(html).not.toContain("loaded window");
    expect(html).not.toContain("model window");
  });

  it("names no window when the run learned none", () => {
    // A fallback run states nothing, and the gauge may not fill the silence.
    const fellBack = render(snapshot({ threshold: 100_000, thresholdSource: "fallback" }));
    expect(fellBack).not.toContain("window ·");

    // …and a session with no introspection at all still renders.
    const none = render(null);
    expect(none).not.toContain("window ·");
    expect(none).toContain("Context");
  });
});

// CARD 377: THE OWNER'S OWN FRAME. 250,368 loaded, a threshold of 175,257 that
// is exactly 70 % of it, and 143,000 spent. He read 82 %.
const HIS_RUN = snapshot({
  threshold: 175_257,
  contextWindow: 250_368,
  thresholdSource: "window",
});

describe("the headline divides by the window the run states (card 377)", () => {
  it("names the loaded window and reads the share of it", () => {
    // 143000 / 250368 = 57.116 %. Against the old divisor it read 81.594 %.
    expect(headline(render(HIS_RUN, 143_000))).toBe("143k of 250k loaded window (57%)");
  });

  it("says the same 57 on the chip and in the label, where the popover is shut", () => {
    const html = renderRing(HIS_RUN, 143_000);
    expect(html).toContain(">57%</span>");
    expect(html).toContain('aria-label="Context 57 percent full');
  });

  it("names the published window the same way for a cloud run", () => {
    const cloud = snapshot({ threshold: 700_000, contextWindow: 1_000_000, thresholdSource: "model" });
    expect(headline(render(cloud, 350_000))).toBe("350k of 1M model window (35%)");
  });

  it("still states where the run compacts, as a number", () => {
    const html = render(HIS_RUN, 143_000);
    expect(html).toContain("compacts at 175k");
    // and it is no longer the caption line, because the headline names the
    // window itself. Saying 250k twice would be the defect this gauge's own
    // header calls worse than no gauge.
    expect(html).not.toContain("loaded window · 250k");
  });

  it("marks the compaction point on the ring itself", () => {
    // Asserted on the rendered svg, not on a prop: the mark is the half of this
    // card that a number cannot carry.
    const html = renderRing(HIS_RUN, 143_000);
    expect(html).toContain('class="context-ring-mark"');
  });

  it("draws the mark at the compaction point's share of the window", () => {
    // Literal endpoints, recorded 2026-09-24 from the component's own geometry
    // (SIZE 18, marks from radius 5.2 to 8.8, twelve o'clock is zero) with
    //   node -e 'const S=18;for(const f of [175257/250368,0.5]){
    //     const a=f*2*Math.PI-Math.PI/2;
    //     const at=r=>[(S/2+r*Math.cos(a)).toFixed(2),(S/2+r*Math.sin(a)).toFixed(2)];
    //     console.log(f,at(5.2),at(8.8))}'
    //   -> 0.69999 [4.05,10.61] [0.63,11.72] | 0.5 [9.00,14.20] [9.00,17.80]
    // His run compacts at 175,257 of 250,368: lower left, just below nine o'clock.
    expect(markOf(renderRing(HIS_RUN, 143_000))).toEqual({
      x1: "4.05",
      y1: "10.61",
      x2: "0.63",
      y2: "11.72",
    });
    // A frame compacting at half its window puts the mark at six o'clock, so the
    // angle follows the threshold over the window and is not a fixed position.
    const half = snapshot({ threshold: 125_184, contextWindow: 250_368, thresholdSource: "window" });
    expect(markOf(renderRing(half, 50_000))).toEqual({ x1: "9.00", y1: "14.20", x2: "9.00", y2: "17.80" });
  });

  it("draws no mark where there is no window to divide by", () => {
    const fellBack = snapshot({ threshold: 100_000, thresholdSource: "fallback" });
    expect(renderRing(fellBack, 50_000)).not.toContain("context-ring-mark");
    expect(renderRing(null, 50_000)).not.toContain("context-ring-mark");
  });
});

// CARD 377 CRITERION 3: the gauge warns at the same token counts it always
// did. The denominator moved; the tones did not.
//
// THE TWO BOUNDARY COUNTS ARE LITERALS RECORDED FROM main ON 2026-09-21, and
// they are deliberately NOT recomputed from WARM_AT_PCT and CRITICAL_AT_PCT.
// A test that derives its expectation from the constant it is guarding follows
// that constant wherever it goes and can never go red, which is exactly the
// bite this table has to survive.
//
//   python3 -c "th=175257
//   print([(t, t/th*100) for t in (122679,122680,157731,157732)])"
//   -> 122679 69.99949 | 122680 70.00006 | 157731 89.99983 | 157732 90.00040
//
// The rule at ContextRing.tsx is asymmetric (`pct < 70` calm, `pct <= 90`
// warm), so 122,680 is the first amber token and 157,732 the first red one.
describe("the gauge warns at the same token counts it always did (card 377)", () => {
  const cases: [number, string][] = [
    [122_679, "ok"],
    [122_680, "warn"],
    [157_731, "warn"],
    [157_732, "error"],
  ];

  for (const [tokens, tone] of cases) {
    it(`${tokens} input tokens is ${tone}, on a 250,368 window compacting at 175,257`, () => {
      expect(toneOf(renderRing(HIS_RUN, tokens))).toBe(tone);
    });
  }

  it("and the headline under the red tone still reads well under the window", () => {
    // 157,732 of 250,368 is 63 %, and 92,636 tokens are still free. The tone is
    // the warning; the number is no longer pretending to be one.
    expect(headline(render(HIS_RUN, 157_732))).toBe("158k of 250k loaded window (63%)");
  });

  it("keeps the tone against the threshold where there is no window", () => {
    // Unchanged from main: with nothing above it, the compaction point is both
    // the scale and the mark.
    const fellBack = snapshot({ threshold: 100_000, thresholdSource: "fallback" });
    expect(toneOf(renderRing(fellBack, 69_999))).toBe("ok");
    expect(toneOf(renderRing(fellBack, 70_001))).toBe("warn");
    expect(toneOf(renderRing(fellBack, 90_001))).toBe("error");
  });
});

// CARD 377, THE FIX OF 2026-09-23. This block differs from main on purpose.
// A frame with no threshold, and the popover before any frame has arrived,
// divide by the web's FALLBACK_THRESHOLD. main printed "of the model window"
// there (git show 301f6e69:spectro-web/src/components/ContextRing.tsx), which
// names a window no run stated. This card prints "before compaction".
describe("a run with no window at all names no window (card 377 fix)", () => {
  it("a frame with no threshold at all states no window either", () => {
    // The popover's opening state on a session whose first context_info has
    // not arrived yet, or a frame that carried no threshold field. The gauge
    // divides by the FALLBACK constant, and the last arm of scaleName called
    // that "of the window": a window nobody ever reported.
    const bare = snapshot({ threshold: undefined });
    expect(headline(render(bare, 143_000))).toBe("143k of 100k before compaction (143%)");
    // and the no-frame case, which is the same claim one step earlier:
    expect(headline(render(null, 143_000))).toBe("143k of 100k before compaction (143%)");
  });
});

describe("the headline's last word follows the divisor (card 377 fix)", () => {
  it("a frame that divides by a window it gives no provenance for calls it a window", () => {
    // No threshold, a window, no source: contextDenominator's second tier
    // divides by the window, and contextGauge names no provenance for it. The
    // wire cannot send this frame today (threshold is an int on every
    // context_info); the label follows the divisor anyway.
    const unstated = snapshot({ threshold: undefined, contextWindow: 250_368 });
    expect(headline(render(unstated, 143_000))).toBe("143k of 250k of the window (57%)");
  });
});

// CARD 377 CRITERION 4: the three frames with no window to divide by print
// exactly what main prints, to the character.
describe("a run with no window to divide by says nothing new (card 377)", () => {
  it("a fallback run reads exactly as it does on main", () => {
    const fellBack = snapshot({ threshold: 100_000, thresholdSource: "fallback" });
    expect(headline(render(fellBack, 24_100))).toBe("24.1k of 100k before compaction (24%)");
  });

  it("an operator-typed threshold reads exactly as it does on main", () => {
    const typed = snapshot({ threshold: 50_000, contextWindow: 1_000_000, thresholdSource: "override" });
    expect(headline(render(typed, 24_100))).toBe("24.1k of 50.0k before compaction (48%)");
  });

  it("a pre-card-366 frame carrying no window reads exactly as it does on main", () => {
    expect(headline(render(snapshot(), 24_100))).toBe("24.1k of 175k before compaction (14%)");
  });
});
