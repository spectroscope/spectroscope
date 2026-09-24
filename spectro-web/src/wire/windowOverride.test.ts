// Card 390: what the ring's input may send, and the frame it sends.
//
// The server decides (WindowOverrideRequest); this is the mirror that keeps
// the set button off for a draft the server would refuse. The reverted first
// build sent Math.round(Number(draft)), so "0.4" became a clear and "1" was a
// window that compacts on every turn (review 2026-09-24, E6).

import { describe, expect, it } from "vitest";
import { parseWindowDraft, windowOverrideFrame } from "./windowOverride";

describe("parseWindowDraft", () => {
  it("takes whole numbers inside the range, surrounding blanks ignored", () => {
    expect(parseWindowDraft("512000")).toBe(512_000);
    expect(parseWindowDraft(" 512000 ")).toBe(512_000);
    expect(parseWindowDraft("8000")).toBe(8_000);
    expect(parseWindowDraft("10000000")).toBe(10_000_000);
  });

  it("refuses what the server would refuse", () => {
    for (const draft of ["", " ", "0", "1", "7999", "10000001", "-512000", "0.4", "512000.5"]) {
      expect(parseWindowDraft(draft), draft).toBeNull();
    }
  });

  it("refuses anything that is not plain digits", () => {
    // "512.000" is 512 thousand to a German reader and 512 to Number(); a
    // separator is refused rather than guessed.
    for (const draft of ["512k", "5e5", "512,000", "512.000", "512_000", "0x7d000", "Infinity"]) {
      expect(parseWindowDraft(draft), draft).toBeNull();
    }
  });
});

describe("windowOverrideFrame", () => {
  it("a set carries the number", () => {
    expect(windowOverrideFrame(512_000)).toEqual({ type: "set_window_override", tokens: 512_000 });
  });

  it("a clear carries null, never 0", () => {
    expect(windowOverrideFrame(null)).toEqual({ type: "set_window_override", tokens: null });
  });
});
