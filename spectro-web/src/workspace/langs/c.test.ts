import { describe, expect, it, vi } from "vitest";
import { tokenize, type Token } from "../highlight";
import { c } from "./c";

// `tokenize` reaches a vocabulary only through the registry, keyed by id, so the
// definition under test is bound there for this module. The substitution is
// scoped to this file: it proves the language reads without depending on where
// the registry happens to list it.
vi.mock("./registry", async () => ({ LANGS: { c: (await import("./c")).c } }));

// Ten lines of ordinary C: two directive forms, both comment forms, a variable
// called `line` and one called `error` — the words a directive vocabulary is
// tempted to claim.
const SRC = `#include <stdio.h>
#include "buffer.h"

/* Grow the buffer so that n more bytes fit. */
static int buffer_reserve(struct buffer *b, size_t n)
{
    if (b->len + n <= b->cap)
        return 0;
    size_t cap = b->cap ? b->cap * 2 : 16;
    while (cap < b->len + n)
        cap *= 2;
    char *line = realloc(b->data, cap);
    int error = line == NULL ? -1 : 0;  // caller keeps the old block
    if (error)
        return error;
    b->data = line;
    b->cap = cap;
    return 0;
}
`;

const toks = (src: string): Token[] => tokenize(src, "c" as never);
const classOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

describe("c", () => {
  it("declares the names a reader will type", () => {
    expect(c.aliases).toContain("c");
    expect(c.extensions).toEqual(expect.arrayContaining(["c", "h"]));
  });

  it("colours declarations and control flow", () => {
    expect(keywords(SRC)).toEqual(
      expect.arrayContaining(["static", "int", "struct", "if", "return", "while", "char"]),
    );
  });

  it("colours the header path as a string", () => {
    expect(classOf(SRC, '"buffer.h"')).toBe("string");
  });

  it("colours both comment forms", () => {
    expect(toks(SRC).find((t) => t.text.startsWith("/*"))?.cls).toBe("comment");
    expect(toks(SRC).find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("colours numbers", () => {
    expect(classOf(SRC, "16")).toBe("number");
  });

  it("reads a preprocessor directive as code, not as a comment", () => {
    // `#` opens no comment in C. Listing it as one would grey `#define MAX 10`,
    // telling the reader a live definition is inert.
    expect(keywords(SRC)).toContain("include");
    expect(toks(SRC).some((t) => t.cls === "comment" && t.text.includes("include"))).toBe(false);
  });

  it("colours NULL, which is the null literal every C file writes", () => {
    expect(classOf(SRC, "NULL")).toBe("keyword");
  });

  it("leaves the variables that share a directive's spelling alone", () => {
    // `error` and `line` are `#error` and `#line` without the hash, and both are
    // among the most common variable names in C. The directives lose.
    //
    // Read off the keyword list, not by finding the word: adjacent plain runs are
    // merged into one token, so an uncoloured identifier never stands alone.
    const kw = keywords(SRC);
    expect(kw).not.toContain("error");
    expect(kw).not.toContain("line");
    expect(toks(SRC).some((t) => t.cls === "plain" && t.text.includes("error"))).toBe(true);
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SRC,
      "#define MAX 10\n",
      "char q = '\\0';\nint x = 0xFF;\n",
      "/* never closed\nint after = 1;",
      'const char *s = "oops\nint n = 1;',
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
