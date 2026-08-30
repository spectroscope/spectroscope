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

/** One reading of the card: where its top sits inside the map pane, and how
 *  tall it is. Both in the units the browser reports them in — the top in
 *  screen px measured from the top of `.lab-flowmap`, the height in world px
 *  off React Flow's own measurement of the node. */
export interface CardFrame {
  top: number;
  height: number;
}

export interface StillnessVerdict {
  /** No step moved the card by more than STILL_TOLERANCE_PX. */
  still: boolean;
  /** Every distinct top the card took, in the order they first appeared. */
  tops: number[];
  /** Every distinct height, likewise. */
  heights: number[];
  /** The biggest single-step move of each, counting only moves a screen could
   *  show; 0 when nothing moved. */
  worstTopMove: number;
  worstHeightMove: number;
  /** How many steps moved the card at all. */
  movedOn: number;
  /** Whether every reading sat at or above AGENT_TOP_CEILING_PX. */
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
    heights: distinct(seen.map((f) => f.height)),
    worstTopMove,
    worstHeightMove,
    movedOn,
    seatedHighEnough: seen.every((f) => f.top <= AGENT_TOP_CEILING_PX),
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
