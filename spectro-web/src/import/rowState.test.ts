import { describe, it, expect } from "vitest";
import { rowState, formatBytes, listingNotice } from "./rowState";
import type { TranscriptRow, StoreLimits } from "./rowState";

// The owner's own file, as the listing described it on 2026-08-03. It sat in the
// dialog looking exactly like every loadable row, and answered the click with a
// bare status code.
const OWNERS_FILE: TranscriptRow = {
  path: "-Users-x-TheStory/5a5691fa.jsonl",
  project: "-Users-x-TheStory",
  file: "5a5691fa-525c-4e51-9152-1510915632e4.jsonl",
  size: 77_214_510,
  modifiedAt: 1_754_224_800_000,
  loadable: false,
};

const SMALL: TranscriptRow = { ...OWNERS_FILE, file: "s.jsonl", size: 42_000, loadable: true };

const LIMITS: StoreLimits = { limitBytes: 128 * 1024 * 1024 };

describe("rowState", () => {
  it("aRowAboveTheCeilingIsDisabledBeforeItIsClicked", () => {
    expect(rowState(OWNERS_FILE, LIMITS, "en").enabled).toBe(false);
    expect(rowState(SMALL, LIMITS, "en").enabled).toBe(true);
  });

  it("theReasonNamesTheFileSizeAndTheCeilingInBothLanguages", () => {
    const en = rowState(OWNERS_FILE, LIMITS, "en");
    const de = rowState(OWNERS_FILE, LIMITS, "de");
    if (en.enabled || de.enabled) throw new Error("expected a refusal in both languages");

    // Both numbers, because "too large" alone does not tell anyone how far over
    // the line the file is, or whether deleting a little would help.
    for (const state of [en, de]) {
      expect(state.reason).toContain("73.6 MB");
      expect(state.reason).toContain("128.0 MB");
    }
    expect(en.reason).not.toEqual(de.reason);
    expect(en.reason.trim()).not.toEqual("");
    expect(de.reason.trim()).not.toEqual("");
  });

  it("noRowIsEverPartial", () => {
    // Card 116 removed the 5000-row import truncation because a trace is
    // evidence and a transcript that silently begins in the middle has lost the
    // part saying how the incident started. Announcing the truncation would not
    // hand the beginning back. So an enabled row loads WHOLE, over every band.
    const sizes = [0, 1, 1024, 32 * 1024 * 1024, 128 * 1024 * 1024, 512 * 1024 * 1024];
    for (const size of sizes) {
      for (const loadable of [true, false]) {
        const state = rowState({ ...SMALL, size, loadable }, LIMITS, "en");
        expect(state.kind).not.toBe("partial");
        expect(state.kind).not.toBe("windowed");
        if (state.enabled) expect(state.kind).toBe("whole");
      }
    }
  });

  it("theCeilingComesFromTheServerAndNeverFromAConstantHere", () => {
    // A client that re-derives size <= cap is how a > drifts into a >= and the
    // dialog starts offering the one file the server refuses. With no served
    // limit, nothing here invents a number to refuse on.
    const huge: TranscriptRow = { ...SMALL, size: 900 * 1024 * 1024, loadable: undefined };
    expect(rowState(huge, null, "en").enabled).toBe(true);
    expect(rowState(huge, LIMITS, "en").enabled).toBe(true);

    // And the server's verdict is obeyed even when the size looks harmless,
    // because only the server knows what it will actually serve.
    const tinyButRefused: TranscriptRow = { ...SMALL, size: 10, loadable: false };
    expect(rowState(tinyButRefused, LIMITS, "en").enabled).toBe(false);
  });

  it("theRefusalStillReadsWhenTheServerDidNotPublishALimit", () => {
    const state = rowState(OWNERS_FILE, null, "de");
    if (state.enabled) throw new Error("expected a refusal");
    expect(state.reason).toContain("73.6 MB");
    expect(state.reason.trim()).not.toEqual("");
  });

  it("aCappedListingIsAnnouncedInBothLanguages", () => {
    // The listing keeps the 300 newest and drops the rest. Counted on this
    // machine on 2026-08-03 that hid 553 files, 36 of them ordinary session
    // transcripts far under the byte ceiling, and the dialog said nothing: the
    // wanted transcript was simply absent. The sibling Files tree already ships
    // the honest pattern, a truncated flag rendered as a notice.
    const capped: StoreLimits = { limitBytes: 128 * 1024 * 1024, truncated: true };
    const en = listingNotice(capped, 300, "en");
    const de = listingNotice(capped, 300, "de");
    expect(en).not.toBeNull();
    expect(de).not.toBeNull();
    expect(en).not.toBe(de);
    expect(en).toContain("300");
    expect(de).toContain("300");
  });

  it("anUncappedListingSaysNothing", () => {
    expect(listingNotice({ limitBytes: 1, truncated: false }, 12, "en")).toBeNull();
    // A server too old to say does not get a guess put in its mouth.
    expect(listingNotice({ limitBytes: 1 }, 12, "en")).toBeNull();
    expect(listingNotice(null, 12, "en")).toBeNull();
  });

  it("sizesReadTheSameWayTheRowAlreadyPrintsThem", () => {
    expect(formatBytes(77_214_510)).toBe("73.6 MB");
    expect(formatBytes(128 * 1024 * 1024)).toBe("128.0 MB");
    expect(formatBytes(42_000)).toBe("41 kB");
    expect(formatBytes(0)).toBe("1 kB");
  });
});
