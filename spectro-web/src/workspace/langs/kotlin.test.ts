import { describe, expect, it, vi } from "vitest";
import { tokenize, type Token } from "../highlight";
import { kotlin } from "./kotlin";

// `tokenize` reaches a vocabulary only through the registry, keyed by id, so the
// definition under test is bound there for this module. The substitution is
// scoped to this file: it proves the language reads without depending on where
// the registry happens to list it.
vi.mock("./registry", async () => ({ LANGS: { kotlin: (await import("./kotlin")).kotlin } }));

// Ordinary Kotlin: a suspending function, a raw string, a template, a `when`, and
// a value called `data` — the soft keyword most often somebody's variable.
const SRC = `package dev.spectroscope.web

import kotlinx.coroutines.delay

/* Poll the server until it answers or the budget runs out. */
suspend fun awaitHealth(client: Client, tries: Int = 20): Boolean {
    val banner = """
        waiting for /api/health
    """.trimIndent()
    val data = client.get("/api/health")
    val label = when (data.code) {
        200 -> "ok"
        else -> "retry"
    }
    repeat(tries) {
        if (data.ok) return true
        delay(250)          // the server is still booting
    }
    println("$banner gave up as $label after $tries tries")
    return false
}
`;

const toks = (src: string): Token[] => tokenize(src, "kotlin" as never);
const classOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

describe("kotlin", () => {
  it("declares the names a reader will type", () => {
    expect(kotlin.aliases).toEqual(expect.arrayContaining(["kotlin", "kt"]));
    expect(kotlin.extensions).toEqual(expect.arrayContaining(["kt", "kts"]));
  });

  it("colours hard keywords and the modifiers that read as syntax", () => {
    expect(keywords(SRC)).toEqual(
      expect.arrayContaining(["package", "import", "suspend", "fun", "val", "when", "else", "return"]),
    );
  });

  it("colours a string, a number and both comment forms", () => {
    expect(classOf(SRC, '"ok"')).toBe("string");
    expect(classOf(SRC, "200")).toBe("number");
    expect(toks(SRC).find((t) => t.text.startsWith("/*"))?.cls).toBe("comment");
    expect(toks(SRC).find((t) => t.text.startsWith("//"))?.cls).toBe("comment");
  });

  it("carries a raw string across its line breaks", () => {
    const raw = toks(SRC).find((t) => t.cls === "string" && t.text.startsWith('"""'));
    expect(raw?.text).toContain("waiting for /api/health");
    expect(raw?.text.endsWith('"""')).toBe(true);
  });

  it("keeps a template's interpolation inside the string", () => {
    // There is no nesting in the tokenizer: `$name` and `${expr}` are part of the
    // literal that carries them, so the whole template reads as one string.
    const src = 'val s = "$banner gave up"\nval n = 1\n';
    expect(classOf(src, '"$banner gave up"')).toBe("string");
    expect(keywords(src)).toEqual(["val", "val"]);
  });

  it("leaves the soft keywords that are usually variables alone", () => {
    // `data`, `out`, `open`, `value` and `it` each mean something to the compiler
    // in one position and are ordinary names in every other. `data class` keeps
    // its colour on `class`, `val data = …` keeps none — that way round is right.
    //
    // Read off the keyword list, not by finding the word: adjacent plain runs are
    // merged into one token, so an uncoloured identifier never stands alone.
    const src = `val data = load()
val out = File("x")
val value = 3
items.forEach { println(it) }
fun open(path: String) {}
`;
    const kw = keywords(src);
    for (const word of ["data", "out", "value", "it", "open"]) expect(kw).not.toContain(word);
    expect(kw).toEqual(expect.arrayContaining(["val", "fun"]));
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SRC,
      'val c = \'x\'\nval s = "a\\"b"\n',
      'val t = """never closed\nval after = 2\n',
      "// trailing comment without a newline",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
