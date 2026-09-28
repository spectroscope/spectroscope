// Card 448: what the Web search block tells an operator about a SearXNG
// instance that serves HTML only. Rendered with react-dom/server like the other
// view suites; the block's two fetches run in effects, which a static render
// never runs, so only the static notes are on the page here.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WebSearchSettings } from "./WebSearchSettings";
import { dict, t } from "../i18n/i18n";
import { currentLang } from "../state/lang";

/** React escapes quotes and ampersands in text; the dictionary does not. */
function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

function render(): string {
  return renderToStaticMarkup(<WebSearchSettings anchorId="web-search" searxngUrl="" onSave={() => {}} />);
}

/** Everything after the first sentence: the part that says what to do. */
function fix(text: string): string {
  return text.slice(text.indexOf(". ") + 2);
}

describe("the Web search block on an HTML-only instance (card 448)", () => {
  it("says such an instance still answers, and how to switch json on", () => {
    const html = render();
    expect(html).toContain(escaped(t(currentLang(), "set.searxngHtmlOnly")));
  });

  it("gives the same fix as the line in the transcript, in both languages", () => {
    // The settings note speaks about any instance, the transcript line about
    // the one that just refused JSON, so their first sentences differ. The
    // second one is the remedy and must not.
    for (const lang of ["de", "en"] as const) {
      const note = dict["set.searxngHtmlOnly"][lang];
      const line = dict["info.searxngHtmlOnly"][lang];
      expect(fix(note).length).toBeGreaterThan(40);
      expect(fix(note)).toBe(fix(line));
    }
  });

  it("no longer tells the operator that a bare docker run is not enough", () => {
    // Until card 448 a stock container answered web_search with nothing, and
    // this sentence said so. It now answers from its HTML page.
    const cost = dict["set.searxngCost"];
    expect(cost.en).not.toContain("is not enough");
    expect(cost.de).not.toContain("reicht nicht");
    expect(cost.en).toContain("HTML results page");
    expect(cost.en).toContain("json");
  });

  it("writes no dash in the new sentences", () => {
    for (const key of ["set.searxngHtmlOnly", "set.searxngCost"]) {
      for (const text of [dict[key].de, dict[key].en]) {
        expect(text, key).not.toMatch(/[–—]/);
      }
    }
  });
});
