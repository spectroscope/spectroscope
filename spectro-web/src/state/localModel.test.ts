import { describe, it, expect } from "vitest";
import { progressPct, formatGB, LOCAL_MODEL_SIZE } from "./localModel";

describe("progressPct", () => {
  it("is 0 before anything and 100 at the end", () => {
    expect(progressPct(0, 100)).toBe(0);
    expect(progressPct(100, 100)).toBe(100);
  });
  it("rounds mid-download and clamps overshoot", () => {
    expect(progressPct(33, 100)).toBe(33);
    expect(progressPct(150, 100)).toBe(100);
  });
  it("is 0 when the total is unknown", () => {
    expect(progressPct(50, 0)).toBe(0);
  });
});

describe("formatGB", () => {
  it("renders the pinned model size as ~1.9 GB", () => {
    expect(formatGB(LOCAL_MODEL_SIZE)).toBe("1.9 GB");
  });
});
