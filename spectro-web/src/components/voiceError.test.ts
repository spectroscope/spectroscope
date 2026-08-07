// Card 187 step 1: the microphone says WHY, and the difference between "this
// attempt failed" and "this feature is not here".

import { describe, expect, it } from "vitest";
import { micErrorOf, silencesTheButton, voiceErrorKey } from "./voiceError";
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

  it("keeps it for the ones a person can act on right now", () => {
    for (const reason of ["denied", "deviceBusy", "requestFailed", "unknown"] as const) {
      expect(silencesTheButton(reason)).toBe(false);
    }
  });
});

describe("every reason has something to say", () => {
  it("has a sentence in both languages, so no failure is mute", () => {
    for (const reason of [
      "denied",
      "noDevice",
      "deviceBusy",
      "sttMissing",
      "requestFailed",
      "unknown",
    ] as const) {
      const entry = dict[voiceErrorKey(reason)];
      expect(entry, `no sentence for ${reason}`).toBeTruthy();
      expect(entry.de.length).toBeGreaterThan(0);
      expect(entry.en.length).toBeGreaterThan(0);
    }
  });
});
