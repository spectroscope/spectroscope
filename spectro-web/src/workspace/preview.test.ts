import { describe, expect, it } from "vitest";
import { fileUrl, formatBytes, previewKind, previewNoteKey } from "./preview";

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

// Card 351: the tree now lists dot-entries whose bytes the server still
// refuses, so the preview must say WHICH of the two it hit. A refusal reported
// as "could not load the file" is a message about a mechanism the code does
// not have — the same family of lie as a comment claiming a property.
describe("previewNoteKey", () => {
  it("keeps the size and type refusals it already had", () => {
    expect(previewNoteKey(415, "blob.bin")).toBe("ws.binary");
    expect(previewNoteKey(413, "huge.txt")).toBe("ws.tooBig");
  });

  it("names the hidden refusal for a dot segment anywhere in the path", () => {
    expect(previewNoteKey(404, ".env")).toBe("ws.hidden");
    expect(previewNoteKey(404, ".claude/launch.json")).toBe("ws.hidden");
    expect(previewNoteKey(404, "src/.secrets/token.txt")).toBe("ws.hidden");
  });

  it("does not call an ordinary file hidden because its name has a dot in it", () => {
    // The trap a `includes(".")` test would fall into: almost every file has one.
    expect(previewNoteKey(404, "notes.txt")).toBe("ws.loadError");
    expect(previewNoteKey(404, "v1.2/notes")).toBe("ws.loadError");
    expect(previewNoteKey(404, "src/app/Main.java")).toBe("ws.loadError");
  });

  it("only reads a 404 as the hide rule, never a dead fetch", () => {
    // The catch turns a network failure into 0. Calling that "hidden" would
    // explain an unreachable server with a policy that never ran.
    expect(previewNoteKey(0, ".env")).toBe("ws.loadError");
  });
});
