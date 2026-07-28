// Markdown has no file in this directory, and that is the decision, not an
// omission. This test holds it, so that adding one is a considered act.
//
// Reading the language against the five classes the tokenizer can emit:
//
//   comment  markdown has none. `#` opens a heading — the most prominent line on
//            the page — and comment is the class that says "the renderer skips
//            this". Painting every heading with it inverts its meaning.
//   string   a straight apostrophe is prose (`don't`), not a delimiter, and the
//            scanner would paint from it to the end of the line.
//   keyword  there are no words. The syntax is punctuation: #, *, -, [], ().
//   number   unavoidable, and that is the deciding cost. The number path is
//            unconditional in the engine, so every year, version and list marker
//            in the prose would come out coloured, in a language whose content is
//            prose end to end.
//
// A spec would therefore buy one honest form, the `<!-- -->` comment, at the
// price of speckling ordinary paragraphs. `highlight()` renders an unknown
// language byte for byte untouched, so no registration is the better reading of
// a markdown file — and rendering markdown as markdown, rather than colouring its
// source, is a different job in a different module.

import { describe, expect, it } from "vitest";
import { hlLangForFence, hlLangForPath } from "../highlight";

describe("markdown", () => {
  it("is not a highlighter language, by fence", () => {
    for (const fence of ["markdown", "md", "mdx", "mkd"]) {
      expect(hlLangForFence(fence)).toBeNull();
    }
  });

  it("is not a highlighter language, by extension", () => {
    for (const path of ["README.md", "docs/notes.markdown", "a/b/CHANGELOG.mdx"]) {
      expect(hlLangForPath(path)).toBeNull();
    }
  });
});
