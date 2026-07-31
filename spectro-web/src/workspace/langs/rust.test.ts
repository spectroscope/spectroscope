import { describe, expect, it } from "vitest";
import { tokenize, type HlLang, type Token } from "../highlight";
import { LANGS } from "./registry";
import { rust } from "./rust";
import type { LangDef } from "./spec";

// `tokenize` reaches its vocabulary through the registry and nothing else exposes
// a spec, so a spec is only reachable as a registered entry. Vitest gives each
// test file its own module graph, so this claim cannot reach another suite, and it
// is a no-op once the registry holds the same object under the same key.
const RS = "rust" as HlLang;
(LANGS as Record<string, LangDef>)[RS] = rust;

const toks = (src: string): Token[] => tokenize(src, RS);
const kw = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
const clsOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;

// Ordinary code, not a keyword salad: an inner doc comment, an outer one, an
// attribute, a lifetime on the struct and on every borrow, a match with a guard
// and a raw string.
const SAMPLE = `//! Lane bookkeeping for the fleet hub.
use std::collections::HashMap;

/// One lane of a run, borrowed from the session that owns it.
#[derive(Debug, Clone)]
pub struct Lane<'a> {
    pub id: &'a str,
    frames: Vec<u64>,
    tags: HashMap<&'a str, u32>,
}

impl<'a> Lane<'a> {
    pub fn new(id: &'a str) -> Self {
        Self { id, frames: Vec::with_capacity(64), tags: HashMap::new() }
    }

    pub fn label(&self) -> String {
        match self.frames.len() {
            0 => "idle".to_string(),
            n if n < 1_000 => format!("{n} frames"),
            _ => r"lots\\of frames".to_string(),
        }
    }
}
`;

describe("rust", () => {
  it("colours the keywords a rust file is built from", () => {
    expect(kw(SAMPLE)).toEqual(
      expect.arrayContaining(["use", "pub", "struct", "impl", "fn", "Self", "match", "if"]),
    );
  });

  it("colours the reserved-for-future words, which cannot be identifiers", () => {
    expect(kw("let b = box 1;\nlet t = try {};\nmacro_rules! m {}\n")).toEqual(
      expect.arrayContaining(["let", "box", "try", "macro_rules"]),
    );
  });

  it("colours both doc comment forms, the strings and the numbers", () => {
    expect(toks(SAMPLE)[0]?.cls).toBe("comment");
    expect(toks(SAMPLE)[0]?.text).toBe("//! Lane bookkeeping for the fleet hub.");
    expect(toks(SAMPLE).some((t) => t.cls === "comment" && t.text.startsWith("///"))).toBe(true);
    expect(clsOf(SAMPLE, '"idle"')).toBe("string");
    expect(clsOf(SAMPLE, '"{n} frames"')).toBe("string");
    expect(clsOf(SAMPLE, '"lots\\of frames"')).toBe("string");
    expect(clsOf(SAMPLE, "0")).toBe("number");
    expect(clsOf(SAMPLE, "64")).toBe("number");
    expect(clsOf(SAMPLE, "1_000")).toBe("number");
  });

  it("never mistakes a lifetime for a char literal", () => {
    // The hazard the spec is shaped around: an apostrophe read as a string
    // opener turns `<'a>(x: &'a str)` into one long string and the signature
    // stops being readable.
    const src = "fn f<'a>(x: &'a str) -> &'a str { x }";
    expect(toks(src).filter((t) => t.cls === "string")).toEqual([]);
    expect(kw(src)).toEqual(["fn"]);
    expect(
      toks(src)
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });

  it("keeps a lifetime out of the string class in a whole file too", () => {
    expect(toks(SAMPLE).some((t) => t.cls === "string" && t.text.includes("'a"))).toBe(false);
  });

  it("closes a char literal at the literal, whatever character is inside it", () => {
    // The apostrophe is kept out of `quotes` to protect lifetimes, which leaves a
    // char literal holding a double quote with nothing to bound it: unless the
    // literal is read as one, the inner `"` opens a string and paints the line.
    const src = "let q = '\"'; let n = '\\n'; let a = 'a';";
    expect(
      toks(src)
        .filter((t) => t.cls === "string")
        .map((t) => t.text),
    ).toEqual(["'\"'", "'\\n'", "'a'"]);
    expect(kw(src)).toEqual(["let", "let", "let"]);
  });

  it("reads a match arm on the quote character as code", () => {
    const src = "'\"' => self.pos += 1,";
    expect(
      toks(src)
        .filter((t) => t.cls === "string")
        .map((t) => t.text),
    ).toEqual(["'\"'"]);
    expect(clsOf(src, "1")).toBe("number");
  });

  it("carries every escape form, and the byte literal, no wider than the literal", () => {
    const src = "let e = ['\\'', '\\\\', '\\n', '\\u{1F600}', '\\x41'];\nlet b = b'x';\n";
    expect(
      toks(src)
        .filter((t) => t.cls === "string")
        .map((t) => t.text),
    ).toEqual(["'\\''", "'\\\\'", "'\\n'", "'\\u{1F600}'", "'\\x41'", "'x'"]);
    expect(kw(src)).toEqual(["let", "let"]);
  });

  it("leaves two apostrophes in a where clause plain rather than pairing them", () => {
    // The guard against fixing one over-colour with another: a bound list carries
    // apostrophes a few characters apart, and a scan for the next one would paint
    // the gap. A literal closes after one character or one escape or not at all.
    const src = "fn f<T, U>() where T: 'a, U: 'b { }";
    expect(toks(src).filter((t) => t.cls === "string")).toEqual([]);
    expect(kw(src)).toEqual(["fn", "where"]);
  });

  it("leaves a loop label plain, including the one-letter label", () => {
    const src = "'outer: loop { break 'outer; }\n'a: while x { break 'a; }\n";
    expect(toks(src).filter((t) => t.cls === "string")).toEqual([]);
  });

  it("ends a nested block comment at the first close, leaving code as code", () => {
    // Rust nests block comments; this tokenizer does not. The run ends early, so
    // the tail reads as code with a stray `*/` in it — never the other way round.
    const src = "/* outer /* inner */ let x = 1;";
    expect(toks(src).find((t) => t.cls === "comment")?.text).toBe("/* outer /* inner */");
    expect(clsOf(src, "let")).toBe("keyword");
    expect(clsOf(src, "1")).toBe("number");
  });

  it("does not colour a keyword reached through a path or a dot", () => {
    // `&self` in a signature is syntax and `self.frames` is a field access; the
    // glue rule is what separates them, and it costs the receiver its colour.
    expect(kw("self.frames.len()\n")).toEqual([]);
    expect(kw("crate::model::Lane;\n")).toEqual([]);
    // `union` is absent from the set on purpose: the set operation is the common
    // reading, and the keyword beside it still colours.
    expect(kw("let s = a.union(&b);\n")).toEqual(["let"]);
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SAMPLE,
      'let s = "never closed\nlet t = 2;\n',
      "/* unterminated block\nlet x = 1;\n",
      'let p = r#"a "quoted" b"#;\n',
      "let c = '\\n';\nlet d = b'x';\n",
      "let n = 42u32 + 0xFFu8 + 1.5f64;\n",
      "// tail comment without a newline",
      "let q = '\"'; let n = '\\n'; let a = 'a';",
      "'\"' => self.pos += 1,",
      "let unclosed = 'a\nlet after = 1;\n",
      "let e = '",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
