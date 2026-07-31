import type { LangDef } from "./spec";

// PHP's keywords, the alternative-syntax `end*` forms legacy templates are built
// from, and the type names a signature carries.
//
// NO `foldCase`, even though the language itself ignores keyword case. Real PHP
// writes its keywords lower-case, and folding would paint every class named after
// one — Match, List, Enum, Object, String — as syntax. A shouted `IF` losing its
// colour costs a reader nothing because nobody writes it; a class name painted as
// syntax costs them on every line. The exception is `TRUE`, `FALSE` and `NULL`,
// which legacy code shouts constantly, so those three spellings are listed
// outright rather than folding the whole vocabulary to reach them.
//
// LEFT OUT: `$this`. The word scanner takes `$` as an identifier start, so the
// token would be `$this` — but `->` opens with a hyphen and a hyphen is glue, so
// `$this->log` can never colour while `return $this;` would. One token that
// colours on one line and not the next reads as a defect, so it colours on
// neither. `parent` and `self` stay, since neither is followed by an arrow.
const KEYWORDS: ReadonlySet<string> = new Set([
  "abstract",
  "and",
  "array",
  "as",
  "break",
  "callable",
  "case",
  "catch",
  "class",
  "clone",
  "const",
  "continue",
  "declare",
  "default",
  "do",
  "echo",
  "else",
  "elseif",
  "empty",
  "enddeclare",
  "endfor",
  "endforeach",
  "endif",
  "endswitch",
  "endwhile",
  "enum",
  "extends",
  "final",
  "finally",
  "fn",
  "for",
  "foreach",
  "function",
  "global",
  "goto",
  "if",
  "implements",
  "include",
  "include_once",
  "instanceof",
  "insteadof",
  "interface",
  "isset",
  "list",
  "match",
  "namespace",
  "new",
  "or",
  "parent",
  "print",
  "private",
  "protected",
  "public",
  "readonly",
  "require",
  "require_once",
  "return",
  "self",
  "static",
  "switch",
  "throw",
  "trait",
  "try",
  "unset",
  "use",
  "var",
  "while",
  "xor",
  "yield",
  // Literals, in both the spelling PSR asks for and the one legacy code uses.
  "true",
  "false",
  "null",
  "TRUE",
  "FALSE",
  "NULL",
  // Type names. `$string` carries its sigil into the word, so a variable of the
  // same spelling can never collide with the type.
  "bool",
  "float",
  "int",
  "iterable",
  "mixed",
  "never",
  "object",
  "string",
  "void",
]);

export const php: LangDef = {
  aliases: ["php"],
  extensions: ["php"],
  // `#` is a comment opener and `#[` opens an attribute, and the scanner sees one
  // character: an attribute therefore greys out like a comment. Comments are the
  // far commoner spelling of `#`, and the alternative — dropping `#` — sprays
  // keyword colour through the prose of every one of them.
  //
  // Not attempted, and plain rather than wrong as a result: a heredoc, whose
  // delimiter is a label the author invents and which no fixed fence can express;
  // the `<?php` tag, which is not a keyword; and the HTML around it, since the
  // tokenizer has one mode and no second language.
  spec: { line: ["//", "#"], block: ["/*", "*/"], quotes: ['"', "'"], keywords: KEYWORDS },
};
