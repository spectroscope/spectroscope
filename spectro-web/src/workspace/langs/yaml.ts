import type { LangDef } from "./spec";

// The words yaml resolves to a boolean or to null, and nothing else. Case folds
// because the same value is written `true`, `True` and `TRUE` in the wild.
//
// This set can only ever colour a VALUE. A key is followed by a colon, and
// isGlue rejects a colon, so `on:` at the head of a workflow file stays plain
// while `on` after a colon lights up. That asymmetry is what makes words this
// common safe to carry at all.
//
// Keys therefore stay plain deliberately, and not only for lack of reach: the
// five classes have no key among them, and `keyword` on a key would say that the
// reader's own field names are yaml syntax.
//
// `y` and `n` are booleans in yaml 1.1 as well, and are left out: one letter is
// an item, an axis or an initial far more often than it is a boolean.
//
// The accepted cost is prose. An unquoted scalar reading `no longer used` lights
// its first word, because nothing here knows where a plain scalar ends.
const KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null", "yes", "no", "on", "off"]);

export const yaml: LangDef = {
  aliases: ["yaml", "yml"],
  extensions: ["yaml", "yml"],
  // No `triple`. A block scalar opens on punctuation (`|`, `>`) and closes on
  // indentation, so there is no delimiter for the fence mechanism to find and it
  // would run to the end of the file; block bodies read as plain lines instead.
  spec: { line: ["#"], quotes: ['"', "'"], keywords: KEYWORDS, foldCase: true },
};
