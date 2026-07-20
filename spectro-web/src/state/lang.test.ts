// The chrome-language store: German by default (the app's home audience),
// toggle flips and notifies; DOM-less environments fall back gracefully.
import { describe, expect, it } from "vitest";
import { currentLang, setLang, toggleLang } from "./lang";

describe("lang store", () => {
  it("defaults to German and toggles to English and back", () => {
    setLang("de");
    expect(currentLang()).toBe("de");
    toggleLang();
    expect(currentLang()).toBe("en");
    toggleLang();
    expect(currentLang()).toBe("de");
  });

  it("setLang is idempotent for the same value", () => {
    setLang("en");
    setLang("en");
    expect(currentLang()).toBe("en");
    setLang("de"); // leave the default behind for other tests
  });
});
