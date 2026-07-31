import type { LangDef } from "./spec";

// toml has two words, and they are lower-case only. `True` is a parse error, so
// case is NOT folded here as it is for yaml: colouring `True` as a boolean would
// tell the reader their file loads. There is no null in the language at all — an
// absent key is the absence — so nothing stands in for json's third literal.
//
// `inf` and `nan` are literals too and are left out. They are floats, and the
// number scan only starts on a digit, so the one class a word can carry here is
// `keyword` — which would file a number as syntax.
const KEYWORDS: ReadonlySet<string> = new Set(["true", "false"]);

export const toml: LangDef = {
  aliases: ["toml"],
  extensions: ["toml"],
  // Both multi-line forms, basic and literal. They are tried ahead of the
  // single-quote scan, which is what makes a multi-line value one token rather
  // than a run of lines that each look unterminated.
  //
  // Bare keys and table headers stay plain. A bare key is not followed by a
  // colon, so unlike a yaml key it does reach the lookup — it stays plain
  // because it holds the author's own words, which no vocabulary may claim.
  // An offset date-time comes out as its digit groups around plain dashes and
  // colons; reading it as one value would take a date grammar in the number
  // scan, and the classes cannot say "date" anyway.
  spec: { line: ["#"], triple: ['"""', "'''"], quotes: ['"', "'"], keywords: KEYWORDS },
};
