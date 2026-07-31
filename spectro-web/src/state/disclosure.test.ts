// Disclosure levels (card 78 #4): how message cards open their thinking and
// tool disclosures by default. Three levels — normal (all collapsed, as
// before), extended (thinking + tools open), thinking (only thinking open).
// The store follows the lang.ts pattern; defaultOpen is the pure matrix the
// cards read, with a per-card manual toggle overriding it in the component.

import { beforeEach, describe, expect, it } from "vitest";
import { currentDisclosure, defaultOpen, setDisclosure } from "./disclosure";

describe("disclosure", () => {
  beforeEach(() => {
    setDisclosure("normal");
  });

  it("defaults to normal", () => {
    expect(currentDisclosure()).toBe("normal");
  });

  it("normal keeps everything collapsed", () => {
    expect(defaultOpen("normal", "thinking")).toBe(false);
    expect(defaultOpen("normal", "tool")).toBe(false);
  });

  it("extended opens thinking AND tools", () => {
    expect(defaultOpen("extended", "thinking")).toBe(true);
    expect(defaultOpen("extended", "tool")).toBe(true);
  });

  it("thinking opens only the thinking blocks", () => {
    expect(defaultOpen("thinking", "thinking")).toBe(true);
    expect(defaultOpen("thinking", "tool")).toBe(false);
  });

  it("set + read round-trips", () => {
    setDisclosure("extended");
    expect(currentDisclosure()).toBe("extended");
  });
});
