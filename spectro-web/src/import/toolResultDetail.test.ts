// The tool's own return value, read (card 167, finding 5).
import { describe, expect, it } from "vitest";
import { readToolResultDetail } from "./toolResultDetail";

describe("toolUseResult (absent-first)", () => {
  it("says nothing about a record that does not carry the field", () => {
    expect(readToolResultDetail(undefined)).toBe(null);
  });

  it("says nothing about the string form, which is the block's own error text", () => {
    // 3,105 of them, and 3,100 sit on a block already flagged is_error. Every
    // one duplicates the block byte for byte.
    expect(readToolResultDetail("Error: File has not been read yet.")).toBe(null);
  });

  it("says nothing about the array form, which the block already carries", () => {
    expect(readToolResultDetail([{ type: "text", text: "done" }])).toBe(null);
  });

  it("says nothing about an object whose fields are all ones we do not read", () => {
    // interrupted/isImage are constants across 16,506 Bash results; an object
    // of nothing but those has nothing a card could show.
    expect(readToolResultDetail({ interrupted: false, isImage: false })).toBe(null);
  });

  it("reads a file body, which is the same read WITHOUT the gutter", () => {
    const d = readToolResultDetail({
      type: "text",
      file: {
        filePath: "/tmp/a.md",
        content: "# Heading\n\n- one\n",
        numLines: 3,
        startLine: 1,
        totalLines: 3,
      },
    });
    expect(d?.fileContent).toBe("# Heading\n\n- one\n");
    expect(d?.numLines).toBe(3);
    expect(d?.startLine).toBe(1);
    expect(d?.totalLines).toBe(3);
  });

  it("reads the page a partial read returned", () => {
    const d = readToolResultDetail({
      file: { content: "x", numLines: 272, startLine: 1, totalLines: 611, truncatedByTokenCap: true },
    });
    expect(d?.numLines).toBe(272);
    expect(d?.totalLines).toBe(611);
    expect(d?.truncated).toBe(true);
  });

  it("leaves the truncation flag off when the read was not truncated", () => {
    const d = readToolResultDetail({ file: { content: "x", truncatedByTokenCap: false } });
    expect(d?.truncated).toBe(undefined);
  });

  it("keeps the two Bash streams apart", () => {
    const d = readToolResultDetail({ stdout: " 66M\tapp.asar\n", stderr: "\nShell cwd was reset\n" });
    expect(d?.stdout).toBe(" 66M\tapp.asar\n");
    expect(d?.stderr).toBe("\nShell cwd was reset\n");
  });

  it("carries no stderr when the command wrote none", () => {
    const d = readToolResultDetail({ stdout: "ok\n", stderr: "" });
    expect(d?.stdout).toBe("ok\n");
    expect("stderr" in (d ?? {})).toBe(false);
  });

  it("carries an empty stdout, because a command that printed nothing is a fact", () => {
    // 584 Bash calls print nothing and the block substitutes a sentence for it.
    // "" and absent are different answers and the reader gets the file's.
    const d = readToolResultDetail({ stdout: "", stderr: "boom\n" });
    expect(d?.stdout).toBe("");
    expect(d?.stderr).toBe("boom\n");
  });

  it("reads the state an update came FROM, which the call itself never names", () => {
    const d = readToolResultDetail({
      success: true,
      taskId: "1",
      updatedFields: ["status"],
      statusChange: { from: "pending", to: "in_progress" },
    });
    expect(d?.statusFrom).toBe("pending");
    expect(d?.statusTo).toBe("in_progress");
  });

  it("refuses half a status change, because an arrow needs both ends", () => {
    expect(readToolResultDetail({ statusChange: { to: "done" } })).toBe(null);
  });

  it("reads where an edit landed, and only that", () => {
    // The lines themselves are the before/after the edit view already has; what
    // the block never says is WHERE, and that is the four numbers.
    const d = readToolResultDetail({
      structuredPatch: [
        { oldStart: 51, oldLines: 20, newStart: 51, newLines: 21, lines: [" a", "-b", "+c"] },
        { oldStart: 120, oldLines: 3, newStart: 121, newLines: 3, lines: ["-x", "+y"] },
      ],
    });
    expect(d?.patch).toEqual([
      { oldStart: 51, oldLines: 20, newStart: 51, newLines: 21 },
      { oldStart: 120, oldLines: 3, newStart: 121, newLines: 3 },
    ]);
  });

  it("drops a hunk whose numbers are not numbers rather than half-reading the patch", () => {
    expect(readToolResultDetail({ structuredPatch: [{ oldStart: "51" }] })).toBe(null);
  });
});
