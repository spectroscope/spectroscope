// Card 296. Two numbers used to say the same thing in two files with no link:
// sceneToFlow's EXPANDED_CARD.subagent + EXP_GAP, and workerGrid's WORLD.colW +
// WORLD.rowH. Nothing made them move together, and nothing noticed when the
// reserve stopped matching the card. These pins make the desync impossible to
// commit: the layout's own row pitch is measured out of a real sceneToFlow run
// and held against the single source.
import { describe, expect, it } from "vitest";
import {
  RAIL_GAP,
  SUB_CAP_HEAD_PX,
  SUB_CAP_META_PX,
  SUB_CAP_SHELF_PX,
  SUB_CARD_H,
  SUB_CARD_W,
  SUB_COL_PITCH,
  SUB_ROW_PITCH,
} from "./cardGeometry";
import { EXPANDED_CARD, EXP_GAP } from "./sceneToFlow";
import { readFileSync } from "node:fs";

describe("the worker card's geometry has ONE source", () => {
  it("the pitches derive from the card and the rail gap, never from a second literal", () => {
    expect(SUB_ROW_PITCH).toBe(SUB_CARD_H + RAIL_GAP);
    expect(SUB_COL_PITCH).toBe(SUB_CARD_W + RAIL_GAP);
  });

  it("sceneToFlow's envelope IS that source — not a copy of it", () => {
    expect(EXPANDED_CARD.subagent).toEqual({ w: SUB_CARD_W, h: SUB_CARD_H });
    expect(EXP_GAP).toBe(RAIL_GAP);
  });

  // A value pin alone is green in BOTH directions here: write `468` back into
  // workerGrid and the equality still holds, because 408 + 60 IS 468 today.
  // That is exactly how the two numbers drifted apart in the first place, so
  // what has to be pinned is the LINK, and the link is only visible in the
  // source. Each of the four sites is bitten on its own.
  const read = (file: string) => readFileSync(new URL(`./${file}`, import.meta.url), "utf8");

  it("neither consumer writes the numbers out again", () => {
    const scene = read("sceneToFlow.ts");
    expect(scene).toContain("subagent: { w: SUB_CARD_W, h: SUB_CARD_H },");
    expect(scene).toContain("export const EXP_GAP = RAIL_GAP;");
    const grid = read("workerGrid.ts");
    expect(grid).toContain("colW: SUB_COL_PITCH,");
    expect(grid).toContain("rowH: SUB_ROW_PITCH,");
  });

  it("the reserve is the measured browser bound, not a hand sum", () => {
    // Measured 2026-08-29 in Chrome at devicePixelRatio 1, fonts loaded, the
    // card in its real .pf-flow / .react-flow__node-subagent context and read
    // through getBoundingClientRect (so `zoom: 0.6` is already in the number):
    // bare 237.59 · typical 304.44 · toolJson 323.72 · launchPhases 327.83 ·
    // longHead 323.06 · longMeta 319.19 · attach4 420.61 · worst 477.38.
    expect(SUB_CARD_H).toBe(480);
  });
});

describe("the caps that make the reserve a bound", () => {
  const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");

  it("flowmap.css caps every growth region of the full worker card", () => {
    for (const [selector, cap] of [
      [".pf-sub--full .pf-sub__head", SUB_CAP_HEAD_PX],
      [".pf-sub--full .pf-sub__meta", SUB_CAP_META_PX],
      [".pf-sub--full .pf-agent__genfull", SUB_CAP_SHELF_PX],
    ] as const) {
      const block = css.slice(css.indexOf(selector));
      expect(block, selector).toContain(selector);
      expect(block.slice(0, block.indexOf("}")), selector).toContain(`max-height: ${cap}px`);
    }
  });
});
