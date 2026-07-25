// The structured tool view (card 94): each tool call is described as the SHAPE
// it really is — a file read, an edit, a listing, a command — so the card can
// render it as itself instead of as two JSON blobs. Pure, DOM-free.

import { describe, expect, it } from "vitest";
import { describeTool } from "./toolViews";

describe("describeTool — files", () => {
  it("read_file becomes a file view with its path and body", () => {
    const v = describeTool("read_file", { path: "src/App.tsx" }, "line one\nline two", false);
    expect(v.kind).toBe("file");
    if (v.kind !== "file") throw new Error("kind");
    expect(v.path).toBe("src/App.tsx");
    expect(v.body).toBe("line one\nline two");
    expect(v.lineCount).toBe(2);
  });

  it("read_file with offset/limit names the range", () => {
    const v = describeTool("read_file", { path: "a.txt", offset: 10, limit: 5 }, "x", false);
    if (v.kind !== "file") throw new Error("kind");
    expect(v.range).toBe("lines 10–14");
  });

  it("write_file becomes a write view carrying the written content", () => {
    const v = describeTool(
      "write_file",
      { path: "pi.py", content: "import math\nprint(math.pi)" },
      "Wrote: pi.py (26 bytes)",
      false,
    );
    expect(v.kind).toBe("write");
    if (v.kind !== "write") throw new Error("kind");
    expect(v.path).toBe("pi.py");
    expect(v.content).toContain("import math");
    expect(v.result).toBe("Wrote: pi.py (26 bytes)");
  });

  it("edit_file becomes a two-sided edit view", () => {
    const v = describeTool(
      "edit_file",
      { path: "a.ts", old_string: "const a = 1;", new_string: "const a = 2;" },
      "Edited a.ts",
      false,
    );
    expect(v.kind).toBe("edit");
    if (v.kind !== "edit") throw new Error("kind");
    expect(v.before).toBe("const a = 1;");
    expect(v.after).toBe("const a = 2;");
  });
});

describe("describeTool — listings and searches", () => {
  it("list_dir splits its output into entries", () => {
    const v = describeTool("list_dir", { path: "." }, "a.py\nb.py\nsub/", false);
    expect(v.kind).toBe("listing");
    if (v.kind !== "listing") throw new Error("kind");
    expect(v.entries).toEqual(["a.py", "b.py", "sub/"]);
    expect(v.path).toBe(".");
  });

  it("grep keeps its pattern and match lines", () => {
    const v = describeTool("grep", { pattern: "TODO", path: "src" }, "src/a.ts:3:// TODO\n", false);
    expect(v.kind).toBe("matches");
    if (v.kind !== "matches") throw new Error("kind");
    expect(v.pattern).toBe("TODO");
    expect(v.lines).toEqual(["src/a.ts:3:// TODO"]);
  });

  it("glob is a match view too", () => {
    const v = describeTool("glob", { pattern: "**/*.py" }, "a.py\nb.py", false);
    expect(v.kind).toBe("matches");
  });
});

describe("describeTool — commands", () => {
  it("run_command becomes a terminal view", () => {
    const v = describeTool("run_command", { command: "ls -la" }, "total 8\n.\n..", false);
    expect(v.kind).toBe("command");
    if (v.kind !== "command") throw new Error("kind");
    expect(v.command).toBe("ls -la");
    expect(v.output).toContain("total 8");
    expect(v.failed).toBe(false);
  });

  it("an errored command is flagged, not hidden", () => {
    const v = describeTool("run_command", { command: "false" }, "ERROR: exit 1", true);
    if (v.kind !== "command") throw new Error("kind");
    expect(v.failed).toBe(true);
  });
});

describe("describeTool — the honest fallbacks", () => {
  it("an unknown tool falls back to generic, never guesses", () => {
    const v = describeTool("mcp__notes__search", { q: "x" }, "hit", false);
    expect(v.kind).toBe("generic");
  });

  it("a known tool with an unexpected input shape falls back to generic", () => {
    // The model can send anything; a missing path must not render an empty card.
    const v = describeTool("read_file", { wrong: true }, "out", false);
    expect(v.kind).toBe("generic");
  });

  it("a pending call (no output yet) still describes its call side", () => {
    const v = describeTool("read_file", { path: "a.txt" }, undefined, false);
    if (v.kind !== "file") throw new Error("kind");
    expect(v.path).toBe("a.txt");
    expect(v.body).toBe("");
  });
});
