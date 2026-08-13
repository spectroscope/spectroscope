// What the replay stage shows at a given step — the pure half of BrowserReplay,
// so the decisions can be measured without a DOM.
//
// The one decision worth writing down is the HOLD. The measured shape of a real
// browser run (card 201, 3,447 calls) is one navigate, one screenshot, then a
// run of up to twelve evals: eval is the verification mode, actuator and sensor
// at once, and it takes no picture. A stage that blanked whenever the current
// step had no screenshot would therefore be blank for most of the run.
//
// So the stage holds the last picture that WAS taken — and never a later one.
// Showing step 3's screenshot while the scrubber sits at step 0 would be a claim
// about what the page looked like at a moment nobody photographed, which is the
// same kind of lie as a tool that answers with its own argument.

import { hasScreenshot, type BrowserActionMeta } from "../wire/browserWire";

/**
 * The scrubber position, kept inside the trace it belongs to.
 *
 * @param at    the position asked for
 * @param count how many steps there are
 * @return a position that exists; 0 for an empty trace
 */
export function clampStep(at: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(at, 0), count - 1);
}

/**
 * The most recent step at or before this one that actually took a picture.
 *
 * @param steps the epoch's steps, in the order they happened
 * @param at    the scrubber position
 * @return that step, or null when nothing has been photographed yet
 */
export function lastShotBefore(steps: readonly BrowserActionMeta[], at: number): BrowserActionMeta | null {
  for (let i = clampStep(at, steps.length); i >= 0; i--) {
    const step = steps[i];
    if (step !== undefined && hasScreenshot(step)) return step;
  }
  return null;
}

/**
 * What the stage paints at this position.
 *
 * @param steps the epoch's steps, in the order they happened
 * @param at    the scrubber position
 * @return the step whose picture is on screen, or null when there is none yet
 */
export function replayStage(steps: readonly BrowserActionMeta[], at: number): BrowserActionMeta | null {
  return steps.length === 0 ? null : lastShotBefore(steps, at);
}
