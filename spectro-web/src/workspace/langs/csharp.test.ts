import { describe, expect, it } from "vitest";
import { tokenize, type HlLang, type Token } from "../highlight";
import { csharp } from "./csharp";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";

// `tokenize` reaches its vocabulary through the registry and nothing else exposes
// a spec, so a spec is only reachable as a registered entry. Vitest gives each
// test file its own module graph, so this claim cannot reach another suite, and it
// is a no-op once the registry holds the same object under the same key.
const CS = "csharp" as HlLang;
(LANGS as Record<string, LangDef>)[CS] = csharp;

const toks = (src: string): Token[] => tokenize(src, CS);
const kw = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);
const clsOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;

// Ordinary code, not a keyword salad: a file-scoped namespace, a positional
// record, an XML doc comment, a verbatim path and a relational pattern.
const SAMPLE = `using System.Collections.Generic;
using System.IO;

namespace Spectro.Readings;

/// <summary>One spectral line, as read off the plate.</summary>
public sealed record Line(string Label, double Nanometres)
{
    public bool IsVisible => Nanometres is >= 380 and <= 750;
}

internal static class Reader
{
    public static IReadOnlyList<Line> Parse(string[] args)
    {
        var lines = new List<Line>();
        foreach (var file in Directory.EnumerateFiles(@"C:\\spectro\\runs"))
        {
            // A blank label sorts ahead of every real one, so drop it.
            var label = Path.GetFileNameWithoutExtension(file);
            if (label.Length == 0) continue;
            lines.Add(new Line(label, 0.0));
        }
        return lines;
    }
}
`;

describe("csharp", () => {
  it("claims the fence names and extensions a reader types", () => {
    expect(csharp.aliases).toEqual(expect.arrayContaining(["csharp", "cs", "c#", "dotnet"]));
    expect(csharp.extensions).toEqual(expect.arrayContaining(["cs", "csx"]));
  });

  it("colours declarations, modifiers and the primitive type names", () => {
    const words = kw(SAMPLE);
    expect(words).toEqual(
      expect.arrayContaining([
        "using",
        "namespace",
        "public",
        "sealed",
        "record",
        "internal",
        "static",
        "class",
        "var",
        "foreach",
        "in",
        "return",
        "new",
        "if",
        "continue",
      ]),
    );
    // Reserved in C#, so they cannot be identifiers and colouring them is free.
    expect(words).toEqual(expect.arrayContaining(["string", "double", "bool"]));
  });

  it("colours the pattern-matching words", () => {
    const words = kw(SAMPLE);
    expect(words).toEqual(expect.arrayContaining(["is", "and"]));
    expect(kw('if (x is not null or Line { Label: "" }) { }')).toEqual(
      expect.arrayContaining(["is", "not", "or"]),
    );
    expect(kw("catch (IOException e) when (e.HResult != 0) { }")).toContain("when");
    expect(kw("static T Pick<T>(List<T> xs) where T : class => xs[0];")).toContain("where");
    expect(kw("throw new ArgumentNullException(nameof(xs));")).toContain("nameof");
    expect(kw("public required string Label { get; init; }")).toEqual(
      expect.arrayContaining(["required", "init"]),
    );
    expect(kw("static void Fill(scoped ref Span<byte> buf) { }")).toEqual(
      expect.arrayContaining(["scoped", "ref"]),
    );
  });

  it("reads a comment, a number and a verbatim string out of the sample", () => {
    expect(clsOf(SAMPLE, "380")).toBe("number");
    expect(clsOf(SAMPLE, "0.0")).toBe("number");
    // `///` is an XML doc comment, which the `//` opener already covers.
    expect(toks(SAMPLE).some((t) => t.cls === "comment" && t.text.startsWith("///"))).toBe(true);
    expect(toks(SAMPLE).some((t) => t.cls === "comment" && t.text.includes("blank label"))).toBe(true);
    expect(toks(SAMPLE).some((t) => t.cls === "string" && t.text === '"C:\\spectro\\runs"')).toBe(true);
  });

  it("reads the other three string forms", () => {
    // Interpolated: the `$` stays plain punctuation and the quoted body colours.
    expect(clsOf('var s = $"read {n} lines";', '"read {n} lines"')).toBe("string");
    // Char literal, escape included.
    expect(clsOf("var c = '\\n';", "'\\n'")).toBe("string");
    // Raw string literal, which spans lines.
    const raw = 'var r = """\n  no escapes \\n here\n  """;\nvar after = 1;';
    expect(toks(raw).find((t) => t.cls === "string")?.text).toBe('"""\n  no escapes \\n here\n  """');
    expect(clsOf(raw, "1")).toBe("number");
  });

  it("leaves the identifiers that merely look like contextual keywords alone", () => {
    // `args` is the parameter of every Main ever written, `file` and `value` are
    // the obvious names for a file and a value, and an accessor body is full of
    // both. Colouring any of them paints a variable as syntax.
    const src = `public string Label { get => _label; set => _label = value; }
static int Main(string[] args) { var file = args[0]; var add = 1; var remove = 2; return add - remove; }
`;
    const words = kw(src);
    for (const name of ["args", "file", "value", "get", "set", "add", "remove"]) {
      expect(words).not.toContain(name);
    }
    // The line still reads as code around them.
    expect(words).toEqual(expect.arrayContaining(["public", "string", "static", "int", "var", "return"]));
  });

  it("rejoins losslessly", () => {
    // Mirrors the shared corpus in registry.test.ts, which re-checks the module's
    // one hard invariant over every registered language: concatenating the emitted
    // spans returns the input byte for byte. The verbatim forms are here because
    // they are the ones the escape-aware scanner reads on its own terms.
    for (const src of [
      "",
      "\n",
      SAMPLE,
      'var p = @"ends with a backslash\\";\nvar after = 1;',
      'var d = @"a""b";\n',
      'var u = "never closed\nvar after = 2;',
      'var r = """never closed\nstill string',
      "/* never closed\nstill comment",
      "café ünïcode\r\n\ttab\n",
      "trailing backslash \\",
      "0xFF 0b1010 1_000 1.5e-3 42UL 9.99m\n",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
