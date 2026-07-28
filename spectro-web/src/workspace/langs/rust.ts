import type { LangDef } from "./spec";

const KEYWORDS: ReadonlySet<string> = new Set([
  // The strict keywords. `Self` is listed beside `self` because the lookup does
  // not fold case here, and the two mean different things.
  "Self",
  "as",
  "async",
  "await",
  "break",
  "const",
  "continue",
  "crate",
  "dyn",
  "else",
  "enum",
  "extern",
  "false",
  "fn",
  "for",
  "if",
  "impl",
  "in",
  "let",
  "loop",
  "match",
  "mod",
  "move",
  "mut",
  "pub",
  "ref",
  "return",
  "self",
  "static",
  "struct",
  "super",
  "trait",
  "true",
  "type",
  "unsafe",
  "use",
  "where",
  "while",
  // Reserved for future use. Rust forbids them as identifiers today, so they are
  // free of the usual risk: a word that cannot name anything cannot be miscoloured.
  "abstract",
  "become",
  "box",
  "do",
  "final",
  "macro",
  "override",
  "priv",
  "try",
  "typeof",
  "unsized",
  "virtual",
  "yield",
  // A weak keyword, but never an identifier in practice.
  "macro_rules",
  // `union` and `gen` are absent. Both are weak or edition-scoped, and both are
  // plausible names in ordinary code: `let union = a.union(b)` for the set
  // operation, `gen` for a generation counter in anything written before the 2024
  // edition reserved it. Primitive and prelude names (u32, str, String, Option,
  // Some, Ok) are absent too: they are library and type names rather than syntax,
  // and the file already reads once fn/let/pub/impl/match carry colour.
]);

export const rust: LangDef = {
  aliases: ["rust", "rs"],
  extensions: ["rs"],
  spec: {
    line: ["//"],
    // Rust nests block comments and this tokenizer does not: a run ends at the
    // first `*/`. A nested comment therefore ends early and its tail reads as
    // code with a stray `*/` in it. That is the failure worth having; the other
    // direction swallows working code into a comment.
    block: ["/*", "*/"],
    // The apostrophe is deliberately not a string delimiter. Rust spends it on
    // lifetimes, and a signature like `fn f<'a>(x: &'a str) -> &'a str` carries
    // several on one line, so a scanner that opened a string at the first would
    // close it at the second and paint the signature.
    quotes: ['"'],
    // Which leaves the char literal, and it cannot simply stay plain: `'"'` holds
    // the OTHER delimiter, so without a rule of its own the quote inside it opens a
    // string that runs to the newline, and `match c { '"' => …` loses its arm. A
    // literal is one code point or one escape and then closes, a lifetime never
    // closes, and that difference is decidable without a parser. A label reads as a
    // lifetime and stays plain, which is right: `'a: loop` is not a literal. The `b`
    // of a byte literal is left outside the colour, as the `r` of a raw string is.
    charQuotes: ["'"],
    // No fence is declared. `r#"…"#` closes with a different string than it opens
    // with, which a symmetric fence cannot express, and the only symmetric
    // candidate — a bare `"` — would let one unterminated quote swallow the rest
    // of the file. So `r"…"` colours from its quote with the `r` left plain, and
    // the body of an `r#"…"#` ends at its first inner quote. Both stop at the
    // newline, which also bounds a plain literal written across lines.
    keywords: KEYWORDS,
  },
};
