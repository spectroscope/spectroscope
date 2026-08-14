// Which image backend the composer's dropdown pre-selects — and the twin of
// the server's own rule.
//
// Card 222, review finding F5. The owner's smart default (2026-07-20) used to
// live only here, as an effect that fired on connect and TOLD THE SESSION its
// answer over the websocket, with the same message a human dropdown pick sends.
// The reviewer hooked WebSocket.prototype.send, bounced the server so the open
// page reconnected, with OPENAI_API_KEY set and no GEMINI_API_KEY:
//
//   sentByTheCLIENT_withNoHumanAction:
//       ["{\"type\":\"set_image_provider\",\"provider\":\"openai\"}"]
//
// From that frame the session counted the field as touched, and the settings
// page's image-backend dropdown was dead for the rest of it — under a sentence
// promising "applies immediately, including to a session already open".
//
// So the rule is a function now, on both sides of the socket: this module for
// what the composer SHOWS, ImageProviders.withAKey for what generate_image
// USES. The table below is the twin of the one in
// spectro-core/src/test/java/dev/spectroscope/core/image/ImageProvidersTest.java
// — same rows, same order. Two answers to one question is the disagreement the
// whole card is about.

import { describe, expect, it } from "vitest";
import { backendWithAKey } from "./imageBackend";

/** named, gemini key, openai key, expected — the twin of the Java @CsvSource. */
const VECTORS: [string, boolean, boolean, string][] = [
  ["gemini", true, true, "gemini"],
  ["gemini", true, false, "gemini"],
  ["gemini", false, true, "openai"],
  ["gemini", false, false, "gemini"],
  ["openai", true, true, "openai"],
  ["openai", false, true, "openai"],
  ["openai", true, false, "gemini"],
  ["openai", false, false, "openai"],
];

describe("the backend the composer pre-selects", () => {
  for (const [named, gemini, openai, expected] of VECTORS) {
    it(`${named} + gemini=${gemini} openai=${openai} -> ${expected}`, () => {
      expect(backendWithAKey(named, { gemini, openai })).toBe(expected);
    });
  }

  it("has the same number of rows as its Java twin", () => {
    // A row added on one side only is the drift this table exists to stop.
    expect(VECTORS).toHaveLength(8);
  });

  it("leaves the value alone while key presence is unknown", () => {
    // /api/config has not answered yet, or an older server never reports key
    // presence. Claiming "no key" against a server that never said so would
    // move the dropdown off what the settings actually resolve to.
    expect(backendWithAKey("gemini", null)).toBe("gemini");
  });

  it("hands an unknown backend back untouched", () => {
    expect(backendWithAKey("dalle", { gemini: false, openai: true })).toBe("dalle");
  });
});
