import { describe, expect, it } from "vitest";
import { fileUrl, formatBytes, previewKind } from "./preview";

describe("previewKind", () => {
  it("routes files to their renderer by extension", () => {
    expect(previewKind("index.html")).toBe("html");
    expect(previewKind("docs/page.HTM".toLowerCase())).toBe("html");
    expect(previewKind("art/logo.svg")).toBe("image");
    expect(previewKind("shot.PNG".toLowerCase())).toBe("image");
    expect(previewKind("README.md")).toBe("markdown");
    expect(previewKind("src/Main.java")).toBe("text");
    expect(previewKind("Makefile")).toBe("text"); // no extension
  });

  it("only looks at the basename, not dots in directories", () => {
    expect(previewKind("v1.2/notes")).toBe("text");
  });
});

describe("fileUrl", () => {
  it("URL-encodes the workspace path", () => {
    expect(fileUrl("src/app data/x y.txt")).toBe("/api/file?path=src%2Fapp%20data%2Fx%20y.txt");
  });
});

describe("formatBytes", () => {
  it("picks a compact unit", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(2048)).toBe("2 kB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
