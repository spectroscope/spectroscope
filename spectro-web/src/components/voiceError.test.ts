// Card 187 step 1: the microphone says WHY, and the difference between "this
// attempt failed" and "this feature is not here".

import { describe, expect, it } from "vitest";
import { VOICE_ERRORS, micErrorOf, silencesTheButton, voiceErrorKey, transcribeErrorOf } from "./voiceError";
import { dict } from "../i18n/i18n";

describe("what the browser said, read as a reason", () => {
  it("knows a refusal from a missing device", () => {
    expect(micErrorOf({ name: "NotAllowedError" })).toBe("denied");
    expect(micErrorOf({ name: "NotFoundError" })).toBe("noDevice");
  });

  it("knows a device somebody else is holding", () => {
    expect(micErrorOf({ name: "NotReadableError" })).toBe("deviceBusy");
  });

  it("reads the NAME and never the message, which is not stable across browsers", () => {
    expect(micErrorOf({ name: "NotAllowedError", message: "Permission dismissed" })).toBe("denied");
    expect(micErrorOf({ message: "NotAllowedError" })).toBe("unknown");
  });

  it("says unknown rather than guessing, and unknown is still a sentence", () => {
    expect(micErrorOf(undefined)).toBe("unknown");
    expect(micErrorOf("boom")).toBe("unknown");
    expect(micErrorOf({ name: "SomethingNewInChrome" })).toBe("unknown");
  });
});

// The split that matters. A missing device or a missing server is a STATE, so
// hiding the button tells the truth. A denial or a failed request is an EVENT,
// and hiding the button for it would leave someone who fixes the cause with no
// way back in short of reloading the page.
describe("which failures take the button away", () => {
  it("hides it only for the two that are states", () => {
    expect(silencesTheButton("noDevice")).toBe(true);
    expect(silencesTheButton("sttMissing")).toBe(true);
  });

  it("keeps it for every other one, including any added later", () => {
    for (const reason of VOICE_ERRORS.filter((r) => r !== "noDevice" && r !== "sttMissing")) {
      expect(silencesTheButton(reason), reason).toBe(false);
    }
  });
});

describe("every reason has something to say", () => {
  it("has a sentence in both languages, so no failure is mute", () => {
    // Walks the real set: a reason added without a sentence fails here rather
    // than showing a blank tooltip to whoever hits it first.
    for (const reason of VOICE_ERRORS) {
      const entry = dict[voiceErrorKey(reason)];
      expect(entry, `no sentence for ${reason}`).toBeTruthy();
      expect(entry.de.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});

describe("transcribeErrorOf splits setup from a bad day", () => {
  it("latches only on 503, which really is setup", () => {
    expect(transcribeErrorOf(503)).toBe("sttMissing");
    expect(silencesTheButton(transcribeErrorOf(503)!)).toBe(true);
  });
  it("keeps the button through the far side failing", () => {
    // The server answers 502 for a hosted provider that refused (a 429, a
    // blip). Latching on it took the microphone away until reload.
    expect(transcribeErrorOf(502)).toBe("requestFailed");
    expect(silencesTheButton(transcribeErrorOf(502)!)).toBe(false);
  });
  it("names this browser's own encoding on 400", () => {
    expect(transcribeErrorOf(400)).toBe("convertFailed");
  });
  it("leaves unknown statuses to the caller", () => {
    expect(transcribeErrorOf(500)).toBeNull();
  });
});
