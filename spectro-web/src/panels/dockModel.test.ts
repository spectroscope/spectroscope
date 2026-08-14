// Card 219, first cut — the dock model: pure decisions for the workspace's
// independent panels. Card 228 (criterion 0) changed the LAYOUT from a divider
// stack to a grid of cards, so the pair-weight arithmetic left this module
// with the dividers; what remains is the vocabulary and the mode rules the
// grid still runs on.
//
// Everything here is testable without a DOM, which is the house suite's rule
// (plain Node, renderToStaticMarkup elsewhere). The DOM behaviour these
// decisions drive is pinned in dockRender.test.tsx and the drift tests.

import { describe, expect, it } from "vitest";
import { DOCK_ORDER, dockLabelKey, normalizeDockMode } from "./dockModel";

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
