import { describe, it, expect } from "vitest";
import { parseInline, parseMarkdown } from "./parse";
import type { Block, Inline } from "./parse";

/** Flatten an inline run back to plain text (test helper). */
function plain(inlines: Inline[]): string {
  return inlines
    .map((n) => {
      switch (n.kind) {
        case "text":
        case "code":
          return n.text;
        case "br":
          return "\n";
        default:
          return plain(n.children);
      }
    })
    .join("");
}

describe("parseInline", () => {
  it("splits strong, em and del around plain text", () => {
    const run = parseInline("a **b** *c* ~~d~~ e");
    expect(run.map((n) => n.kind)).toEqual(["text", "strong", "text", "em", "text", "del", "text"]);
    expect(plain(run)).toBe("a b c d e");
  });

  it("nests emphasis inside strong", () => {
    const run = parseInline("**a *b* c**");
    expect(run[0].kind).toBe("strong");
    const strong = run[0] as Extract<Inline, { kind: "strong" }>;
    expect(strong.children.map((n) => n.kind)).toEqual(["text", "em", "text"]);
  });

  it("code spans protect markers from parsing", () => {
    const run = parseInline("use `a * b` here");
    expect(run.map((n) => n.kind)).toEqual(["text", "code", "text"]);
    expect((run[1] as Extract<Inline, { kind: "code" }>).text).toBe("a * b");
  });

  it("leaves lone asterisks in math literal", () => {
    expect(parseInline("6*7 und 2 * 3")).toEqual([{ kind: "text", text: "6*7 und 2 * 3" }]);
  });

  it("keeps http/https/mailto links and defuses javascript:", () => {
    const ok = parseInline("[docs](https://example.org)")[0] as Extract<Inline, { kind: "link" }>;
    expect(ok.href).toBe("https://example.org");
    expect(plain(ok.children)).toBe("docs");
    const bad = parseInline("[x](javascript:alert(1))")[0] as Extract<Inline, { kind: "link" }>;
    expect(bad.href).toBeNull();
  });

  it("unclosed markers stay literal (streaming-safe)", () => {
    expect(plain(parseInline("noch **nicht fertig"))).toBe("noch **nicht fertig");
    expect(plain(parseInline("code `offen"))).toBe("code `offen");
  });

  it("backslash escapes the marker characters", () => {
    expect(plain(parseInline("\\*kein em\\*"))).toBe("*kein em*");
  });
});

describe("parseMarkdown blocks", () => {
  it("reads heading levels", () => {
    const blocks = parseMarkdown("# H1\n### H3");
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "heading"]);
    expect((blocks[0] as Extract<Block, { kind: "heading" }>).level).toBe(1);
    expect((blocks[1] as Extract<Block, { kind: "heading" }>).level).toBe(3);
  });

  it("keeps single newlines inside a paragraph as soft breaks", () => {
    const blocks = parseMarkdown("Zeile eins\nZeile zwei\n\nNeuer Absatz");
    expect(blocks.map((b) => b.kind)).toEqual(["para", "para"]);
    const first = (blocks[0] as Extract<Block, { kind: "para" }>).children;
    expect(first.some((n) => n.kind === "br")).toBe(true);
    expect(plain(first)).toBe("Zeile eins\nZeile zwei");
  });

  it("parses a fenced code block with language", () => {
    const blocks = parseMarkdown('```java\nvar x = 1;\n```\ndanach');
    const code = blocks[0] as Extract<Block, { kind: "code" }>;
    expect(code.lang).toBe("java");
    expect(code.text).toBe("var x = 1;");
    expect(code.open).toBe(false);
    expect(blocks[1].kind).toBe("para");
  });

  it("an unclosed fence still becomes a code block (streaming-safe)", () => {
    const code = parseMarkdown("```ts\nconst a = 1;")[0] as Extract<Block, { kind: "code" }>;
    expect(code.open).toBe(true);
    expect(code.text).toBe("const a = 1;");
  });

  it("markers inside a fence stay code", () => {
    const blocks = parseMarkdown("```\n# kein heading\n- kein listitem\n```");
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe("code");
  });

  it("collects unordered lists with one nested level", () => {
    const list = parseMarkdown("- a\n- b\n  - b1\n  - b2\n- c")[0] as Extract<Block, { kind: "list" }>;
    expect(list.ordered).toBe(false);
    expect(list.items.length).toBe(3);
    expect(list.items[1].sub?.items.length).toBe(2);
    expect(plain(list.items[1].sub!.items[0].children)).toBe("b1");
  });

  it("reads ordered lists with their start number", () => {
    const list = parseMarkdown("3. drei\n4. vier")[0] as Extract<Block, { kind: "list" }>;
    expect(list.ordered).toBe(true);
    expect(list.start).toBe(3);
    expect(list.items.length).toBe(2);
  });

  it("appends hanging continuation lines to their item", () => {
    const list = parseMarkdown("- erster Punkt\n  geht weiter\n- zweiter")[0] as Extract<Block, { kind: "list" }>;
    expect(list.items.length).toBe(2);
    expect(plain(list.items[0].children)).toBe("erster Punkt geht weiter");
  });

  it("parses blockquotes recursively", () => {
    const quote = parseMarkdown("> Zitat **fett**\n> zweite Zeile")[0] as Extract<Block, { kind: "quote" }>;
    expect(quote.children[0].kind).toBe("para");
  });

  it("reads a horizontal rule", () => {
    expect(parseMarkdown("oben\n\n---\n\nunten").map((b) => b.kind)).toEqual(["para", "hr", "para"]);
  });

  it("parses a GFM table with alignment", () => {
    const table = parseMarkdown("| Name | Wert |\n|:-----|-----:|\n| a | 1 |\n| b | 2 |")[0] as Extract<Block, { kind: "table" }>;
    expect(table.header.length).toBe(2);
    expect(table.align).toEqual(["left", "right"]);
    expect(table.rows.length).toBe(2);
    expect(plain(table.rows[1][0])).toBe("b");
  });

  it("a table delimiter row is not a horizontal rule", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(blocks.length).toBe(1);
    expect(blocks[0].kind).toBe("table");
  });

  it("plain chat text stays one honest paragraph", () => {
    const blocks = parseMarkdown("Hallo! Alles klar.");
    expect(blocks).toEqual([{ kind: "para", children: [{ kind: "text", text: "Hallo! Alles klar." }] }]);
  });
});
