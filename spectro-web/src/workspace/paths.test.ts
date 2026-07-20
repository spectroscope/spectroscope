import { describe, expect, it } from "vitest";
import { workspaceBasename } from "./paths";

describe("workspaceBasename", () => {
  it("derives the chip label from the last path segment", () => {
    expect(workspaceBasename("/Users/me/SpectroDemo")).toBe("SpectroDemo");
    expect(workspaceBasename("/Users/me/SpectroDemo/")).toBe("SpectroDemo");
    expect(workspaceBasename("solo")).toBe("solo");
  });
});
