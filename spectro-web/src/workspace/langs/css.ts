import type { LangDef } from "./spec";

// The css-wide keywords, the two values that are never anything else, and the
// one bang. Case folds because css keywords are ASCII case-insensitive.
//
// This set can only ever colour a VALUE, and most of css is structurally out of
// reach of any set at all:
//
//   at-rules       `@media` cannot light up whatever the vocabulary says — the
//                  `@` in front of the word is glue, so the word reads as a
//                  fragment of a larger name.
//   property names a property is followed by a colon, also glue, so `display`
//                  is unreachable for the same reason a yaml key is.
//   selectors      `.card` and `#root` are glued by their leading punctuation,
//                  and a bare element name is left plain on purpose: a set
//                  holding `a`, `em`, `s` or `small` would light up words in
//                  every other position too.
//   units          `rem` in `1rem` is the tail of a numeric literal. The only
//                  class a word can carry is `keyword`, so colouring it would
//                  file part of a number as syntax; widening the number scan to
//                  swallow the unit would be new mechanism.
//   per-property values (`block`, `flex`, `solid`, `ease`, `to`) — that set is
//                  the whole value grammar, and every entry in it is a word some
//                  author has already used as a class or an animation name.
const KEYWORDS: ReadonlySet<string> = new Set([
  "inherit",
  "initial",
  "unset",
  "revert",
  "auto",
  "none",
  "important",
]);

export const css: LangDef = {
  aliases: ["css", "scss", "sass", "less"],
  extensions: ["css", "scss", "sass", "less"],
  // No line comment, although scss, sass and less all have `//`. An opener takes
  // the rest of its line, and `url(https://…)` carries `//` in ordinary css, so
  // the cost of having it is a swallowed line in every dialect while the cost of
  // leaving it out is one comment style in three of them. The block form is
  // legal in all four.
  spec: { line: [], block: ["/*", "*/"], quotes: ['"', "'"], keywords: KEYWORDS, foldCase: true },
};
