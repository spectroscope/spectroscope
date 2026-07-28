import type { LangDef } from "./spec";

// C and C++ are two files, not one. `restrict` is C only, `class` and `template`
// are C++ only, and one shared set would either paint `class` in a .c file or
// leave half of C++ plain. The overlap is copied rather than shared: nothing
// outside a language file may read its vocabulary.
//
// The `_Uppercase` spellings are in because the whole `_[A-Z]` name space is
// reserved to the implementation, so they can never be somebody's identifier.
//
// Library type names (`size_t`, `FILE`, `bool` before C23) are typedefs, not
// reserved words, and the list of them has no end. They stay plain.
const KEYWORDS: ReadonlySet<string> = new Set([
  "auto",
  "break",
  "case",
  "char",
  "const",
  "continue",
  "default",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "register",
  "restrict",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while",
  "_Alignas",
  "_Alignof",
  "_Atomic",
  "_Bool",
  "_Complex",
  "_Generic",
  "_Imaginary",
  "_Noreturn",
  "_Static_assert",
  "_Thread_local",
  // C23 spellings of the same ideas, plus the literals stdbool.h has meant since
  // C99 — a .c file writes `true` and `bool` whichever standard it targets.
  "alignas",
  "alignof",
  "bool",
  "constexpr",
  "false",
  "nullptr",
  "static_assert",
  "thread_local",
  "true",
  "typeof",
  // A macro, not a reserved word. It is in because it is the null literal every C
  // file writes, and because a program that includes a standard header may not
  // define the name to anything else.
  "NULL",
  // Preprocessor directive words, without the `#`. A directive is neither keyword
  // nor comment, and the tokenizer has no third class for it; colouring the word
  // and leaving the hash as punctuation reads correctly, while listing `#` as a
  // line comment would grey `#define MAX 10` — live code, shown as inert.
  //
  // `error`, `line` and `warning` are directives too and are deliberately absent:
  // all three are ordinary variable names in C, and a variable painted as syntax
  // is worse than a directive left plain.
  "include",
  "define",
  "undef",
  "ifdef",
  "ifndef",
  "endif",
  "elif",
  "pragma",
  "defined",
]);

export const c: LangDef = {
  aliases: ["c"],
  // `h` is C, not C++. A header shared by both is the common case, and the C set
  // is the subset — reading a C++ header as C under-colours, the other way round
  // paints C code with words C does not have.
  extensions: ["c", "h"],
  // A label swallows its own colour: `default:` is followed by a colon, and a
  // trailing colon is glue, so it stays plain while `case 1:` colours. The rule
  // that keeps `in` out of uft.in.ua costs this, and it is the cheaper trade.
  spec: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"], keywords: KEYWORDS },
};
