import { describe, expect, it, vi } from "vitest";
import { tokenize, type Token } from "../highlight";
import { php } from "./php";

// `tokenize` reaches a vocabulary only through the registry, keyed by id, so the
// definition under test is bound there for this module. The substitution is
// scoped to this file: it proves the language reads without depending on where
// the registry happens to list it.
vi.mock("./registry", async () => ({ LANGS: { php: (await import("./php")).php } }));

// Ordinary PHP: a namespaced class, a promoted constructor property, all three
// comment forms, and an interpolated double-quoted string.
const SRC = `<?php

namespace Spectro\\Http;

use Psr\\Log\\LoggerInterface;

final class HealthProbe
{
    private const TIMEOUT = 5;

    # legacy shim, kept until the next major
    public function __construct(private LoggerInterface $log) {}

    /* Returns null when the server never answered. */
    public function probe(string $url): ?array
    {
        // one shot, no retry
        $raw = file_get_contents($url, false, $this->context());
        if ($raw === false) {
            $this->log->warning("probe failed for {$url}");
            return null;
        }
        return json_decode($raw, true);
    }
}
`;

const toks = (src: string): Token[] => tokenize(src, "php" as never);
const classOf = (src: string, needle: string): string | undefined =>
  toks(src).find((t) => t.text === needle)?.cls;
const keywords = (src: string): string[] =>
  toks(src)
    .filter((t) => t.cls === "keyword")
    .map((t) => t.text);

describe("php", () => {
  it("declares the names a reader will type", () => {
    expect(php.aliases).toContain("php");
    expect(php.extensions).toContain("php");
  });

  it("colours declarations, control flow and the type names", () => {
    expect(keywords(SRC)).toEqual(
      expect.arrayContaining([
        "namespace",
        "use",
        "final",
        "class",
        "private",
        "const",
        "public",
        "function",
        "string",
        "array",
        "if",
        "return",
        "null",
        "true",
        "false",
      ]),
    );
  });

  it("colours a string and a number", () => {
    expect(classOf(SRC, '"probe failed for {$url}"')).toBe("string");
    expect(classOf(SRC, "5")).toBe("number");
  });

  it("colours all three comment forms", () => {
    const comments = toks(SRC).filter((t) => t.cls === "comment");
    expect(comments.some((t) => t.text.startsWith("//"))).toBe(true);
    expect(comments.some((t) => t.text.startsWith("#"))).toBe(true);
    expect(comments.some((t) => t.text.startsWith("/*"))).toBe(true);
  });

  it("colours the shouted literals legacy code writes", () => {
    // The three spellings are listed outright instead of folding the whole
    // vocabulary; see the language file for why the rest of it stays cased.
    const kw = keywords("$ok = TRUE;\n$no = FALSE;\n$empty = NULL;\n");
    expect(kw).toEqual(expect.arrayContaining(["TRUE", "FALSE", "NULL"]));
  });

  it("does not fold case, so a class named after a keyword stays plain", () => {
    // PHP folds keyword case; this vocabulary does not. Folding would paint the
    // class names that share a keyword spelling — Match, List, Enum, Object — as
    // syntax, and those are read far more often than a shouted `IF`.
    //
    // Read off the keyword list, not by finding the word: adjacent plain runs are
    // merged into one token, so an uncoloured identifier never stands alone.
    const src = `$node = new Match();
if ($node instanceof Match) {
    $label = match ($node->kind) { default => 'other' };
}
`;
    const kw = keywords(src);
    expect(kw).toEqual(expect.arrayContaining(["new", "instanceof", "if", "match", "default"]));
    expect(kw).not.toContain("Match");
  });

  it("leaves $this plain in both of its spellings", () => {
    // `->` starts with a hyphen and a hyphen is glue, so `$this->log` can never
    // colour while `return $this;` could. One token that colours on one line and
    // not the next reads as a defect, so it colours on neither.
    const kw = keywords("$this->log->info('x');\nreturn $this;\n");
    expect(kw).not.toContain("$this");
    expect(kw).toContain("return");
  });

  it("reads a PHP 8 attribute as a comment, which is the price of #", () => {
    // `#` opens a comment and `#[` opens an attribute, and the scanner sees one
    // character. Comments are the far commoner spelling, so they win: an attribute
    // greys out. The alternative sprays keyword colour through every # comment.
    const toksOf = toks("#[Route('/health')]\npublic function probe() {}\n");
    expect(toksOf[0].cls).toBe("comment");
    expect(toksOf[0].text).toBe("#[Route('/health')]");
  });

  it("leaves a heredoc body uncoloured rather than guessing its label", () => {
    // A heredoc's delimiter is a label the author invents, which no fixed fence
    // can express. The body reads as code; nothing is lost, only uncoloured.
    const src = "$sql = <<<SQL\n    SELECT 1\nSQL;\n";
    expect(toks(src).some((t) => t.cls === "string")).toBe(false);
    expect(
      toks(src)
        .map((t) => t.text)
        .join(""),
    ).toBe(src);
  });

  it("rejoins losslessly", () => {
    for (const src of [
      SRC,
      "$s = 'it\\'s escaped';\n$n = 0x1F;\n",
      '$s = "oops\n$n = 1;\n',
      "/* never closed\n$after = 1;",
      "?>\n<p>plain html</p>\n",
    ]) {
      expect(
        toks(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
