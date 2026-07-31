import { describe, expect, it } from "vitest";
import { tokenize, type HlLang, type Token } from "../highlight";
import { go } from "./go";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";

// `tokenize` reaches its vocabulary through the registry and nothing else exposes
// a spec, so a spec is only reachable as a registered entry. Vitest gives each
// test file its own module graph, so this claim cannot reach another suite, and it
// is a no-op once the registry holds the same object under the same key.
const GO = "go" as HlLang;
(LANGS as Record<string, LangDef>)[GO] = go;

const toks = (src: string): Token[] => tokenize(src, GO);
const kw = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
const clsOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;

// Ordinary code, not a keyword salad: a package clause, a grouped import, a
// struct with backtick tags, a rune comparison and two locals named after
// builtins this spec deliberately leaves out.
const SAMPLE = `// Package fleet mirrors lane frames to the hub.
package fleet

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Node is one addressable lane in a fleet.
type Node struct {
	ID    string \`json:"id"\`
	Depth int    \`json:"depth"\`
}

func (n *Node) Validate() error {
	if n.ID == "" {
		return fmt.Errorf("node %q has no id", n.ID)
	}
	min, max := 1, len(n.ID)
	for i := min; i < max; i++ {
		if n.ID[i] == '/' {
			return errors.New("slash in node id")
		}
	}
	buf := make([]byte, 0, 512)
	return json.Unmarshal(buf, n)
}
`;

describe("go", () => {
  it("colours the keywords a go file is built from", () => {
    expect(kw(SAMPLE)).toEqual(
      expect.arrayContaining(["package", "import", "type", "struct", "func", "if", "return", "for"]),
    );
  });

  it("colours the predeclared identifiers that carry the signatures", () => {
    expect(clsOf(SAMPLE, "string")).toBe("keyword");
    expect(clsOf(SAMPLE, "int")).toBe("keyword");
    expect(clsOf(SAMPLE, "error")).toBe("keyword");
    expect(clsOf(SAMPLE, "len")).toBe("keyword");
    expect(clsOf(SAMPLE, "make")).toBe("keyword");
    expect(clsOf(SAMPLE, "byte")).toBe("keyword");
  });

  it("colours interpreted strings, raw strings, runes and the comment", () => {
    expect(clsOf(SAMPLE, '"encoding/json"')).toBe("string");
    expect(clsOf(SAMPLE, '`json:"id"`')).toBe("string");
    expect(clsOf(SAMPLE, "'/'")).toBe("string");
    expect(toks(SAMPLE)[0]?.cls).toBe("comment");
    expect(toks(SAMPLE)[0]?.text).toBe("// Package fleet mirrors lane frames to the hub.");
  });

  it("colours the numbers", () => {
    expect(clsOf(SAMPLE, "512")).toBe("number");
    expect(clsOf(SAMPLE, "0")).toBe("number");
    expect(clsOf(SAMPLE, "1")).toBe("number");
  });

  it("leaves the builtins that are ordinary variable names alone", () => {
    // `min` and `max` are predeclared functions and also the two most common
    // local names in Go; a loop bound painted as syntax is the worse reading.
    expect(kw(SAMPLE)).not.toContain("min");
    expect(kw(SAMPLE)).not.toContain("max");
    // The builtin beside them still carries colour, so this is not a spec that
    // simply gave up on the predeclared set.
    expect(kw("min, max := 1, len(xs)\n")).toEqual(["len"]);
    expect(kw("clear, real, print := split(s)\n")).toEqual([]);
  });

  it("keeps a raw string whole across its line breaks", () => {
    const src = "const q = `SELECT *\nFROM runs`\nconst after = 1\n";
    expect(toks(src).find((t) => t.cls === "string")?.text).toBe("`SELECT *\nFROM runs`");
    // The declaration after the closing backtick is code again.
    expect(clsOf(src, "1")).toBe("number");
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SAMPLE,
      "s := `never closed\nx := 2\n",
      'r := \'\\n\'\nq := "a\\"b"\n',
      "/* block */ var x = 0x1F\n",
      'u := "https://example.test/a//b"\n',
      "// tail comment without a newline",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
