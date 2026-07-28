import { describe, expect, it, vi } from "vitest";
import { tokenize, type Token } from "../highlight";
import { swift } from "./swift";

// `tokenize` reaches a vocabulary only through the registry, keyed by id, so the
// definition under test is bound there for this module. The substitution is
// scoped to this file: it proves the language reads without depending on where
// the registry happens to list it.
vi.mock("./registry", async () => ({ LANGS: { swift: (await import("./swift")).swift } }));

// Ordinary Swift: a struct, a multiline literal, a doc comment, a throwing method
// and a guard.
const SRC = `import Foundation

/// A run's transcript, read from disk exactly once.
struct Transcript {
    static let banner = """
        spectroscope
        """

    let path: URL
    private var lines: [String] = []

    mutating func load() throws {
        let raw = try String(contentsOf: path, encoding: .utf8)
        lines = raw.split(separator: "\\n").map(String.init)
        guard lines.count > 0 else {
            throw TranscriptError.empty     /* nothing was written */
        }
    }
}
`;

const toks = (src: string): Token[] => tokenize(src, "swift" as never);
const classOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

describe("swift", () => {
  it("declares the names a reader will type", () => {
    expect(swift.aliases).toContain("swift");
    expect(swift.extensions).toContain("swift");
  });

  it("colours declarations, statements and expression keywords", () => {
    expect(keywords(SRC)).toEqual(
      expect.arrayContaining([
        "import",
        "struct",
        "static",
        "let",
        "private",
        "var",
        "mutating",
        "func",
        "throws",
        "try",
        "guard",
        "else",
        "throw",
      ]),
    );
  });

  it("colours a string, a number and both comment forms", () => {
    expect(classOf(SRC, '"\\n"')).toBe("string");
    expect(classOf(SRC, "0")).toBe("number");
    expect(toks(SRC).find((t) => t.text.startsWith("///"))?.cls).toBe("comment");
    expect(toks(SRC).find((t) => t.text.startsWith("/*"))?.cls).toBe("comment");
  });

  it("carries a multiline literal across its line breaks", () => {
    const raw = toks(SRC).find((t) => t.cls === "string" && t.text.startsWith('"""'));
    expect(raw?.text).toContain("spectroscope");
    expect(raw?.text.endsWith('"""')).toBe(true);
  });

  it("keeps interpolation inside the string", () => {
    // `\\(` reads as an escape, so the scanner runs on to the closing quote and the
    // whole literal is one string. There is no nesting in the tokenizer.
    const src = 'let s = "total \\(n) rows"\nlet m = 1\n';
    expect(classOf(src, '"total \\(n) rows"')).toBe("string");
    expect(keywords(src)).toEqual(["let", "let"]);
  });

  it("colours some, which SwiftUI writes on every view", () => {
    expect(keywords("var body: some View { Text(title) }\n")).toEqual(
      expect.arrayContaining(["var", "some"]),
    );
  });

  it("leaves the context-sensitive words that are usually names alone", () => {
    // `package` is the access level nobody writes and the variable every
    // Package.swift declares. `prefix`, `none` and `get` are the same trade: a
    // modifier in one position, an ordinary name in the code people actually read.
    //
    // Read off the keyword list, not by finding the word: adjacent plain runs are
    // merged into one token, so an uncoloured identifier never stands alone.
    const src = `let package = Package(name: "spectro")
let prefix = "run-"
let none = 0
func get() -> Int { 0 }
`;
    const kw = keywords(src);
    for (const word of ["package", "prefix", "none", "get"]) expect(kw).not.toContain(word);
    expect(kw).toEqual(expect.arrayContaining(["let", "func"]));
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SRC,
      "/* outer /* inner */ still open */\nlet after = 1\n",
      'let t = """never closed\nlet after = 2\n',
      'let c: Character = "a"  // don\'t split on the apostrophe\n',
      "#if DEBUG\nlet d = true\n#endif\n",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
