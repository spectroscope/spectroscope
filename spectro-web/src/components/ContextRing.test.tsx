// Card 366, AC 7: the gauge NAMES the window it measured against.
//
// WHY THE POPOVER IS RENDERED ON ITS OWN. There is no DOM in this gate (no
// jsdom), so the popover cannot be opened by a click — and the ring's button is
// all that renders while it is closed. The popover is therefore its own pure
// component, exported for exactly this reason: its markup is the half that has
// content, and the half the owner has been reading a denominator off for two
// months without being told where the denominator came from.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextPopover } from "./ContextRing";
import { contextDenominator } from "./contextRingMath";
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
  const denominator = contextDenominator(context?.threshold, context?.contextWindow ?? null);
  return renderToStaticMarkup(
    <ContextPopover
      lastInputTokens={lastInputTokens}
      context={context}
      denominator={denominator}
      shownPct={Math.round((lastInputTokens / denominator.value) * 100)}
    />,
  );
};

describe("the context popover names its own window (card 366)", () => {
  it("names the LOADED window for a local backend", () => {
    // The owner's own case, and the one that rendered nothing at all before:
    // qwen3.8-flash-next@q4_k_xl is in no vendor table, so the web's prefix
    // guess returned null and the line was skipped on every local run.
    const html = render(snapshot({ contextWindow: 250_368, thresholdSource: "window" }));

    expect(html).toContain("loaded window · 250k");
    expect(html).toContain("24.1k of 175k before compaction"); // the threshold is still the divisor
  });

  it("names the PUBLISHED window for a cloud model", () => {
    const html = render(snapshot({ threshold: 700_000, contextWindow: 1_000_000, thresholdSource: "model" }));

    expect(html).toContain("model window · 1M");
  });

  it("states the window with no origin when the operator typed the threshold", () => {
    // The FRAME here is one the harness can really emit, which the first
    // version of this case was not: it paired an override with the owner's
    // LOADED 250,368, and under an override the probe is never run
    // (CompactionThreshold.derive, the IntSupplier form), so a loaded figure
    // can never ride an "override" frame. What can is the published ceiling —
    // 1,000,000 for claude-opus under a 50,000 somebody typed.
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
