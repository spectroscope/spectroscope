import { afterAll, describe, expect, it } from "vitest";
import { tokenize, type Token } from "../highlight";
import { css } from "./css";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";

// See yaml.test.ts for why the spec is registered here: the registry line is a
// separate wiring pass, and the assertions are worth nothing unless they run
// through the real tokenizer.
const REGISTRY = LANGS as Record<string, LangDef>;
const ALREADY_WIRED = "css" in REGISTRY;
REGISTRY.css = css;
afterAll(() => {
  if (!ALREADY_WIRED) delete REGISTRY.css;
});

const scan = (src: string): Token[] => tokenize(src, "css" as never);
const classOf = (src: string, needle: string): string | undefined =>
  scan(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  scan(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

// One rule block off the app's own stylesheets, plus the two shapes that decide
// the keyword question: an at-rule and a custom property.
const SHEET = `/* the workspace preview borrows the app's token surface */
.ws-preview {
  display: none;
  margin: 0 auto;
  padding: 0.5rem 1rem;
  font-family: "JetBrains Mono", monospace;
  color: var(--fg-dim);
  border: 1px solid var(--rule);
  transition: opacity 0.18s ease-in-out;
}

.ws-preview[data-open="true"] {
  display: block !important;
}

@media (prefers-color-scheme: dark) {
  .ws-preview { color: var(--fg); }
}
`;

describe("css", () => {
  it("colours the keywords that mean the same thing in every property", () => {
    expect(keywords(SHEET)).toEqual(expect.arrayContaining(["none", "auto", "important"]));
  });

  it("folds case, because css keywords are case-insensitive", () => {
    expect(classOf("a { margin: AUTO; }", "AUTO")).toBe("keyword");
  });

  it("colours both quote styles and the block comment", () => {
    expect(classOf(SHEET, '"JetBrains Mono"')).toBe("string");
    expect(classOf("a::after { content: 'x'; }", "'x'")).toBe("string");
    expect(scan(SHEET)[0]?.cls).toBe("comment");
  });

  it("colours the numeric part of a length", () => {
    expect(classOf(SHEET, "0.5")).toBe("number");
    expect(classOf(SHEET, "1")).toBe("number");
  });

  it("leaves an at-rule name plain", () => {
    // `@media` cannot light up whatever the vocabulary says: the `@` in front of
    // the word is glue, and the tokenizer therefore reads `media` as a fragment.
    expect(keywords("@media print { a { color: auto; } }")).toEqual(["auto"]);
  });

  it("leaves a unit plain", () => {
    // A unit is the tail of a numeric literal, not a keyword. The only class a
    // word can carry here is `keyword`, so colouring `rem` would file a number
    // as syntax; widening the number scan instead would be new machinery.
    const found = keywords(SHEET);
    for (const unit of ["rem", "px", "s"]) expect(found).not.toContain(unit);
  });

  it("leaves property-specific values and the author's own names plain", () => {
    // `block` and `solid` mean something in exactly one property each; a set that
    // held them would have to hold every value in the language, and every entry
    // is a word some author has already used as a class or an animation name.
    const found = keywords(SHEET);
    for (const word of ["block", "solid", "monospace", "var", "display", "dark", "ws"]) {
      expect(found).not.toContain(word);
    }
  });

  it("leaves a selector that is spelled like a keyword plain", () => {
    // A class named `.auto` or `.none` is glued by its leading dot, which is what
    // makes a set holding such everyday words survivable in the first place.
    expect(keywords(".auto, .none, .auto-fit { margin: auto; }")).toEqual(["auto"]);
  });

  it("leaves the // that scss allows plain, so a url survives", () => {
    // The dialects on this spec (scss, sass, less) do have line comments, but a
    // `//` opener would eat the rest of any line carrying an absolute url. The
    // block form is legal in all four, so the loss is one comment style.
    const src = "a { background: url(https://x.test/y.png); }";
    expect(scan(src).some((t) => t.cls === "comment")).toBe(false);
    expect(
      scan(src)
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });

  it("rejoins losslessly", () => {
    for (const src of [SHEET, "a { /* never closed\n", "b { content: '\\''; }"]) {
      expect(
        scan(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
