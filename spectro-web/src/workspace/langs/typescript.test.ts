import { describe, expect, it } from "vitest";
import { tokenize, type HlLang, type Token } from "../highlight";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";
import { typescript } from "./typescript";

// `tokenize` reaches its vocabulary through the registry and nothing else exposes
// a spec, so a spec is only reachable as a registered entry. Vitest gives each
// test file its own module graph, so this claim cannot reach another suite, and it
// is a no-op once the registry holds the same object under the same key.
const TS = "typescript" as HlLang;
(LANGS as Record<string, LangDef>)[TS] = typescript;

const toks = (src: string): Token[] => tokenize(src, TS);
const kw = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
const clsOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;

// Ordinary code, not a keyword salad: an exported module with a type alias, a
// conditional type, a block comment, a line comment and a float.
const SAMPLE = `import type { RunEvent } from "./events";

export interface Reading {
  readonly label: string;
  nanometres: number;
  kind: "line" | "band";
}

type Lens<T> = T extends Reading ? keyof T : never;

/* Widen every band by a factor. The label is carried through untouched. */
export function widen(rows: readonly Reading[], scale = 1.5): Reading[] {
  const out: Reading[] = [];
  for (const row of rows) {
    // A band narrower than a nanometre reads as a line, so clamp it.
    out.push({ ...row, nanometres: Math.max(1, row.nanometres * scale) });
  }
  return out;
}
`;

describe("typescript", () => {
  it("claims the fence names and extensions that a .ts reader types", () => {
    expect(typescript.aliases).toEqual(expect.arrayContaining(["ts", "tsx", "typescript"]));
    expect(typescript.extensions).toEqual(expect.arrayContaining(["ts", "tsx"]));
  });

  it("colours the type-level words that the javascript spec leaves grey", () => {
    const words = kw(SAMPLE);
    expect(words).toEqual(
      expect.arrayContaining(["interface", "readonly", "type", "keyof", "never", "extends"]),
    );
    // A .ts file is still JavaScript, so the JS words have to survive the move.
    expect(words).toEqual(expect.arrayContaining(["import", "export", "function", "const", "for", "return"]));
  });

  it("colours the primitive type names in an annotation", () => {
    expect(clsOf("let label: string;", "string")).toBe("keyword");
    expect(clsOf("let n: number = 0;", "number")).toBe("keyword");
    expect(clsOf("let ok: boolean;", "boolean")).toBe("keyword");
    expect(clsOf("let u: unknown;", "unknown")).toBe("keyword");
    expect(clsOf("function f(): never {}", "never")).toBe("keyword");
    expect(clsOf("let a: any;", "any")).toBe("keyword");
  });

  it("colours the 5.0 vocabulary", () => {
    expect(kw("const c = { a: 1 } satisfies Rec;")).toContain("satisfies");
    expect(kw("declare namespace N {}")).toEqual(expect.arrayContaining(["declare", "namespace"]));
    expect(kw("type E<T> = T extends Array<infer U> ? U : never;")).toContain("infer");
    expect(kw("function isLine(x: unknown): x is Line {}")).toContain("is");
    expect(kw("function assertLine(x: unknown): asserts x is Line {}")).toContain("asserts");
    expect(kw("abstract class A implements B { protected override readonly n = 1; }")).toEqual(
      expect.arrayContaining(["abstract", "implements", "protected", "override", "readonly"]),
    );
    expect(kw("enum Kind { Line, Band }")).toContain("enum");
  });

  it("reads a string, a comment and a number out of the sample", () => {
    expect(clsOf(SAMPLE, '"./events"')).toBe("string");
    expect(clsOf(SAMPLE, "1.5")).toBe("number");
    expect(toks(SAMPLE).find((t) => t.text.startsWith("/*"))?.cls).toBe("comment");
    expect(toks(SAMPLE).find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("carries a template literal across its line breaks", () => {
    const src = "const q = `first ${x}\nsecond`;\nconst after: number = 1;";
    expect(toks(src).find((t) => t.cls === "string")?.text).toBe("`first ${x}\nsecond`");
    expect(kw(src)).toEqual(["const", "const", "number"]);
  });

  it("takes a regex literal whole, so an escaped slash is not a comment", () => {
    // `//` opens a comment in this language, and a regex escaping a slash writes two
    // of them side by side. Read from the second one, the comment runs to the end of
    // the line and swallows the rest of the statement.
    const src = 'const RE = /^https?:\\/\\//;\nconst q = s.replace(/\\/\\//g, "/");\n';
    expect(toks(src).some((t) => t.cls === "comment")).toBe(false);
    const strings = toks(src)
      .filter((t) => t.cls === "string")
      .map((t) => t.text);
    expect(strings).toEqual(["/^https?:\\/\\//", "/\\/\\//g", '"/"']);
  });

  it("reads a slash after a value as division, including after a generic close", () => {
    // The guess is biased: only a position where a regex is legal takes one. A closing
    // angle bracket ends a type argument list far more often than it precedes a
    // literal, so a slash after it stays arithmetic and stays grey.
    for (const src of [
      "const half: number = total / 2 / n;\n",
      "const rate = counts.in / counts.out;\n",
      "const n = new Map<string, number>().size / 2 / 3;\n",
    ]) {
      expect(toks(src).some((t) => t.cls === "string")).toBe(false);
      expect(toks(src).some((t) => t.cls === "comment")).toBe(false);
    }
  });

  it("leaves the identifiers that merely look like type-level words alone", () => {
    // Every one of these is an ordinary name in ordinary TypeScript. `out` is a
    // local in this repo's own tokenizer; `type` is the commonest property key
    // there is; `object` and `symbol` name plain values far more often than they
    // name a type.
    const src = `const out: string[] = [];
const object = { type: "band", value: 1 };
const symbol = Symbol("line");
if (event.type === "band" && object.value > 0) out.push(symbol.description ?? "");
const accessorOut = out;
`;
    const words = kw(src);
    for (const name of ["out", "object", "symbol", "type", "value", "get", "set", "accessorOut"]) {
      expect(words).not.toContain(name);
    }
    // The line still reads as code: the declarations and the primitive do light up.
    expect(words).toEqual(expect.arrayContaining(["const", "if", "string"]));
  });

  it("rejoins losslessly", () => {
    // Mirrors the shared corpus in registry.test.ts, which re-checks the module's
    // one hard invariant over every registered language: concatenating the emitted
    // spans returns the input byte for byte.
    for (const src of [
      "",
      "\n",
      SAMPLE,
      "const t = `never closed\nconst after = 2;",
      'const s = "oops\nlet n: number = 1;',
      "/* never closed\nstill comment",
      "café ünïcode\r\n\ttab\n",
      "trailing backslash \\",
      "0xFF 0b1010 1_000 1.5e-3 9n\n",
      "type A = `${Uppercase<B>}-suffix`;\n",
      'const RE = /^https?:\\/\\//;\nconst q = s.replace(/\\/\\//g, "/");\n',
      "const r = /unclosed\nconst half: number = total / 2;\n",
      "const cls = /[^/]+\\/[\\]]/gu;\n",
      "const trail = /a\\",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
