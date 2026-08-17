// Card 249: the source reading's two pure folds. tokenLines splits the
// tokenizer's stream into lines without losing a byte (the highlight
// invariant, carried over the line breaks); foldRegions finds indentation
// blocks a reader may collapse — language-blind on purpose, the same rule
// for python, ts and yaml.

import { describe, expect, it } from "vitest";
import { foldRegions, tokenLines, visibleLineNumbers } from "./sourceCode";
import { tokenize } from "./highlight";

const PY = [
  "def greet(name):", //        0
  "    if name:", //            1
  "        print(name)", //     2
  "        return True", //     3
  "    return False", //        4
  "", //                        5
  "VALUE = 1", //               6
].join("\n");

describe("foldRegions — indentation blocks", () => {
  it("finds nested regions with their exact spans", () => {
    expect(foldRegions(PY.split("\n"))).toEqual([
      { start: 0, end: 4 },
      { start: 1, end: 3 },
    ]);
  });

  it("a flat text folds nothing", () => {
    expect(foldRegions(["a", "b", "c"])).toEqual([]);
  });

  it("a block hiding a single line is not worth a caret", () => {
    expect(foldRegions(["head:", "  only-child", "flat"])).toEqual([]);
  });

  it("blank lines inside a block belong to it", () => {
    const lines = ["def f():", "    a = 1", "", "    b = 2", "done"];
    expect(foldRegions(lines)).toEqual([{ start: 0, end: 3 }]);
  });
});

describe("visibleLineNumbers — what a fold hides", () => {
  const lines = PY.split("\n");
  const regions = foldRegions(lines);

  it("shows everything with nothing folded", () => {
    expect(visibleLineNumbers(lines.length, new Set(), regions)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("a folded region keeps its head and hides its body", () => {
    expect(visibleLineNumbers(lines.length, new Set([1]), regions)).toEqual([0, 1, 4, 5, 6]);
  });

  it("folding the outer region swallows the inner one", () => {
    expect(visibleLineNumbers(lines.length, new Set([0, 1]), regions)).toEqual([0, 5, 6]);
  });
});

describe("tokenLines — the highlight stream, split at line breaks", () => {
  it("reproduces every line byte for byte, classes kept", () => {
    const src = 'const a = "x";\n// two\nlet b = 2;';
    const lines = tokenLines(tokenize(src, "javascript"));
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual(src.split("\n"));
    expect(lines[1].some((t) => t.cls === "comment")).toBe(true);
  });

  it("a token spanning lines is cut at the break, class on both halves", () => {
    const src = "/* one\ntwo */";
    const lines = tokenLines(tokenize(src, "javascript"));
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual(["/* one", "two */"]);
    expect(lines[0][0].cls).toBe("comment");
    expect(lines[1][0].cls).toBe("comment");
  });
});
