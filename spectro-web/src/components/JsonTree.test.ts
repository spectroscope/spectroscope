// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The JSX is covered by the TypeScript build; what can drift is the one
// judgement the string leaf rests on — when a value may be shown as the text it
// is, and when it must stay in its JSON encoding to be readable at all.
//
// The trap this file exists to guard: session payloads are full of shell and
// source text that CONTAINS a backslash and an n as two typed characters.
// Turning those into line breaks would rewrite the payload.

import { describe, expect, it } from "vitest";
import { describeStringLeaf } from "./JsonTree";

/** A real captured script: 14 lines, and line 11 types its own escapes. */
const SCRIPT = [
  "#!/bin/bash",
  "set -euo pipefail",
  "",
  "count=0",
  'for f in "$@"; do',
  '  if [ -f "$f" ]; then',
  "    count=$((count + 1))",
  "  fi",
  "done",
  "",
  String.raw`printf "found: %d\nlisted above\n" "$count"`,
  'if [ "$count" -eq 0 ]; then',
  '  echo "nothing to do" >&2',
  "fi",
].join("\n");

describe("describeStringLeaf — single-line values are untouched", () => {
  it("keeps a plain value in its JSON encoding, quotes and all", () => {
    expect(describeStringLeaf("/tmp/spectro/hello.txt")).toEqual({
      kind: "inline",
      text: '"/tmp/spectro/hello.txt"',
    });
  });

  it("keeps the escaped quotes of a one-line value", () => {
    expect(describeStringLeaf('say "hi"')).toEqual({ kind: "inline", text: '"say \\"hi\\""' });
  });

  it("keeps an empty value as a pair of quotes", () => {
    expect(describeStringLeaf("")).toEqual({ kind: "inline", text: '""' });
  });
});

describe("describeStringLeaf — a typed backslash-n is not a line break", () => {
  it("leaves a one-line value that types its own escape alone", () => {
    const leaf = describeStringLeaf(String.raw`printf "a\nb"`);
    expect(leaf.kind).toBe("inline");
    // The payload's own backslash stays escaped, and nothing became a break.
    expect(leaf.text).toContain(String.raw`\\n`);
    expect(leaf.text).not.toContain("\n");
  });

  it("does not split a typed escape that sits inside a multi-line value", () => {
    const leaf = describeStringLeaf(SCRIPT);
    const lines = leaf.text.split("\n");
    expect(lines).toHaveLength(14);
    expect(lines[10]).toBe(String.raw`printf "found: %d\nlisted above\n" "$count"`);
  });
});

describe("describeStringLeaf — a multi-line value keeps its lines", () => {
  it("hands the script over verbatim, re-escaping nothing", () => {
    expect(describeStringLeaf(SCRIPT)).toEqual({ kind: "block", text: SCRIPT });
  });

  it("allows a tab, which renders as a tab", () => {
    expect(describeStringLeaf("if x:\n\treturn 1")).toEqual({ kind: "block", text: "if x:\n\treturn 1" });
  });

  it("counts a trailing newline as a line", () => {
    expect(describeStringLeaf("done\n").kind).toBe("block");
  });
});

describe("describeStringLeaf — values that only an encoding can show", () => {
  it("stays inline when a control character would render as nothing", () => {
    const leaf = describeStringLeaf("a\nb\u0000c");
    expect(leaf.kind).toBe("inline");
    expect(leaf.text).toContain("\\u0000");
  });

  it("stays inline for carriage returns, which overwrite rather than break", () => {
    // Captured command output uses a bare CR to redraw a progress line; showing
    // it as a break would invent lines the terminal never had.
    expect(describeStringLeaf("12%\r45%\r100%\ndone").kind).toBe("inline");
    expect(describeStringLeaf("a\r\nb").kind).toBe("inline");
  });
});
