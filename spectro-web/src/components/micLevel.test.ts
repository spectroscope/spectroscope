// Card 187 steps 3 to 5: the meter says the microphone hears you, and the two
// small signals stay out of the way when the platform asks them to.

import { describe, expect, it } from "vitest";
import { METER_BARS, levelOf, mayClick, meterBars } from "./micLevel";

describe("how loud one frame was", () => {
  it("is zero for silence, which an analyser writes as 128 everywhere", () => {
    expect(levelOf(new Uint8Array(64).fill(128))).toBe(0);
  });

  it("rises with the signal", () => {
    const quiet = levelOf(new Uint8Array(64).fill(134));
    const loud = levelOf(new Uint8Array(64).fill(200));
    expect(quiet).toBeGreaterThan(0);
    expect(loud).toBeGreaterThan(quiet);
  });

  // RMS, not peak. A peak meter pins to the top on any consonant and then says
  // the same thing about a whisper and a shout.
  it("reads a single spike as quiet, not as full scale", () => {
    const spike = new Uint8Array(64).fill(128);
    spike[0] = 255;
    expect(levelOf(spike)).toBeLessThan(0.2);
  });

  it("never leaves 0…1, whatever arrives", () => {
    expect(levelOf(new Uint8Array(8).fill(255))).toBeLessThanOrEqual(1);
    expect(levelOf(new Uint8Array(8).fill(0))).toBeLessThanOrEqual(1);
    expect(levelOf([])).toBe(0);
  });
});

describe("the bars", () => {
  it("draws one per bar, tallest in the middle", () => {
    const bars = meterBars(0.3);
    expect(bars).toHaveLength(METER_BARS);
    const middle = (METER_BARS - 1) / 2;
    expect(bars[middle]).toBeGreaterThan(bars[0]);
    expect(bars[middle]).toBeGreaterThan(bars[METER_BARS - 1]);
  });

  it("is never fully flat, because a dead meter reads as a dead microphone", () => {
    expect(meterBars(0).every((h) => h > 0)).toBe(true);
  });

  it("stays inside its box at any volume", () => {
    for (const level of [0, 0.1, 0.5, 1]) {
      expect(meterBars(level).every((h) => h <= 1)).toBe(true);
    }
  });

  // Ordinary speech sits near 0.1 RMS. Without gain the meter would only move
  // when someone shouts, and would read as broken the rest of the time.
  it("visibly moves at ordinary speaking level", () => {
    const speech = meterBars(0.12);
    const silence = meterBars(0);
    expect(speech[2]).toBeGreaterThan(silence[2] * 2);
  });
});

describe("whether to make a sound at all", () => {
  it("stays silent when the platform asks for no incidental effects", () => {
    expect(mayClick(true, true)).toBe(false);
  });

  it("stays silent when the reader switched it off", () => {
    expect(mayClick(false, false)).toBe(false);
  });

  it("clicks only when both say yes", () => {
    expect(mayClick(false, true)).toBe(true);
  });
});
