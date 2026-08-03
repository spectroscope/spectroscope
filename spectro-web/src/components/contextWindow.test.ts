import { describe, it, expect } from "vitest";
import { contextWindowFor, formatWindow } from "./contextWindow";

describe("contextWindowFor", () => {
  it("claude opus/sonnet flagships are 1M; haiku + legacy 3.x are 200k", () => {
    expect(contextWindowFor("claude-opus-4-8")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowFor("claude-3-5-sonnet")).toBe(200_000); // older naming → legacy 200k
  });
  it("claude-fable-5 gets the same window as the other Claude 5 flagships", () => {
    // The ring showed 379% on an imported session because this name fell
    // through to the legacy 200k row: it starts with "claude" but with
    // neither "claude-opus" nor "claude-sonnet". Same session, same load,
    // green or red depending only on which model spoke last.
    expect(contextWindowFor("claude-fable-5")).toBe(contextWindowFor("claude-opus-5"));
    expect(contextWindowFor("claude-fable-5")).toBe(1_000_000);
    expect(contextWindowFor("claude-mythos-5")).toBe(1_000_000);
  });
  it("gpt-4o is 128k; gpt-4.1 and gpt-5.x are ~1M", () => {
    expect(contextWindowFor("gpt-4o")).toBe(128_000);
    expect(contextWindowFor("gpt-4o-mini")).toBe(128_000);
    expect(contextWindowFor("gpt-4.1")).toBe(1_000_000);
    expect(contextWindowFor("gpt-5.6-luna")).toBe(1_000_000);
  });
  it("gemini 1.5 pro is 2M; other gemini 1M", () => {
    expect(contextWindowFor("gemini-1.5-pro")).toBe(2_000_000);
    expect(contextWindowFor("gemini-2.5-flash")).toBe(1_000_000);
  });
  it("returns null for local/unknown models (no fabrication)", () => {
    expect(contextWindowFor("local-model")).toBeNull();
    expect(contextWindowFor("qwen3")).toBeNull();
    expect(contextWindowFor("llama4")).toBeNull();
  });
});

describe("formatWindow", () => {
  it("formats k and M cleanly", () => {
    expect(formatWindow(128_000)).toBe("128k");
    expect(formatWindow(200_000)).toBe("200k");
    expect(formatWindow(1_000_000)).toBe("1M");
    expect(formatWindow(2_000_000)).toBe("2M");
  });
});
