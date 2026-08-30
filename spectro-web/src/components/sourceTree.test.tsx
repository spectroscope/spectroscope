// Card 326: the source pane's tree reading, as it actually renders.
//
// Everything here is read off the MARKUP the pane produces. The depth control
// is measured on which nodes are drawn open, never on the number that was
// handed to JsonTree: `defaultDepth` is only consulted at mount
// (JsonTree.tsx:76 holds each node's state in useState), so a test that
// asserted the prop would keep passing on a build where the prop reached a
// tree already on screen and moved nothing.
//
// House style: renderToStaticMarkup, no DOM and no testing-library (the repo
// has neither). That buys the mounted state of the pane and nothing after it,
// which is why the "hand-fold a node, then press verbose" half of the doctrine
// is called out in state/sourceDepth.test.ts as the builder's own mutation bite
// rather than promised by a name here.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceBody } from "./TraceView";
import type { Reading, SourcePane } from "./traceDetail";
import type { SourceDepth } from "../state/sourceDepth";
import { t, type Lang } from "../i18n/i18n";

/** The pane case this card is about: an imported file, and THIS frame's line. */
const lineOf = (text: string): SourcePane => ({
  kind: "line",
  text,
  lineNumber: 1,
  total: 1,
  siblings: 1,
  ordinal: 1,
});

const render = (
  pane: SourcePane,
  reading: Reading,
  depth: SourceDepth = "default",
  lang: Lang = "en",
): string =>
  renderToStaticMarkup(
    <SourceBody pane={pane} reading={reading} lang={lang} translated={false} depth={depth} />,
  );

/**
 * Whether the node under this key is drawn open.
 *
 * Matched on the toggle that CARRIES the key, not on the nearest attribute
 * before it: a leaf has no toggle of its own, so "the last aria-expanded above
 * this key" would silently report its PARENT's state and be right for the wrong
 * reason on every primitive.
 */
function nodeOpen(html: string, key: string): boolean {
  const toggle = new RegExp(
    `<button type="button" class="json-toggle" aria-expanded="(true|false)">` +
      `<span class="json-caret" aria-hidden="true">.</span>` +
      `<span class="json-key">${key}</span>`,
  ).exec(html);
  expect(toggle, `no collapsible node named ${key} is drawn at all`).not.toBeNull();
  return toggle![1] === "true";
}

/** Whether a key is drawn anywhere — a node behind a closed parent is not. */
const hasKey = (html: string, key: string): boolean => html.includes(`class="json-key">${key}</span>`);

/** A record shaped like the transcripts this pane exists for. */
const RECORD = JSON.stringify({
  type: "assistant",
  uuid: "3e010de0",
  message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
});

/** Ten levels of nesting. readable.ts measured the deepest structural nesting
 *  in the corpus at 9, so a reading that opens all ten opens everything a real
 *  file holds — and any "verbose" that is a small number instead of all of them
 *  fails here rather than passing on a three-deep fixture. */
function nest(levels: number): unknown {
  let value: unknown = { leaf: "bottom" };
  for (let i = levels; i >= 1; i--) value = { [`level${i}`]: value };
  return value;
}
const DEEP = JSON.stringify(nest(10));

const PROSE = "2026-08-30 12:04:11  INFO  the run finished with 3 warnings";

describe("the tree reading draws the line as a tree", () => {
  it("draws a collapsible tree over the parsed line", () => {
    const html = render(lineOf(RECORD), "tree");
    expect(html).toContain('class="json-tree"');
    expect(hasKey(html, "type")).toBe(true);
    expect(hasKey(html, "uuid")).toBe(true);
    expect(nodeOpen(html, "message")).toBe(true);
  });

  // "der wie insight auch das higlighting macht" — the same value-kind colours
  // the Insight face draws, which are these classes and nothing else. A tree
  // rendered as plain text would satisfy the sentence above and fail here.
  it("paints the values with the tree's own token classes", () => {
    const html = render(lineOf(RECORD), "tree");
    expect(html).toContain('class="json-key"');
    expect(html).toContain('class="json-string"');
    expect(html).toContain('class="json-punct"');
  });

  // The reading changes the body; it does not silence the pane's statement
  // about WHICH line this is. A tree with no line number over it would be the
  // one thing the source pane exists to say, dropped.
  it("still says which line of the file this is", () => {
    expect(render(lineOf(RECORD), "tree")).toContain(t("en", "trace.source.line", { n: 1, total: 1 }));
  });

  it("keeps the two older readings free of trees", () => {
    expect(render(lineOf(RECORD), "verbatim")).not.toContain('class="json-tree"');
    expect(render(lineOf(RECORD), "readable")).not.toContain('class="json-tree"');
  });
});

describe("a line that is not JSON", () => {
  // Three bites, three reasons. A single case over all three would report one
  // and hide two.
  it("says so for prose, and draws no tree", () => {
    const html = render(lineOf(PROSE), "tree");
    expect(html).toContain(t("en", "trace.source.notJson"));
    expect(html).not.toContain('class="json-tree"');
  });

  it("still shows the line itself, unchanged", () => {
    // Saying "this is not JSON" and then showing nothing is the silence this
    // whole pane was built to end.
    expect(render(lineOf(PROSE), "tree")).toContain(PROSE);
  });

  it("says so for a line that parses to a bare value, which would be one leaf", () => {
    const html = render(lineOf("null"), "tree");
    expect(html).toContain(t("en", "trace.source.notJson"));
    expect(html).not.toContain('class="json-tree"');
  });

  it("draws an empty document as the empty tree it really is", () => {
    // `{}` IS JSON. Calling it "not JSON" would be a different lie from the one
    // above, so the two are pinned apart.
    const html = render(lineOf("{}"), "tree");
    expect(html).toContain('class="json-tree"');
    expect(html).not.toContain(t("en", "trace.source.notJson"));
  });

  it("says it in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      expect(render(lineOf(PROSE), "tree", "default", lang), lang).toContain(
        t(lang, "trace.source.notJson"),
      );
    }
  });
});

describe("how far the tree opens", () => {
  // The two settings are told apart on a line that is ten levels deep, and each
  // claim is bitten on its own. A pair of assertions in one `it` would let
  // "verbose opens everything" ride along on "default opens to two".
  it("opens the default reading to level 2 and no further", () => {
    const html = render(lineOf(DEEP), "tree", "default");
    expect(nodeOpen(html, "level1")).toBe(true);
    expect(nodeOpen(html, "level2")).toBe(false);
  });

  it("leaves everything below level 2 off the screen by default", () => {
    const html = render(lineOf(DEEP), "tree", "default");
    expect(hasKey(html, "level3")).toBe(false);
    expect(html).not.toContain("bottom");
  });

  it("opens every level on verbose, all ten of them", () => {
    const html = render(lineOf(DEEP), "tree", "verbose");
    for (const level of [1, 2, 3, 5, 9, 10]) {
      expect(nodeOpen(html, `level${level}`), `level${level}`).toBe(true);
    }
  });

  it("puts the deepest leaf on screen on verbose", () => {
    expect(render(lineOf(DEEP), "tree", "verbose")).toContain("bottom");
  });

  // The control has to be the difference between the two renderings and not the
  // difference between "a tree" and "no tree": without this, an implementation
  // that collapsed the ROOT on default would pass every assertion above.
  it("opens the same top of the tree either way", () => {
    for (const depth of ["default", "verbose"] as const) {
      const html = render(lineOf(DEEP), "tree", depth);
      expect(nodeOpen(html, "level1"), depth).toBe(true);
    }
  });

  // The depth is the tree's business alone. A verbatim pane that changed with
  // it would mean the bytes on screen depend on a display setting, which is
  // the one thing the verbatim reading promises never to do.
  it("leaves the verbatim reading identical at either depth", () => {
    expect(render(lineOf(DEEP), "verbatim", "default")).toBe(render(lineOf(DEEP), "verbatim", "verbose"));
  });
});
