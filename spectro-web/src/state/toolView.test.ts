// Pins for the tool-card view mode (card 94).

import { beforeEach, describe, expect, it } from "vitest";
import { TOOL_VIEW_MODES, currentToolView, setToolView } from "./toolView";

describe("toolView", () => {
  beforeEach(() => {
    setToolView("structured");
  });

  it("defaults to structured — the tool rendered as itself", () => {
    expect(currentToolView()).toBe("structured");
  });

  it("offers exactly the three faces, structured first", () => {
    expect(TOOL_VIEW_MODES).toEqual(["structured", "json", "raw"]);
  });

  it("set + read round-trips", () => {
    setToolView("raw");
    expect(currentToolView()).toBe("raw");
    setToolView("json");
    expect(currentToolView()).toBe("json");
  });
});
