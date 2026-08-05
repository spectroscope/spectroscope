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

  it("asks the session's workspace when there is a session", () => {
    expect(fileUrl("notes.md", "20260804-101500")).toBe("/api/file?path=notes.md&session=20260804-101500");
  });

  it("asks the first run's folder when there is no session yet", () => {
    // The prospective tree lists files; a preview that cannot open them would
    // be half an answer. Same root, named by the server, never by the caller.
    expect(fileUrl("notes.md", undefined, true)).toBe("/api/file?path=notes.md&scope=prospective");
    // A session outranks it: once a run has resolved a folder, that is the one.
    expect(fileUrl("notes.md", "20260804-101500", true)).toBe(
      "/api/file?path=notes.md&session=20260804-101500",
    );
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
