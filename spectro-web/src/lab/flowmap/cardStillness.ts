// CARD 319 — the agent card's box, judged.
//
// The complaint this exists for, in the owner's words: "it really goes back and
// forth, flick, flick, flick, it flickers the whole time when you step through,
// depending on how big the command is."
//
// The gate cannot see a pixel — node has no layout engine — so the JUDGEMENT
// lives here as a pure function and the MEASUREMENT happens in the running app,
// where FlowMap hands this module the rectangle the browser laid out. That
// split is card 296's own finding, restated: `reportOversizeCards` existed
// nowhere in src/ outside its own test, so the half of the check that needs a
// real browser never ran and a seat that reserved twice its card shipped in
// silence for two cards. An instrument with no caller is an instrument that is
// switched off.
//
// WHAT THE BROWSER MEASURED before any of this was written (1600x900 window,
// .pf-flow 1272x581, expanded view, the owner's own 44-hour recording stepped
// one click at a time through the real Step forward control, 3328 steps):
//
//   the card's height   6 values, 363.97 .. 932.98, changed on 931 steps (28 %)
//                       worst single step 226.13
//   the card's top      4 values, 256.5 .. 309.8, changed on 708 steps (21.3 %)
//                       worst single step 53.3
//
// Neither the fold nor `fitView` moved it: the agent node's world y was 150 for
// all 3328 steps and the React Flow viewport transform was one constant. The
// top travelled because the status band above the map wrapped (see
// labNowBand.drift.test.ts), and the height travelled because the tool-call
// panel was created on `tool_call` and destroyed on `tool_result`.

/**
 * One reading of the card.
 *
 * TWO TOPS, because the card has two and the first pass of this file used one
 * field for both. `top` is where the card sits on the SCREEN — the distance the
 * owner watches, and the one the band mover changes, because that mover slides
 * the whole pane down with the card inside it. `intoPane` is how far below the
 * map's own top edge it sits, which is the placement question (AC 2) and is
 * exactly the reading the band mover leaves untouched. Measured on the pre-fix
 * build at a 1600x900 window: `intoPane` one value, worst step 0.00, while
 * `top` took three and travelled 53.31.
 */
export interface CardFrame {
  /** The card's top edge, in px from the top of the page the owner is looking
   *  at — the viewport reading with the containers' own scrolling added back
   *  in, so scrolling the column is not mistaken for the card moving. */
  top: number;
  /** The card's top edge, in screen px below the top of `.lab-flowmap`. */
  intoPane: number;
  /** The node's height in world px, off React Flow's own measurement — the
   *  unit the envelope table is in, and not the zoomed one the DOM reports. */
  height: number;
  /**
   * What the map was doing when this was read: where the layout seated the card
   * in the world, and how the pane was looking at that world.
   *
   * Two readings taken under different views are not a step. The map re-fits
   * when the world grows — stepping the shipped recording past the point where
   * workers arrive, the zoom runs 0.27 -> 0.19 -> 0.10 and the card's top with
   * it — and the reader can drag the card himself. Neither is the budget's
   * doing, and the arm below is only allowed to speak about the budget.
   */
  view: string;
}

/**
 * One reading, assembled where the two tops cannot be mixed up.
 *
 * This exists because they WERE mixed up: FlowMap subtracted the pane's top at
 * the call site and handed the difference to a field the fixtures had filled
 * with window readings, so the arm answered "0.0px of screen top" to the 53.3
 * it was built to catch. One place, one answer, and it is tested.
 */
export function cardFrame(reading: {
  /** The card's rectangle on screen. Only its top is read — its height there is
   *  the zoomed one, which is the wrong unit for a box. */
  card: { top: number };
  /** `.lab-flowmap`'s own top on screen. */
  paneTop: number;
  /**
   * How far the containers around the map have been scrolled, added up.
   *
   * Taken back out of `top`, because a column that scrolls carries the card
   * with it and that is not the card moving. Measured at a 1100x700 window:
   * one step off `run_start` scrolls `.lab-center` by 252px and the arm, given
   * raw viewport coordinates, blamed the budget for all 252 of them.
   */
  scrolled: number;
  /** The node's height in world px. */
  height: number;
  view: string;
}): CardFrame {
  return {
    top: reading.card.top + reading.scrolled,
    intoPane: reading.card.top - reading.paneTop,
    height: reading.height,
    view: reading.view,
  };
}

export interface StillnessVerdict {
  /** No step moved the card by more than STILL_TOLERANCE_PX. */
  still: boolean;
  /** Every distinct top the card took on screen, in the order they first
   *  appeared. */
  tops: number[];
  /** Every distinct distance into the pane, likewise — the placement reading,
   *  which the band mover leaves alone while `tops` travels. */
  intoPane: number[];
  /** Every distinct height, likewise. */
  heights: number[];
  /** The biggest single-step move of each, counting only moves a screen could
   *  show; 0 when nothing moved. */
  worstTopMove: number;
  worstHeightMove: number;
  /** How many steps moved the card at all. */
  movedOn: number;
  /** Whether every reading sat that high in the pane or higher — a distance
   *  into the pane no greater than AGENT_TOP_CEILING_PX. */
  seatedHighEnough: boolean;
}

/**
 * The smallest move that counts as one.
 *
 * Justified out of the measurement rather than chosen. The browser told 563.66
 * and 574.60 apart — a 10.94 px step — so no tolerance may be wide enough to
 * swallow that. At the owner's devicePixelRatio of 2 a device pixel is 0.5 CSS
 * px, so below that there is nothing on the screen to see. Those two facts
 * bracket it, and the bracket is what cardStillness.test.ts pins: the 10.94 has
 * to read as movement and a quarter of a CSS pixel must not.
 */
export const STILL_TOLERANCE_PX = 0.5;

/**
 * How far down the map pane the agent card's top may sit.
 *
 * The owner's second ask — "maybe place the main agent a bit higher so it does
 * not keep popping around at the bottom" — and 64 px is the CARD'S PROPOSAL,
 * not a decided rule: how much higher "a bit higher" is stands under *Open,
 * owner* on card 319. It lives here, in one place, so a different answer is one
 * edit rather than a hunt.
 *
 * Measured today, at the idle status band: 256.5 (card top) - 172.2
 * (.lab-flowmap top) = 84.3 px, and it takes four values over the run because
 * the band underneath it wraps.
 *
 * Because the number is still a proposal, it is judged in the GATE against
 * readings the browser took, and the runtime arm below stays quiet about it. An
 * arm that shouted at every reader about an undecided threshold would be noise,
 * and noise is how the one real finding gets buried.
 */
export const AGENT_TOP_CEILING_PX = 64;

const moved = (a: number, b: number) => Math.abs(a - b) > STILL_TOLERANCE_PX;

/** A height of zero is "not laid out yet", never "a card of no height" — a
 *  hidden pane delivers no frames and React Flow reports 0 for a node it has
 *  not measured. The same trap `measuredCards` documents. */
const read = (frames: readonly CardFrame[]) => frames.filter((f) => f.height > 0);

/** Distinct values, in the order they were first seen. */
function distinct(values: readonly number[]): number[] {
  const out: number[] = [];
  for (const v of values) if (!out.some((seen) => !moved(seen, v))) out.push(v);
  return out;
}

/**
 * What a series of readings says about the card.
 *
 * @param frames every reading, in the order the reader produced them
 */
export function stillnessVerdict(frames: readonly CardFrame[]): StillnessVerdict {
  const seen = read(frames);
  let worstTopMove = 0;
  let worstHeightMove = 0;
  let movedOn = 0;
  for (let i = 1; i < seen.length; i++) {
    // A step the MAP took is not a step the card took. Skipped rather than
    // counted still: the two readings are not comparable at all.
    if (seen[i].view !== seen[i - 1].view) continue;
    const topMove = Math.abs(seen[i].top - seen[i - 1].top);
    const heightMove = Math.abs(seen[i].height - seen[i - 1].height);
    const topMoved = topMove > STILL_TOLERANCE_PX;
    const heightMoved = heightMove > STILL_TOLERANCE_PX;
    if (topMoved) worstTopMove = Math.max(worstTopMove, topMove);
    if (heightMoved) worstHeightMove = Math.max(worstHeightMove, heightMove);
    if (topMoved || heightMoved) movedOn++;
  }
  return {
    still: movedOn === 0,
    tops: distinct(seen.map((f) => f.top)),
    intoPane: distinct(seen.map((f) => f.intoPane)),
    heights: distinct(seen.map((f) => f.height)),
    worstTopMove,
    worstHeightMove,
    movedOn,
    seatedHighEnough: seen.every((f) => f.intoPane <= AGENT_TOP_CEILING_PX),
  };
}

/** The last reading that was actually a reading, and whether the arm has
 *  already spoken. Per module, like the envelope arm's memory next door, so a
 *  suite that shares the module shares them — hence the reset seam below. */
let previous: CardFrame | null = null;
let spoken = false;

/** Forget every reading and the once-only lock. A test seam, and it has to be
 *  one: without it the first suite to move the card decides the next one's
 *  verdict. */
export function resetStillnessMemory(): void {
  previous = null;
  spoken = false;
}

/**
 * The runtime arm: hand it what the browser just laid out and it says so, once,
 * the first time the agent card is not the card it was a step ago.
 *
 * Once, because a map re-lays-out on every step and a report nobody can read is
 * the silence this check was built to break — the same rule the envelope arm
 * follows. It says nothing about WHERE the card sits: that threshold is still
 * the owner's to set (AGENT_TOP_CEILING_PX above).
 *
 * @param frame the reading; a height of 0 is no reading and is dropped
 * @param sink where a finding goes
 */
export function reportRestlessCard(
  frame: CardFrame,
  sink: (message: string) => void = (m) => console.error(m),
): void {
  if (frame.height <= 0) return;
  const before = previous;
  previous = frame;
  if (before === null || spoken) return;
  // The map moved, not the card: a re-fit, a re-seat or the reader's own drag.
  // The message below is a sentence about the budget, and printing it here
  // would name the wrong cause AND burn the one report the arm is allowed.
  if (before.view !== frame.view) return;
  const topMove = Math.abs(frame.top - before.top);
  const heightMove = Math.abs(frame.height - before.height);
  if (!moved(frame.top, before.top) && !moved(frame.height, before.height)) return;
  spoken = true;
  sink(
    `flow map: the agent card changed its box between two steps — ${heightMove.toFixed(1)}px of ` +
      `height and ${topMove.toFixed(1)}px of screen top in one click. The card is supposed to be ` +
      `budgeted, so every region inside it should hold its room whether it is carrying anything ` +
      `or not.`,
  );
}
