import { describe, expect, it } from "vitest";
import { hlLangForFence, hlLangForPath, tokenize, type Token, type TokenClass } from "./highlight";

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

describe("javascript", () => {
  // A workflow script is the reason this language exists here: the Workflow
  // tool hands the card an ES module.
  it("is named by extension and by fence", () => {
    expect(hlLangForPath("wf/audit.mjs")).toBe("javascript");
    expect(hlLangForPath("src/legacy.jsx")).toBe("javascript");
    expect(hlLangForFence("js")).toBe("javascript");
    expect(hlLangForFence("node")).toBe("javascript");
  });

  it("hands the TypeScript names to the TypeScript spec", () => {
    // A .ts file read with the JavaScript vocabulary leaves its whole type layer
    // grey, so these four names belong to the TypeScript spec. A duplicated claim
    // does not clash — it hands the name to whichever language the registry keys
    // later, which is alphabetical order — so ownership has to be pinned, not assumed.
    expect(hlLangForPath("src/App.tsx")).toBe("typescript");
    expect(hlLangForPath("src/state/reducer.ts")).toBe("typescript");
    expect(hlLangForFence("ts")).toBe("typescript");
    expect(hlLangForFence("typescript")).toBe("typescript");
  });

  it("colours declarations, strings and numbers", () => {
    const src = 'export const n = 42; // count\nawait run("x");';
    const toks = tokenize(src, "javascript");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).toEqual(expect.arrayContaining(["export", "const", "await"]));
    expect(toks.find((t) => t.text === "42")?.cls).toBe("number");
    expect(toks.find((t) => t.text === '"x"')?.cls).toBe("string");
    expect(toks.find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("carries a template literal across its line breaks", () => {
    const src = "const p = `first ${x}\nsecond`;\nconst after = 1;";
    const toks = tokenize(src, "javascript");
    expect(toks.find((t) => t.cls === "string")?.text).toBe("`first ${x}\nsecond`");
    // The code after the closing backtick is code again, not more string.
    expect(toks.filter((t) => t.cls === "keyword").map((t) => t.text)).toEqual(["const", "const"]);
  });

  // A regex literal is the one place where this language writes `//` without
  // meaning a comment: an escaped slash puts two of them side by side, and the
  // comment opener would otherwise win from the second one to the end of the line.
  // The literal therefore has to be taken whole, from its opening slash.
  const jsToks = (src: string): Token[] => tokenize(src, "javascript");
  const jsFirst = (src: string, cls: TokenClass): string | undefined =>
    jsToks(src).find((t) => t.cls === cls)?.text;

  it("takes a regex literal whole when its body escapes a slash", () => {
    const src = "const RE = /^https?:\\/\\//;\nconst after = 1;\n";
    expect(jsFirst(src, "comment")).toBeUndefined();
    expect(jsFirst(src, "string")).toBe("/^https?:\\/\\//");
    expect(
      jsToks(src)
        .filter((t) => t.cls === "keyword")
        .map((t) => t.text),
    ).toEqual(["const", "const"]);
  });

  it("takes a regex argument whole, flags and all", () => {
    const split = "const p = path.split(/\\//);\n";
    expect(jsFirst(split, "comment")).toBeUndefined();
    expect(jsFirst(split, "string")).toBe("/\\//");

    // The replacement is an ordinary string and has to survive as one: the pair of
    // escaped slashes ahead of it must not carry a comment across the argument list.
    const replace = 'const q = s.replace(/\\/\\//g, "/");\n';
    expect(jsFirst(replace, "comment")).toBeUndefined();
    expect(jsFirst(replace, "string")).toBe("/\\/\\//g");
    expect(jsToks(replace).some((t) => t.cls === "string" && t.text === '"/"')).toBe(true);
  });

  it("keeps a slash inside a character class from closing the literal", () => {
    const src = "const seg = /[^/]+/g;\n";
    expect(jsFirst(src, "string")).toBe("/[^/]+/g");
  });

  it("reads a slash after a value as division and leaves it plain", () => {
    // The guess only goes one way. A slash in a position where a regex is legal is
    // a literal; anywhere a value could have just ended it is division, and painting
    // arithmetic as a literal is the mis-colour this module refuses.
    for (const src of [
      "const half = total / 2 / n;\n",
      "const r = (a + b) / c / d;\n",
      "const s = rows[0] / 2 / 3;\n",
      "const ratio = bytes.in / bytes.out;\n",
    ]) {
      expect(jsFirst(src, "string")).toBeUndefined();
      expect(jsFirst(src, "comment")).toBeUndefined();
    }
  });

  it("declines to guess at a slash with no closing slash on its line", () => {
    // An unterminated regex is a syntax error, so a lone slash is far likelier to be
    // division. Swallowing the line would be the worse answer of the two.
    const src = "const r = /unclosed\nconst after = 2;\n";
    expect(jsFirst(src, "string")).toBeUndefined();
    expect(
      jsToks(src)
        .filter((t) => t.cls === "keyword")
        .map((t) => t.text),
    ).toEqual(["const", "const"]);
  });

  it("leaves a self-closing JSX tag alone, twice on one line", () => {
    // This vocabulary reads .jsx as well, and JSX ends a prop with `}` and a tag with
    // `/>`. Two elements on one line therefore offer a slash that opens nothing and a
    // second slash further along to close on, which is the shape most likely to paint
    // markup as a literal.
    for (const src of [
      "<A x={1} /> <B y={2} />\n",
      "<Foo bar={x} /> {/* note */}\n",
      "<p>{a} / {b}</p>\n",
      "return <div className={cls} />;\n",
    ]) {
      expect(jsFirst(src, "string")).toBeUndefined();
    }
    // The comment between the tags is still a comment, and a regex in a prop still
    // reads: the brace that opens the prop is a position where a literal is legal.
    expect(jsFirst("<Foo bar={x} /> {/* note */}\n", "comment")).toBe("/* note */");
    expect(jsFirst("const el = <A x={/^a/} />;\n", "string")).toBe("/^a/");
  });

  it("still reads a comment, a string and a division as it always did", () => {
    expect(jsFirst("const x = 1; // a note about / division\n", "comment")).toBe(
      "// a note about / division",
    );
    expect(jsFirst('const u = "http://x";\n', "string")).toBe('"http://x"');
    expect(jsFirst("/* block /re/ */\nconst n = 1;\n", "comment")).toBe("/* block /re/ */");
  });

  it("leaves the identifiers that merely look like keywords alone", () => {
    const toks = tokenize("const set = new Set();\nconst get = 1;", "javascript");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).not.toContain("set");
    expect(kw).not.toContain("get");
  });

  it("rejoins losslessly, unterminated template included", () => {
    for (const src of [
      'import x from "y";\nconst t = `a\nb`;\n/* block */\nasync function f() { return 1; }\n',
      "const t = `never closed\nconst after = 2;",
      'const RE = /^https?:\\/\\//;\nconst q = s.replace(/\\/\\//g, "/");\n',
      "const r = /unclosed\nconst n = total / 2;\n",
      "const cls = /[^/]+\\/[\\]]/gu;\n",
      "const trail = /a\\",
    ]) {
      expect(
        tokenize(src, "javascript")
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});

describe("shell heuristics", () => {
  it("colours the command verbs a transcript is actually made of", () => {
    const toks = tokenize("ssh host\ncd /var/www\nfind . -name '*.php'\nrm -rf x", "shell");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).toEqual(expect.arrayContaining(["ssh", "cd", "find", "rm"]));
  });

  it("does not light up a keyword glued inside a name", () => {
    // `in` is a shell keyword and uft.in.ua is a hostname; the scanner splits
    // on the dot, so without a glue rule the middle label reads as syntax.
    const toks = tokenize("cd uft.in.ua/www", "shell");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).toContain("cd");
    expect(kw).not.toContain("in");
  });

  it("leaves a flag and a path fragment alone", () => {
    const toks = tokenize("ls --test /usr/local/set/do", "shell");
    const kw = toks.filter((t) => t.cls === "keyword").map((t) => t.text);
    expect(kw).toEqual(["ls"]);
  });

  it("still rejoins losslessly", () => {
    const src = 'grep -r "nulled" . 2>/dev/null # note\nfor f in a b; do echo $f; done';
    expect(
      tokenize(src, "shell")
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });
});
