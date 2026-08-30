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
import { agentBelt } from "./belt";
import { gridsOf } from "./cssScope";

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
    // longHead 323.06 · longMeta 319.19 · attach4 423.00 · worst 479.77.
    expect(SUB_CARD_H).toBe(480);
  });
});

const css = readFileSync(new URL("./flowmap.css", import.meta.url), "utf8");

describe("the caps that make the reserve a bound", () => {
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

// ---------------------------------------------------------------------------
// Card 321 put a THIRD kind on the agent belt — a chip printing the wire name
// of a running tool this belt has no chip for. It shipped spanning the grid,
// and a spanning chip is a ROW the seat above never priced.
//
// Measured live 2026-08-30, the real card in `.pf-root > .pf-flow >
// .react-flow__node-subagent` with flowmap.css loaded, read through
// getBoundingClientRect (so `zoom: 0.6` is inside the numbers, world px):
//
//   the card 287 fixture, Bash in flight       320.30   belt 106.45
//   the same fixture, WebFetch in flight       342.31   belt 128.45
//   delta                                      +22.01
//
// The bound above is 479.77 against a 480 seat — 0.23 px of headroom, tight on
// purpose — so the same card with an unmapped tool in flight renders 501.78
// into a 480 seat and trips reportOversizeCards (FlowMap.tsx:228). 5.9% of the
// corpus reaches this chip, and WebFetch/StructuredOutput/ToolSearch are
// exactly what a fan-out worker runs, so this is not a corner.
//
// The repair is not a fourth cap: the belt does not have to grow at all. Nine
// chips in two columns leave half of the last row empty, and the tenth fits it.
// Measured in the same pass: a half column is 193.9 world px against 75.2 for
// `StructuredOutput`, the longest name in the census that can wear this chip.
// So the belt costs the same rows either way, and BOTH halves of that sentence
// are read rather than typed — the columns out of flowmap.css, the chips out
// of belt.ts.
describe("the belt is not a growth region of the worker card (card 321)", () => {
  // Read through `cssScope.ts`, which is the ONE reader — this file used to
  // carry a second one and the two disagreed twice over. It anchored on the
  // literal `".pf-tools {"`, which `.pf-agent--wide .pf-tools {` contains as a
  // substring, so it could end up reading the EXPANDED hub's rule for a card
  // that never wears that class; and it counted the value's WORDS, so
  // `84px minmax(0, 1fr) auto` would have been four columns and not three.
  // Neither shows on today's `1fr 1fr`, which is how two readers drift.
  //
  // "compact" is the worker card's scope and not a shorthand: it renders
  // `AgentCardBody` (card 287) with no `.pf-agent--wide` anywhere above it, so
  // the rule that reaches its belt is the one stated without an ancestor.
  const cols = (): number => {
    const n = gridsOf(css, "compact").get("pf-tools");
    expect(n, ".pf-tools declares no grid-template-columns for a card without ancestors").toBeGreaterThan(0);
    return n!;
  };

  /** A name no vocabulary spells, so nothing here is a second tool list: it is
   *  only a string the classifier has never heard of. */
  const NOT_A_TOOL = "zzz-no-such-tool";

  it("a running tool with no chip of its own costs no extra belt row", () => {
    const rows = (n: number) => Math.ceil(n / cols());
    const fixed = agentBelt(null);
    const foreign = agentBelt(NOT_A_TOOL);
    expect(foreign.length, "nothing was added, so this case measures nothing").toBe(fixed.length + 1);
    expect(rows(foreign.length), `${foreign.length} chips in ${cols()} columns`).toBe(rows(fixed.length));
  });

  it("and the chip it adds spends one cell, like every chip beside it", () => {
    const block = css.slice(css.indexOf(".pf-chip--foreign {"));
    const rule = block.slice(0, block.indexOf("}"));
    expect(rule, "the block was not found where it is looked for").toContain("border-style");
    expect(rule, "a spanning chip is a belt row the worker seat never priced").not.toMatch(
      /grid-(column|area)/,
    );
  });
});
