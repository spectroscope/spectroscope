import type { LangDef } from "./spec";

// No keywords, deliberately. The only words a set could hold are tag and
// attribute names, and this tokenizer cannot tell markup from text: `main`,
// `table`, `form`, `link` and `small` are tag names AND ordinary English, so the
// set would light them up inside paragraphs. Markup structure is punctuation
// here, and punctuation is plain.
//
// The same one spec reads an embedded `<script>` or `<style>` body, so code
// inside a page gets the page's reading: its double-quoted strings and its
// numbers colour, its `//` comments and single-quoted strings do not.
const KEYWORDS: ReadonlySet<string> = new Set<string>();

export const html: LangDef = {
  // xml, svg and the two component formats ride along: their comment form and
  // their attribute quoting are the same, and that is all this spec describes.
  aliases: ["html", "htm", "xml", "svg", "vue", "svelte"],
  extensions: ["html", "htm", "xml", "svg", "vue", "svelte"],
  // Double quote only. The single quote is a legal attribute delimiter and also
  // an apostrophe in text, and text is most of an html file: `Don't` would paint
  // from the apostrophe to the end of the line, closing tag included. A straight
  // double quote in prose fails the same way, and is rare enough beside the
  // double-quoted attribute to be worth the trade.
  spec: { line: [], block: ["<!--", "-->"], quotes: ['"'], keywords: KEYWORDS },
};
