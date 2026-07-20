import { describe, expect, it } from "vitest";
import { formatSize } from "./AttachmentPreview";

// The DOM-bound parts (canvas downscaling, chip rendering) are exercised in the
// browser walkthrough; the pure size label is pinned here — it appears on every
// preview chip and must never show "0 KB" for a non-empty file.

describe("formatSize", () => {
  it("labels kilobyte sizes with a KB suffix, never rounding a real file to 0", () => {
    expect(formatSize(1)).toBe("1 KB");
    expect(formatSize(512)).toBe("1 KB"); // still at least 1 KB
    expect(formatSize(2048)).toBe("2 KB");
    expect(formatSize(870_400)).toBe("850 KB");
  });

  it("switches to one-decimal MB from a mebibyte on", () => {
    expect(formatSize(1024 * 1024)).toBe("1.0 MB");
    expect(formatSize(1_572_864)).toBe("1.5 MB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
