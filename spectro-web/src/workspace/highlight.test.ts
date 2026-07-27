import { describe, expect, it } from "vitest";
import { hlLangForPath, tokenize } from "./highlight";

describe("hlLangForPath", () => {
  it("maps known extensions", () => {
    expect(hlLangForPath("src/Foo.java")).toBe("java");
    expect(hlLangForPath("a/b/run.py")).toBe("python");
    expect(hlLangForPath("deploy.sh")).toBe("shell");
    expect(hlLangForPath(".bashrc.bash")).toBe("shell");
    expect(hlLangForPath("x.zsh")).toBe("shell");
    expect(hlLangForPath("config.json")).toBe("json");
  });
  it("is case-insensitive on the extension", () => {
    expect(hlLangForPath("Foo.JAVA")).toBe("java");
  });
  it("returns null for unknown / extensionless files", () => {
    expect(hlLangForPath("notes.txt")).toBeNull();
    expect(hlLangForPath("Makefile")).toBeNull();
    expect(hlLangForPath("data.csv")).toBeNull();
  });
});

describe("tokenize", () => {
  // The single most important invariant: highlighting must never drop, add or
  // reorder a byte. The rendered <pre> must read exactly like the source.
  const samples: Record<string, string> = {
    java: 'public class Foo {\n  // greet\n  int n = 42; // count\n  String s = "hi\\n";\n}\n',
    python: '# module\ndef f(x):\n    """doc\n    lines"""\n    return x + 1\n',
    shell: "#!/bin/sh\nif [ -n \"$x\" ]; then\n  echo 'done'\nfi\n",
    json: '{\n  "k": true,\n  "n": 12.5,\n  "z": null\n}\n',
  };
  for (const [lang, src] of Object.entries(samples)) {
    it(`is loss-less for ${lang}`, () => {
      const toks = tokenize(src, lang as never);
      expect(toks.map((t) => t.text).join("")).toBe(src);
    });
  }

  const classOf = (src: string, lang: string, needle: string): string | undefined =>
    tokenize(src, lang as never).find((t) => t.text === needle)?.cls;

  it("classifies java tokens", () => {
    const src = 'int n = 42; // c\nString s = "hi";';
    expect(classOf(src, "java", "int")).toBe("keyword");
    expect(classOf(src, "java", "42")).toBe("number");
    expect(classOf(src, "java", '"hi"')).toBe("string");
    expect(tokenize(src, "java").find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("classifies python tokens incl. triple strings", () => {
    const src = '# c\ndef f():\n    """d"""\n    return 3';
    expect(classOf(src, "python", "def")).toBe("keyword");
    expect(classOf(src, "python", "return")).toBe("keyword");
    expect(classOf(src, "python", "3")).toBe("number");
    expect(classOf(src, "python", '"""d"""')).toBe("string");
    expect(tokenize(src, "python").find((t) => t.text.startsWith("#"))?.cls).toBe("comment");
  });

  it("classifies shell tokens", () => {
    const src = "if true; then\n  echo 'x'\nfi";
    expect(classOf(src, "shell", "if")).toBe("keyword");
    expect(classOf(src, "shell", "then")).toBe("keyword");
    expect(classOf(src, "shell", "fi")).toBe("keyword");
    expect(classOf(src, "shell", "'x'")).toBe("string");
  });

  it("classifies json literals and numbers", () => {
    const src = '{"k": true, "n": 12.5, "z": null}';
    expect(classOf(src, "json", "true")).toBe("keyword");
    expect(classOf(src, "json", "null")).toBe("keyword");
    expect(classOf(src, "json", "12.5")).toBe("number");
    expect(classOf(src, "json", '"k"')).toBe("string");
  });

  it("does not classify a keyword substring inside an identifier", () => {
    const src = "internal className returnValue";
    for (const t of tokenize(src, "java")) {
      if (t.text === "internal" || t.text === "className" || t.text === "returnValue") {
        expect(t.cls).toBe("plain");
      }
    }
  });

  it("handles an unterminated string without hanging", () => {
    const src = 'String s = "oops\nint n = 1;';
    const toks = tokenize(src, "java");
    expect(toks.map((t) => t.text).join("")).toBe(src);
    expect(toks.find((t) => t.text === '"oops')?.cls).toBe("string");
  });
});

describe("sql", () => {
  it("colours shouted keywords and single-quoted strings", () => {
    const toks = tokenize("DELETE FROM r9wbh_menu WHERE link LIKE '%com_sppagebuilder%';", "sql");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).toContain("DELETE");
    expect(kw).toContain("FROM");
    expect(kw).toContain("WHERE");
    expect(kw).toContain("LIKE");
    expect(toks.some((t) => t.cls === "string" && t.text.includes("com_sppagebuilder"))).toBe(true);
  });

  it("treats -- as a line comment and rejoins losslessly", () => {
    const src = "SELECT 1 -- a note\nFROM t";
    const toks = tokenize(src, "sql");
    expect(toks.some((t) => t.cls === "comment" && t.text.includes("a note"))).toBe(true);
    expect(toks.map((t) => t.text).join("")).toBe(src);
  });
});
