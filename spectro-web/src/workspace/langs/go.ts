import type { LangDef } from "./spec";

const KEYWORDS: ReadonlySet<string> = new Set([
  // The 25 reserved words. None of them can be an identifier in Go, so every one
  // is safe to colour wherever it stands alone.
  "break",
  "case",
  "chan",
  "const",
  "continue",
  "default",
  "defer",
  "else",
  "fallthrough",
  "for",
  "func",
  "go",
  "goto",
  "if",
  "import",
  "interface",
  "map",
  "package",
  "range",
  "return",
  "select",
  "struct",
  "switch",
  "type",
  "var",
  // Predeclared, not reserved: Go permits shadowing all of these. Listed where
  // the shadow is a mistake nobody makes — the type names carry every signature
  // in the file, and `make`, `len` and `append` read as syntax in all Go code.
  "any",
  "append",
  "bool",
  "byte",
  "cap",
  "close",
  "complex64",
  "complex128",
  "copy",
  "delete",
  "error",
  "false",
  "float32",
  "float64",
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "iota",
  "len",
  "make",
  "new",
  "nil",
  "panic",
  "recover",
  "rune",
  "string",
  "true",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "uintptr",
  // Left out on purpose: min, max, clear, print, println, complex, real, imag.
  // Each is predeclared AND an everyday local name — `min, max := bounds()` is
  // ordinary Go, `real` and `imag` name parts of things far more often than they
  // deconstruct a complex number, and `print`/`println` lose to fmt in real code.
  // A loop bound painted as syntax reads worse than a builtin left plain.
]);

export const go: LangDef = {
  aliases: ["go", "golang"],
  extensions: ["go"],
  spec: {
    line: ["//"],
    block: ["/*", "*/"],
    // A raw string spans lines, so the backtick belongs with the fences and not
    // with the quotes: the quote scanner stops at the first newline, which would
    // cut a block of struct tags or an embedded query in half.
    triple: ["`"],
    // In Go the apostrophe opens a rune literal and nothing else, which is what
    // makes it safe here and unsafe in Rust. A rune lands in the string class
    // because that is the nearest of the five; there is no character class.
    quotes: ['"', "'"],
    keywords: KEYWORDS,
  },
};
