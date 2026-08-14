// The kit's own pin (finding 19, review 2026-08-14): ten test files carried a
// byte-identical read() and eight carried the same comment-blanker before this
// module existed. The risk of a hand-copy here is not style — a blanker whose
// regex drifts greedy silently blanks the CODE between two comments, and every
// guard built on it goes soft without a single test turning red. So the kit's
// semantics are pinned in their own right, once.

import { describe, expect, it } from "vitest";
import { blankBlockComments, read, stripComments } from "./source";

describe("read", () => {
  it("resolves relative to the URL the caller hands over", () => {
    const self = read("./source.test.ts", import.meta.url);
    expect(self).toContain("finding 19, review 2026-08-14");
  });
});

describe("blankBlockComments", () => {
  it("blanks a block comment to spaces, byte for byte", () => {
    expect(blankBlockComments("a/* x */b")).toBe("a       b");
  });

  it("keeps every newline so offsets and line numbers still line up", () => {
    const src = "a\n/* one\n two */\nb";
    const out = blankBlockComments(src);
    expect(out.length).toBe(src.length);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("one");
  });

  it("is lazy: the code between two comments survives", () => {
    // A greedy regex would blank from the first /* to the LAST */ — taking the
    // declaration in the middle with it, and weakening every guard downstream.
    const out = blankBlockComments("/* a */ display: none; /* b */");
    expect(out).toContain("display: none;");
  });
});

describe("stripComments", () => {
  it("also drops line comments to the end of the line, keeping the newline", () => {
    const src = "keep(); // prose about a deleted class\nalso();";
    const out = stripComments(src);
    expect(out).toContain("keep();");
    expect(out).toContain("also();");
    expect(out).not.toContain("deleted class");
    expect(out.split("\n").length).toBe(src.split("\n").length);
  });
});
