// Card 219, first cut — the dock model: pure decisions for the right panel's
// stack of independent panels. The owner scoped this cut himself: each surface
// stands on its own, shows and hides independently, is collapsible, and the
// browser is one of them. No moving, no library.
//
// Everything here is testable without a DOM, which is the house suite's rule
// (plain Node, renderToStaticMarkup elsewhere). The DOM behaviour these
// decisions drive is pinned in dockRender.test.tsx and the drift tests.

import { describe, expect, it } from "vitest";
import {
  DIVIDER_STEP_FRACTION,
  DOCK_ORDER,
  MAX_WEIGHT,
  MIN_WEIGHT,
  PANEL_MIN_PX,
  dividerKeyStep,
  dockLabelKey,
  normalizeDockMode,
  pairWeightsForHeights,
  parseDockWeights,
  serializeDockWeights,
  weightOf,
} from "./dockModel";

describe("the dock's vocabulary", () => {
  it("names every panel exactly once, in a stable order", () => {
    expect(DOCK_ORDER).toEqual(["work", "agents", "plan", "context", "files", "terminal", "browser"]);
    expect(new Set(DOCK_ORDER).size).toBe(DOCK_ORDER.length);
  });

  it("gives every panel an i18n label key", () => {
    for (const id of DOCK_ORDER) {
      expect(dockLabelKey(id), id).toMatch(/^rp\./);
    }
  });

  it("reads junk as closed — a corrupt storage entry opens nothing", () => {
    expect(normalizeDockMode("open")).toBe("open");
    expect(normalizeDockMode("collapsed")).toBe("collapsed");
    expect(normalizeDockMode("closed")).toBe("closed");
    expect(normalizeDockMode("banana")).toBe("closed");
    expect(normalizeDockMode(1)).toBe("closed");
    expect(normalizeDockMode(undefined)).toBe("closed");
  });
});

describe("the persisted weights", () => {
  it("round-trips through the serialized form", () => {
    const w = { files: 2, terminal: 0.5 };
    expect(parseDockWeights(serializeDockWeights(w))).toEqual(w);
  });

  it("tolerates junk: unknown ids, NaN and garbage fall away", () => {
    expect(parseDockWeights("")).toEqual({});
    expect(parseDockWeights("files:abc,nonsense:2,terminal:1.5,,:,")).toEqual({ terminal: 1.5 });
  });

  it("clamps what it hands out, not what it stores", () => {
    expect(weightOf({ files: 999 }, "files")).toBe(MAX_WEIGHT);
    expect(weightOf({ files: 0 }, "files")).toBe(MIN_WEIGHT);
    expect(weightOf({}, "files")).toBe(1);
  });
});

describe("the divider arithmetic", () => {
  it("moves height from the lower panel to the upper on a downward drag", () => {
    // Equal weights over 200px each; dragging 50px down grows A to 250 of 400.
    const [wa, wb] = pairWeightsForHeights(1, 1, 200, 200, 50, PANEL_MIN_PX);
    expect(wa).toBeCloseTo(1.25, 5);
    expect(wb).toBeCloseTo(0.75, 5);
    expect(wa + wb).toBeCloseTo(2, 5);
  });

  it("floors both panels at the minimum height", () => {
    const [wa, wb] = pairWeightsForHeights(1, 1, 200, 200, 500, PANEL_MIN_PX);
    // B is left exactly PANEL_MIN_PX of the 400px pair.
    expect(wb).toBeCloseTo((PANEL_MIN_PX / 400) * 2, 5);
    expect(wa + wb).toBeCloseTo(2, 5);
  });

  it("refuses the drag when the pair cannot honour two minima", () => {
    expect(pairWeightsForHeights(1, 1, 50, 40, 10, PANEL_MIN_PX)).toEqual([1, 1]);
  });

  it("steps by a fixed fraction of the pair from the keyboard", () => {
    const [wa, wb] = dividerKeyStep(1, 1, 1);
    expect(wa).toBeCloseTo(1 + 2 * DIVIDER_STEP_FRACTION, 5);
    expect(wa + wb).toBeCloseTo(2, 5);
    // And it clamps rather than driving a weight negative.
    const [minA] = dividerKeyStep(MIN_WEIGHT, 1, -1);
    expect(minA).toBeGreaterThanOrEqual(MIN_WEIGHT);
  });
});
