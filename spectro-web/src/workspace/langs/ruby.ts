import type { LangDef } from "./spec";

// `defined` is listed without its question mark: `?` is not an identifier
// character to the scanner, so `defined?` arrives as the word `defined` followed
// by punctuation. The bare word is not otherwise a Ruby name.
const KEYWORDS: ReadonlySet<string> = new Set([
  "BEGIN",
  "END",
  "__ENCODING__",
  "__FILE__",
  "__LINE__",
  "alias",
  "and",
  "begin",
  "break",
  "case",
  "class",
  "def",
  "defined",
  "do",
  "else",
  "elsif",
  "end",
  "ensure",
  "false",
  "for",
  "if",
  "in",
  "module",
  "next",
  "nil",
  "not",
  "or",
  "redo",
  "rescue",
  "retry",
  "return",
  "self",
  "super",
  "then",
  "true",
  "undef",
  "unless",
  "until",
  "when",
  "while",
  "yield",
  // Methods rather than reserved words, but each one stands where a reader
  // expects a declaration: at the top of a file, or at the head of a class body.
  // They are safe in the call position too, because `arr.include?` and
  // `mod.extend` are glued to their dot and never looked up.
  "attr_accessor",
  "attr_reader",
  "attr_writer",
  "extend",
  "include",
  "private",
  "protected",
  "public",
  "raise",
  "require",
  "require_relative",
  // `puts`, `new`, `loop`, `lambda` and `proc` are absent. They are print and
  // construction verbs, not declarations, and a language's own source is read
  // for its shape — the argument that earns shell.ts its verb list is an
  // argument about transcripts, and it does not carry over to a class body.
]);

export const ruby: LangDef = {
  // Gemfile and Rakefile carry no extension, so only the fence names reach them.
  aliases: ["ruby", "rb", "gemfile", "rakefile"],
  extensions: ["rb", "rake", "gemspec", "ru"],
  spec: {
    line: ["#"],
    // Ruby reads =begin as a comment opener only where it owns its line, and the
    // constraint is load-bearing rather than pedantic: this pair is the one whose
    // mistakes are not bounded by a newline. Recognised mid-line, the assignment
    // `t=begin_time` opens a run that ends at the next =end or at the end of the
    // FILE. The same rule holds the closer, matching Ruby, which wants the bare
    // word and nothing glued to it.
    block: ["=begin", "=end"],
    blockOwnsLine: true,
    // Symbols stay plain. `:foo` has no closing delimiter, and the only string
    // mechanism here runs from an opener to a matching closer, so colouring one
    // would mean entering `:` as a quote — which paints the value half of every
    // hash literal and every ternary. What matters is already handled: `isGlue`
    // stops `:end` and `status:` from reading as keywords.
    //
    // Heredocs, %w/%q literals, regex literals and backtick command literals get
    // no delimiter rule of their own, which means their bodies are read as code
    // rather than left alone: an apostrophe in heredoc prose opens a string that
    // ends at the newline. That is the ordinary unterminated-quote behaviour and it
    // stops at the line, unlike the =begin pair above.
    quotes: ['"', "'"],
    keywords: KEYWORDS,
  },
};
