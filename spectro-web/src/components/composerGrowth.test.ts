import { describe, expect, it } from "vitest";
import { composerHeight, showsPlaceholder } from "./composerGrowth";

const MAX = 240;

describe("how tall the composer has to be", () => {
  it("follows the typed text when nothing is being heard", () => {
    expect(composerHeight(42, null, MAX)).toBe(42);
    expect(composerHeight(86, null, MAX)).toBe(86);
  });

  it("follows the GHOST when the live text is the taller of the two", () => {
    // The defect this closes, reported from the running app: the live words
    // wrapped onto a second line and the box stayed one line tall. The
    // textarea's own scrollHeight cannot see them — its value is empty, the
    // words live in the layer behind it — so the box measured nothing and grew
    // by nothing.
    expect(composerHeight(42, 86, MAX)).toBe(86);
  });

  it("follows the typed text when THAT is the taller one", () => {
    // Both layers hold text: the draft someone typed and the words still
    // arriving. Whichever is longer decides, because both have to fit.
    expect(composerHeight(108, 64, MAX)).toBe(108);
  });

  it("stops at the ceiling on both paths", () => {
    // Ten lines, then it scrolls. A live session that runs long must not push
    // the composer through the roof of the window.
    expect(composerHeight(900, null, MAX)).toBe(MAX);
    expect(composerHeight(42, 900, MAX)).toBe(MAX);
  });

  it("ignores a ghost that is not there yet", () => {
    // The layer only mounts while there is something to show, so the ref is
    // null far more often than not.
    expect(composerHeight(42, null, MAX)).toBe(42);
    expect(composerHeight(42, 0, MAX)).toBe(42);
  });
});

describe("when the placeholder is allowed to show", () => {
  it("shows on a genuinely empty composer", () => {
    expect(showsPlaceholder("", "")).toBe(true);
  });

  it("goes away for typed text, as it always did", () => {
    expect(showsPlaceholder("hello", "")).toBe(false);
  });

  it("goes away for text that is being HEARD, which it did not", () => {
    // The second half of the same defect: the placeholder is the browser's, and
    // the browser only knows the textarea's value. Live words are painted
    // behind it, so "Message the agent …" sat on top of the words as they
    // arrived. Empty to the browser is not empty to the reader.
    expect(showsPlaceholder("", "This is live")).toBe(false);
  });

  it("stays away while both are present", () => {
    expect(showsPlaceholder("typed", "and heard")).toBe(false);
  });
});
