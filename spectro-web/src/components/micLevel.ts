// The level meter beside the glyph, and the two small signals around it
// (card 187 steps 3 to 5).
//
// Pure on purpose: what an AnalyserNode hands over is a byte array, and turning
// that into bars is arithmetic that can be pinned. The Web Audio part stays in
// the hook, where it belongs and cannot be tested anyway.

/** How many bars the meter draws. Odd, so one sits in the middle. */
export const METER_BARS = 5;

/**
 * The loudness of one frame, 0…1, as the root mean square of the samples.
 *
 * RMS and not the peak: a peak meter pins to the top on any consonant and
 * therefore says the same thing about a whisper and a shout. RMS moves with
 * the voice, which is what "it hears you" has to mean.
 *
 * @param samples time-domain bytes from `getByteTimeDomainData`, 128 = silence
 * @return 0 for silence, rising to 1
 */
export function levelOf(samples: Uint8Array | readonly number[]): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) {
    const centred = (s - 128) / 128;
    sum += centred * centred;
  }
  return Math.min(1, Math.sqrt(sum / samples.length));
}

/**
 * The bar heights for one level, 0…1 each, tallest in the middle.
 *
 * A little gain, because ordinary speech sits around 0.1 RMS and a meter that
 * only moved above half would read as broken during normal talking.
 *
 * @param level 0…1 from {@link levelOf}
 * @return one height per bar
 */
export function meterBars(level: number): number[] {
  const gained = Math.min(1, level * 3);
  const middle = (METER_BARS - 1) / 2;
  return Array.from({ length: METER_BARS }, (_, i) => {
    const distance = Math.abs(i - middle) / middle; // 0 in the middle, 1 at the ends
    const shape = 1 - distance * 0.55;
    return Math.max(0.08, gained * shape); // never fully flat: the meter is alive
  });
}

/**
 * Whether the app may make a sound right now.
 *
 * The click exists to tell a person the microphone is armed, and a sound
 * nobody asked for is worse than no sound. `prefers-reduced-motion` is the
 * signal the platform gives for "no incidental effects", and this app already
 * reads it for the level-up flare.
 *
 * @param reducedMotion what the media query says
 * @param enabled the reader's own preference
 * @return whether to play it
 */
export function mayClick(reducedMotion: boolean, enabled: boolean): boolean {
  return enabled && !reducedMotion;
}
