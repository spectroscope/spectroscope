import type { LangDef } from "./spec";

// Separate from c.ts on purpose. C++ reserves roughly fifty words C does not, and
// C reserves `restrict`, which C++ dropped; one shared set would either paint
// `class` and `template` inside a .c file or leave half of C++ plain. The overlap
// is copied rather than imported: a language file's vocabulary is private to it.
//
// The word operators (`and`, `or`, `not`, `xor`, `compl`, `bitand`, `bitor` and
// the `_eq` forms) are reserved, so nothing can ever be named after them and
// colouring them carries no risk — only the reader who writes `if (not ok)`
// notices they are here at all.
//
// LEFT OUT, all for the same reason: they mean something in one position and are
// ordinary names in every other, and a variable painted as syntax is the worse
// error. `final` (`bool final = …`), `module` and `import` (contextual since
// C++20, and modules are rarer than a variable named `module`), and the `error`,
// `line` and `warning` directives. `class Frame final` therefore colours `class`
// and not `final`, which still reads.
//
// `override` is in: it appears only after a declarator, and almost nothing is
// named `override`.
const KEYWORDS: ReadonlySet<string> = new Set([
  "alignas",
  "alignof",
  "and",
  "and_eq",
  "asm",
  "auto",
  "bitand",
  "bitor",
  "bool",
  "break",
  "case",
  "catch",
  "char",
  "char8_t",
  "char16_t",
  "char32_t",
  "class",
  "compl",
  "concept",
  "const",
  "consteval",
  "constexpr",
  "constinit",
  "const_cast",
  "continue",
  "co_await",
  "co_return",
  "co_yield",
  "decltype",
  "default",
  "delete",
  "do",
  "double",
  "dynamic_cast",
  "else",
  "enum",
  "explicit",
  "export",
  "extern",
  "false",
  "float",
  "for",
  "friend",
  "goto",
  "if",
  "inline",
  "int",
  "long",
  "mutable",
  "namespace",
  "new",
  "noexcept",
  "not",
  "not_eq",
  "nullptr",
  "operator",
  "or",
  "or_eq",
  "override",
  "private",
  "protected",
  "public",
  "register",
  "reinterpret_cast",
  "requires",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "static_assert",
  "static_cast",
  "struct",
  "switch",
  "template",
  "this",
  "thread_local",
  "throw",
  "true",
  "try",
  "typedef",
  "typeid",
  "typename",
  "union",
  "unsigned",
  "using",
  "virtual",
  "void",
  "volatile",
  "wchar_t",
  "while",
  "xor",
  "xor_eq",
  // A macro, not a reserved word, and superseded by `nullptr` — but it is still
  // written in most C++ a reader will open, and no program may define the name to
  // anything else.
  "NULL",
  // Preprocessor directive words, without the `#`. A directive is neither keyword
  // nor comment and there is no third class for it; colouring the word and leaving
  // the hash as punctuation reads correctly, while listing `#` as a line comment
  // would grey live code.
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

export const cpp: LangDef = {
  aliases: ["cpp", "c++", "cxx", "cc"],
  // `h` belongs to C, which is the subset: reading a C++ header as C under-colours,
  // while reading a C header as C++ would paint words C does not have.
  extensions: ["cpp", "cc", "cxx", "hpp", "hh", "hxx"],
  // Two costs of the shared mechanism, both accepted rather than worked around:
  // an access label like `public:` stays plain, because a trailing colon is glue;
  // and a digit separator (`1'000'000`) opens what the scanner reads as a char
  // literal. Dropping `'` from the quotes would trade that for every `'a'` in
  // every file, which is the commoner form by far.
  spec: { line: ["//"], block: ["/*", "*/"], quotes: ['"', "'"], keywords: KEYWORDS },
};
