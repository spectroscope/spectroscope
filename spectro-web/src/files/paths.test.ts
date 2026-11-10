// Card 604: path folding for the files tab. Every touch is compared by its
// resolved key, so these three cases pin the key.

import { describe, expect, it } from "vitest";
import { resolvePath } from "./paths";

describe("resolvePath", () => {
  it("resolvesRelativeOntoTheBase", () => {
    expect(resolvePath("src/../a.ts", "/w")).toBe("/w/a.ts");
    expect(resolvePath("./out/", "/w")).toBe("/w/out");
    expect(resolvePath(".", "/w")).toBe("/w");
  });

  it("keepsAbsolute", () => {
    expect(resolvePath("/x/a", "/w")).toBe("/x/a");
    expect(resolvePath("~/notes.md", "/w")).toBe("~/notes.md");
  });

  it("passesThroughWithoutBase", () => {
    expect(resolvePath("a", null)).toBe("a");
    expect(resolvePath("src/../a.ts", null)).toBe("src/../a.ts");
  });

  it("keeps a relative base relative", () => {
    expect(resolvePath("f", "web")).toBe("web/f");
    expect(resolvePath("..", "web")).toBe(".");
    expect(resolvePath("../g", "web/..")).toBe("../g");
  });
});
