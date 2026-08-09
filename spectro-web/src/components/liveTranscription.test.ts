import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { LIVE_RATE, captureRate, liveReading, type LiveStatus } from "./liveTranscription";
import { WHISPER_RATE } from "./wavClip";

describe("the live toggle reads the route it is actually on", () => {
  const hosted: LiveStatus = { route: "hosted", speechWorks: true };
  const local: LiveStatus = { route: "local", speechWorks: true };

  it("streams on the hosted route and says nothing is in the way", () => {
    const reading = liveReading(hosted, true);
    expect(reading.streams).toBe(true);
    expect(reading.active).toBe(true);
    expect(reading.blocked).toBeNull();
  });

  it("greys the control out on the local route instead of hiding it", () => {
    // The owner's rule for this control, verbatim: greyed out whenever the
    // route being taken cannot stream, active when it can, never hidden.
    const reading = liveReading(local, true);
    expect(reading.streams).toBe(false);
    expect(reading.active).toBe(false);
    expect(reading.blocked).toBe("localRoute");
  });

  it("never reroutes a local user to the hosted path to get live text", () => {
    // The other half of the rule, and the one with teeth: silently switching
    // would send the audio of someone who chose the offline route off the
    // machine. Wanting live is not consent to that.
    const reading = liveReading(local, true);
    expect(reading.active).toBe(false);
    expect(reading.route).toBe("local");
  });

  it("stays off when the route can stream but nobody asked for it", () => {
    const reading = liveReading(hosted, false);
    expect(reading.streams).toBe(true);
    expect(reading.active).toBe(false);
    expect(reading.blocked).toBeNull();
  });

  it("names a missing key as its own reason, not as the route's fault", () => {
    // provider=openai with no key: SttRoute still reports hosted, because an
    // explicit choice wins even when it cannot run. The control has to say
    // which of the two things is wrong or the fix is a guess.
    const reading = liveReading({ route: "hosted", speechWorks: false }, true);
    expect(reading.blocked).toBe("noKey");
    expect(reading.active).toBe(false);
  });

  it("always has a sentence, including when it is greyed out", () => {
    // "Never hidden" is only worth something if the disabled control explains
    // itself. A grey switch with no reason is a vanished button with extra
    // steps — the exact defect step 1 of this card was opened for.
    for (const status of [hosted, local, { route: "hosted", speechWorks: false } as LiveStatus]) {
      for (const wanted of [true, false]) {
        const reading = liveReading(status, wanted);
        expect(reading.key).toMatch(/^voice\.live\./);
        expect(dict[reading.key]).toBeDefined();
      }
    }
  });
});

describe("the capture rate is a function of the route", () => {
  it("captures at 24 kHz for a live hosted session", () => {
    // Measured 2026-08-09 against the realtime API: rate 16000 is refused with
    // integer_below_min_value, expected >= 24000. The local encoder's 16 kHz is
    // whisper.cpp's one input rate, so the two paths cannot share a number.
    expect(captureRate("hosted", true)).toBe(LIVE_RATE);
    expect(LIVE_RATE).toBe(24000);
  });

  it("keeps whisper's rate for every path that is not a live session", () => {
    expect(captureRate("local", true)).toBe(WHISPER_RATE);
    expect(captureRate("local", false)).toBe(WHISPER_RATE);
    expect(captureRate("hosted", false)).toBe(WHISPER_RATE);
  });

  it("never captures below what the live session accepts", () => {
    // The refusal this pins is a 400 from the far side after the user has
    // already spoken, which is the worst moment to learn about a constant.
    expect(captureRate("hosted", true)).toBeGreaterThanOrEqual(24000);
  });
});
