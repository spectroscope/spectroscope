import { describe, expect, it } from "vitest";
import { labViewDefault } from "./labViewDefault";

describe("labViewDefault (card 287)", () => {
  it("the user's stored choice always wins", () => {
    expect(labViewDefault("compact", true)).toBe(false);
    expect(labViewDefault("expanded", false)).toBe(true);
  });

  it("nothing stored: replay and import open expanded, live opens compact", () => {
    expect(labViewDefault(null, true)).toBe(true);
    expect(labViewDefault(null, false)).toBe(false);
  });

  it("an unknown stored value falls back to the replay rule", () => {
    expect(labViewDefault("garbled", true)).toBe(true);
    expect(labViewDefault("garbled", false)).toBe(false);
  });
});
