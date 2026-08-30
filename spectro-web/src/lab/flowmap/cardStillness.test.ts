// CARD 319 — the half of the proof that needs a real browser, and therefore
// does not live in this gate.
//
// The gate runs on node. It has no layout engine, so no assertion here can
// know how tall the agent card is; a height typed into this file would be a
// number I made up wearing a test's clothes. What the gate CAN do is what card
// 296 did for the envelope: own the JUDGEMENT as a pure function, bite it in
// both directions against readings a browser really took, and put a caller in
// front of it so the measurement happens where the pixels are — in the app,
// on the owner's own run, saying so out loud when the card moves.
//
// So this file pins `cardStillness.ts`, and `cardStillness.ts` is the
// instrument. Its arm is the answer to "how would we know if this regressed":
// not by anyone remembering to re-measure, but because stepping a recording in
// the running app prints the movement.
//
// WHAT THE BROWSER MEASURED, and what these fixtures are (1600x900 window,
// .pf-flow 1272x581, expanded view, stepped one click at a time through the
// real Step forward control):
//
//   the agent card's height, owner's 3328 steps  6 values, 363.97 .. 932.98
//     changed on 931 steps (28 %), worst single step 226.13
//   the agent card's top, on screen              4 values, 256.5 .. 309.8
//     changed on 708 steps (21.3 %), worst single step 53.3
//   .lab-flowmap's own top                       172.2 / 209.2 / 225.5
//     — the map itself sliding down as the status band wraps
//
// Frames were counted before any of it was believed (the house rule: a hidden
// pane fires no requestAnimationFrame, so a frame-driven reading there is an
// artefact). The count was 0, and the readings were then shown not to depend
// on frames at all: a frameless probe and a screenshot-forced probe of the
// same state came back byte-identical.
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  AGENT_TOP_CEILING_PX,
  STILL_TOLERANCE_PX,
  cardFrame,
  reportRestlessCard,
  resetStillnessMemory,
  stillnessVerdict,
} from "./cardStillness";

/**
 * Every height the agent card rendered over the owner's 3328 steps — the six
 * states, ascending. A SET, deliberately: the order steps arrive in is not
 * recorded, and a series I invented would put transitions in his run that
 * never happened there. The one transition that IS recorded gets its own
 * fixture below.
 */
const OWNER_HEIGHTS = [363.97, 563.66, 574.6, 706.85, 917.47, 932.98] as const;

/** Every top the card took on screen over the same run — four values, again a
 *  set and not a walk. */
const OWNER_TOPS = [256.5, 285.1, 293.5, 309.8] as const;

/**
 * The worst single click the measurement clocked, both readings of it.
 *
 * Height: 706.85 (5 pictures, no tool) -> 932.98 (6 pictures and a long MCP
 * tool name in the panel label) = 226.13, the biggest one-step change over
 * 3328 steps. Top: the status band idle (47.0 px tall, .lab-flowmap at 172.2)
 * puts the card top at 256.5; a long `git add …` command wraps the band to
 * 100.4, pushes .lab-flowmap to 225.5 and the card top to 309.8. 309.8 - 256.5
 * = 53.3, and 100.4 - 47.0 = 53.4 — the same travel, measured twice from two
 * ends of the same mechanism.
 */
const WORST_CLICK = [
  cardFrame({ card: { top: 256.5 }, paneTop: 172.2, scrolled: 0, height: 706.85, view: "one seating" }),
  cardFrame({ card: { top: 309.8 }, paneTop: 225.5, scrolled: 0, height: 932.98, view: "one seating" }),
] as const;

/** `.lab-flowmap`'s own top with the band idle, where the run states both
 *  numbers: the card at 256.5 sits 84.3 into the pane. */
const OWNER_PANE_TOP = 172.2;

/** The smallest gap between two heights the browser really told apart:
 *  563.66 -> 574.60. Anything at or above this is movement by any reading. */
const SMALLEST_REAL_GAP = 10.94;

/** A walk under ONE view, which is what every case below is about: the map
 *  standing still while the card does or does not. */
const frames = (tops: readonly number[], heights: readonly number[]) =>
  tops.map((top, i) =>
    cardFrame({
      card: { top },
      paneTop: 0,
      scrolled: 0,
      height: heights[i % heights.length],
      view: "one seating",
    }),
  );

beforeEach(() => {
  resetStillnessMemory();
});

describe("the verdict, bitten in both directions", () => {
  it("calls a card that never moves still, and says so with no numbers to report", () => {
    const v = stillnessVerdict(frames([150, 150, 150, 150], [900]));
    expect(v.still).toBe(true);
    expect(v.tops).toEqual([150]);
    expect(v.heights).toEqual([900]);
    expect(v.worstTopMove).toBe(0);
    expect(v.worstHeightMove).toBe(0);
    expect(v.movedOn).toBe(0);
  });

  // A verdict that answered "still" for everything would make the arm a
  // decoration, and this is the reading it has to fail on: the owner's own.
  it("calls the owner's own run restless, and counts every box it took", () => {
    const v = stillnessVerdict(
      OWNER_HEIGHTS.map((height, i) =>
        cardFrame({
          card: { top: OWNER_TOPS[i % OWNER_TOPS.length] },
          paneTop: OWNER_PANE_TOP,
          scrolled: 0,
          height,
          view: "one seating",
        }),
      ),
    );
    expect(v.still).toBe(false);
    expect(v.heights).toEqual([...OWNER_HEIGHTS]);
    expect(v.tops).toEqual([...OWNER_TOPS]);
  });

  it("measures the worst single click of that run at the size the browser gave it", () => {
    const v = stillnessVerdict(WORST_CLICK);
    expect(v.still).toBe(false);
    expect(v.movedOn).toBe(1);
    expect(v.worstHeightMove).toBeCloseTo(226.13, 2);
    expect(v.worstTopMove).toBeCloseTo(53.3, 2);
  });

  // The tolerance, justified out of the measurement instead of chosen: the
  // browser told 563.66 and 574.60 apart, so a 10.94 px step is movement and
  // no tolerance may swallow it. Below a device pixel at the owner's dpr 2
  // (0.5 CSS px) nothing is on the screen to see, so 0.25 is not movement.
  // Both sides are pinned as BEHAVIOUR — a bare `expect(TOLERANCE).toBe(0.5)`
  // is green in both directions the moment someone edits the constant.
  it("counts the smallest step the browser could tell apart as movement", () => {
    const v = stillnessVerdict(frames([150, 150], [900, 900 + SMALLEST_REAL_GAP]));
    expect(v.still).toBe(false);
    expect(v.movedOn).toBe(1);
  });

  it("does not count a step no screen can show as movement", () => {
    expect(stillnessVerdict(frames([150, 150.25], [900, 900.25])).still).toBe(true);
  });

  it("keeps the tolerance under a device pixel, so it can never grow into the defect", () => {
    expect(STILL_TOLERANCE_PX).toBeGreaterThan(0);
    expect(STILL_TOLERANCE_PX).toBeLessThanOrEqual(0.5);
  });

  it("says nothing at all about a series too short to have a step in it", () => {
    expect(stillnessVerdict([]).still).toBe(true);
    expect(stillnessVerdict(frames([1], [2])).still).toBe(true);
  });
});

describe("where the card sits in the frame", () => {
  // AC 2's second half. The owner asked for the card "a bit higher so it does
  // not keep popping around at the bottom", and 64 px is the card's proposal —
  // it stands under Open, owner, and the number is HERE rather than scattered
  // so a different answer is one edit.
  it("states the ceiling the card proposed", () => {
    expect(AGENT_TOP_CEILING_PX).toBe(64);
  });

  it("faults the placement the owner has today", () => {
    // 256.5 on his screen against a map starting at 172.2 — 84.3 into the pane.
    const v = stillnessVerdict([
      cardFrame({ card: { top: 256.5 }, paneTop: OWNER_PANE_TOP, scrolled: 0, height: 706.85, view: "v" }),
    ]);
    expect(v.intoPane).toHaveLength(1);
    expect(v.intoPane[0]).toBeCloseTo(84.3, 2);
    expect(v.seatedHighEnough).toBe(false);
  });

  it("and passes a card seated inside it", () => {
    const v = stillnessVerdict([
      cardFrame({
        card: { top: OWNER_PANE_TOP + AGENT_TOP_CEILING_PX },
        paneTop: OWNER_PANE_TOP,
        scrolled: 0,
        height: 706.85,
        view: "v",
      }),
    ]);
    expect(v.seatedHighEnough).toBe(true);
  });
});

describe("the arm speaks once, and only when there is something to say", () => {
  it("stays silent while the card holds its box", () => {
    const said: string[] = [];
    for (const f of frames([150, 150, 150], [900])) reportRestlessCard(f, (m: string) => said.push(m));
    expect(said).toEqual([]);
  });

  it("names the movement the first time the box changes, and does not repeat itself", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    for (const f of WORST_CLICK) reportRestlessCard(f, sink);
    reportRestlessCard(WORST_CLICK[0], sink);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("agent card");
    expect(said[0]).toContain("226");
    expect(said[0]).toContain("53");
  });

  // A hidden pane measures nothing and React Flow reports 0 for a node it has
  // not laid out. A zero must read as "no reading", never as a card of no
  // height — the same trap `measuredCards` documents.
  it("treats an unmeasured frame as no reading rather than as a card of no size", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    const [seen, unmeasured] = frames([150, 0], [900, 0]);
    reportRestlessCard(seen, sink);
    reportRestlessCard(unmeasured, sink);
    reportRestlessCard(seen, sink);
    expect(said).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// WHICH TOP, AND WHOSE MOVE. Two seams the first pass of this file left open,
// both found by driving the built branch rather than by reading it.
//
// 1. THE ARM WAS BLIND TO ITS OWN DEFECT. `WORST_CLICK` above is a WINDOW
//    reading — 256.5 -> 309.8 is where the card sat on the owner's screen. What
//    FlowMap actually handed the arm was the card's top measured from the top of
//    `.lab-flowmap`, and the band mover moves the PANE with the card inside it:
//    measured on the pre-fix build at 1600x900, the card's top in the pane was
//    one value with a worst step of 0.00 while its top in the window took three
//    and travelled 53.31. The instrument answered "0.0px of screen top" to the
//    very travel it was built to catch.
//
//    So the two tops are two fields now, and the reading is computed in one
//    place instead of at the call site, where nothing could tell them apart.
//
// 2. AND IT BLAMED THE BUDGET FOR MOVES THE MAP MADE. Stepping the shipped
//    recording at 1600x900 past step 104, workers arrive, the world grows and
//    `fitView` re-fits: zoom 0.27 -> 0.19 -> 0.10 and the card's top runs from
//    45.44 to -5071.92 without the card changing by a pixel. A dragged card is
//    the same story. The message the arm is allowed to print says the card "is
//    supposed to be budgeted, so every region inside it should hold its room" —
//    a sentence about the card, printed about the map.
//
//    A reading now carries WHAT THE MAP WAS DOING when it was taken. Two
//    readings under different views are not a step, and the band mover — which
//    changes neither the viewport nor the card's seat — is still caught.
// ---------------------------------------------------------------------------
describe("the reading knows which top is which", () => {
  // Rects the way the browser gave them at 1600x900, from the pre-fix build:
  // the band idle, and the same card with a long `git add …` command wrapping
  // the band onto three lines.
  const IDLE = cardFrame({ card: { top: 256.5 }, paneTop: 172.2, scrolled: 0, height: 706.85, view: "v" });
  const WRAPPED = cardFrame({ card: { top: 309.8 }, paneTop: 225.5, scrolled: 0, height: 706.85, view: "v" });

  it("reports where the card sits on the screen, not where it sits in the pane", () => {
    expect(IDLE.top).toBeCloseTo(256.5, 2);
    expect(WRAPPED.top).toBeCloseTo(309.8, 2);
  });

  it("and keeps the distance into the pane as its own reading", () => {
    expect(IDLE.intoPane).toBeCloseTo(84.3, 2);
    expect(WRAPPED.intoPane).toBeCloseTo(84.3, 2);
  });

  // THE ONE. The band mover leaves the card exactly where it was inside the
  // map and moves the map — so the pane reading is the same on both frames and
  // an arm that judged it would have nothing to say.
  it("catches the band mover, which a pane reading cannot see", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(IDLE, sink);
    reportRestlessCard(WRAPPED, sink);
    expect(IDLE.intoPane).toBeCloseTo(WRAPPED.intoPane, 2);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("53.3");
  });

  it("judges the seat against the pane and not against the window", () => {
    expect(stillnessVerdict([IDLE]).seatedHighEnough).toBe(false);
    expect(
      stillnessVerdict([cardFrame({ card: { top: 900 }, paneTop: 880, scrolled: 0, height: 700, view: "v" })])
        .seatedHighEnough,
    ).toBe(true);
  });
});

describe("a move the map made is not the budget's fault", () => {
  const at = (top: number, view: string) =>
    cardFrame({ card: { top }, paneTop: 100, scrolled: 0, height: 900, view });

  it("says nothing when the map re-fitted under the card", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(at(200, "zoom 0.27"), sink);
    reportRestlessCard(at(-5071.92, "zoom 0.19"), sink);
    expect(said).toEqual([]);
  });

  // The bite that keeps the case above from being a way to switch the arm off:
  // the same two tops under the SAME view are the defect, and are still named.
  it("and says so when nothing but the card moved", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(at(200, "zoom 0.27"), sink);
    reportRestlessCard(at(253.31, "zoom 0.27"), sink);
    expect(said).toHaveLength(1);
  });

  it("takes the next reading under the new view as the baseline", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(at(200, "a"), sink);
    reportRestlessCard(at(900, "b"), sink);
    reportRestlessCard(at(953.31, "b"), sink);
    expect(said).toHaveLength(1);
  });

  // And the verdict answers the same way, or the gate and the app would judge
  // one series differently.
  it("does not count a step across two views as a step", () => {
    const v = stillnessVerdict([at(200, "a"), at(900, "b")]);
    expect(v.still).toBe(true);
    expect(v.movedOn).toBe(0);
  });
});

describe("a scroll is not the card moving either", () => {
  // Found live, and it is the same family as the re-fit above. At a 1100x700
  // window the lab's centre column is a scroll container, and stepping once off
  // `run_start` scrolls it 252px: `.lab-flowmap` goes 246.39 -> -5.61 and the
  // card's viewport top goes with it, while nothing about the card changed. An
  // arm reading raw viewport coordinates says "252.0px of screen top" and
  // blames the budget for it — measured, with exactly that message.
  //
  // So the reading takes the scroll back out. What is left is where the card
  // sits in the page the owner is looking at, which is the reading the band
  // mover really does change: the band grows, everything below it moves down,
  // and no scrolling happened at all.
  const scrolledTo = (viewportTop: number, scrolled: number) =>
    cardFrame({ card: { top: viewportTop }, paneTop: 100, scrolled, height: 900, view: "v" });

  it("says nothing when the reader's column scrolled under the card", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(scrolledTo(299.67, 0), sink);
    reportRestlessCard(scrolledTo(47.67, 252), sink);
    expect(said).toEqual([]);
  });

  // The bite: the same 252px WITHOUT a scroll under it is the card moving, and
  // is still named. Without this the case above is just a way to switch the arm
  // off for anything that moves far enough.
  it("and says so when the card moved that far with nothing scrolling", () => {
    const said: string[] = [];
    const sink = (m: string) => said.push(m);
    reportRestlessCard(scrolledTo(299.67, 0), sink);
    reportRestlessCard(scrolledTo(47.67, 0), sink);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("252.0");
  });
});

describe("the arm has a caller, so the measurement happens where the pixels are", () => {
  // Card 296's finding, which this card must not repeat: reportOversizeCards
  // existed nowhere in src/ outside its own test, so the half of the check
  // that needs a real browser never ran at all, and a seat that reserved twice
  // its card shipped in silence for two cards. An instrument with no caller is
  // an instrument that is switched off.
  const src = readFileSync(new URL("../FlowMap.tsx", import.meta.url), "utf8");

  it("FlowMap imports it", () => {
    expect(src).toContain('from "./flowmap/cardStillness"');
  });

  it("and calls it with what the browser measured", () => {
    expect(src).toContain("reportRestlessCard(");
  });

  // Through `cardFrame`, and this one is the seam that was actually open: the
  // call site used to subtract the pane's own top and hand the difference to a
  // field the fixtures had filled with window readings. A reading assembled at
  // the call site is a reading nothing tested.
  it("builds the reading where the two tops cannot be mixed up", () => {
    expect(src).toContain("cardFrame({");
    expect(src, "the call site is measuring a top of its own again").not.toMatch(
      /top:\s*[\w.()]*getBoundingClientRect\(\)\.top\s*-/,
    );
  });
});
