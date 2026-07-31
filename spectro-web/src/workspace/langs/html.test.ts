import { afterAll, describe, expect, it } from "vitest";
import { tokenize, type Token } from "../highlight";
import { html } from "./html";
import { LANGS } from "./registry";
import type { LangDef } from "./spec";

// See yaml.test.ts for why the spec is registered here: the registry line is a
// separate wiring pass, and the assertions are worth nothing unless they run
// through the real tokenizer.
const REGISTRY = LANGS as Record<string, LangDef>;
const ALREADY_WIRED = "html" in REGISTRY;
REGISTRY.html = html;
afterAll(() => {
  if (!ALREADY_WIRED) delete REGISTRY.html;
});

const scan = (src: string): Token[] => tokenize(src, "html" as never);
const classOf = (src: string, needle: string): string | undefined =>
  scan(src).find((t) => t.text === needle)?.cls;
// Adjacent plain runs are merged by the tokenizer, so an uncoloured word is never
// a token of its own: ask which classes carry it instead.
const carriedBy = (src: string, word: string): string[] => [
  ...new Set(
    scan(src)
      .filter((t) => t.text.includes(word))
      .map((t) => t.cls),
  ),
];

// The shell the server ships, shortened, plus two lines of prose: prose is what
// separates an html file from a config file, and it is what decides the spec.
const PAGE = `<!doctype html>
<!-- the app mounts into #root; everything else is scaffolding -->
<html lang="en" data-design="spectroscope">
  <head>
    <meta charset="utf-8" />
    <title>spectroscope</title>
    <link rel="stylesheet" href="/assets/index.css" />
  </head>
  <body>
    <p>Don't let the apostrophe eat the rest of this line.</p>
    <p>The main table in the form section is small.</p>
    <div id="root" data-count="42">7 lanes</div>
  </body>
</html>
`;

describe("html", () => {
  it("colours the comment", () => {
    const comment = scan(PAGE).find((t) => t.cls === "comment");
    expect(comment?.text).toBe("<!-- the app mounts into #root; everything else is scaffolding -->");
  });

  it("colours attribute values", () => {
    expect(classOf(PAGE, '"en"')).toBe("string");
    expect(classOf(PAGE, '"utf-8"')).toBe("string");
    expect(classOf(PAGE, '"/assets/index.css"')).toBe("string");
  });

  it("colours a number in the text", () => {
    expect(classOf(PAGE, "7")).toBe("number");
  });

  it("has no keyword vocabulary at all", () => {
    // The only words a set could hold are tag and attribute names, and in the
    // token stream they are indistinguishable from prose: `main`, `table`,
    // `form`, `section` and `small` all appear as text in this page. Every one
    // of them would light up mid-sentence. Under-colour instead.
    expect(scan(PAGE).some((t) => t.cls === "keyword")).toBe(false);
    for (const word of ["html", "head", "body", "div", "title", "main", "table", "form", "small"]) {
      expect(carriedBy(PAGE, word)).toEqual(["plain"]);
    }
  });

  it("does not let an apostrophe in the text open a string", () => {
    // This is why the single quote is not a string delimiter here: `Don't` would
    // otherwise paint the rest of the line, closing tag included, as a value.
    const strings = scan(PAGE)
      .filter((t) => t.cls === "string")
      .map((t) => t.text);
    expect(strings.some((s) => s.includes("eat the rest"))).toBe(false);
    expect(carriedBy(PAGE, "Don't")).toEqual(["plain"]);
  });

  it("rejoins losslessly", () => {
    for (const src of [PAGE, "<p>a<!-- never closed\n", '<img alt="unterminated\n<p>next</p>\n']) {
      expect(
        scan(src)
          .map((t) => t.text)
          .join(""),
      ).toBe(src);
    }
  });
});
