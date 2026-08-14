// The calibration panel draws the web-search line, and draws it from the
// SERVED answer (card 223).
//
// The defect this holds shut: /api/config has carried a complete `webSearch`
// block since card 203 — tier, label, sentence, instance address — and the one
// panel a person opens when a tool misbehaves never mentioned search at all.
// `grep -cE 'web.?search|searxng' DoctorPanel.tsx` answered 0 while the CLI
// printed the line and the settings page rendered it. Nothing was missing; it
// was served and nobody drew it. That is card 195's blocking finding again, one
// panel over: "the page was verified as a form, not as an answer".
//
// The row is held at two ends, because each end let the other one through.
//
// The RENDER end is first, and it is the one this file was missing. The second
// review of card 223 measured the hole: `{checks.map(…)}` →
// `{checks.slice(0, 4).map(…)}` in DoctorPanel.tsx drops this row out of the
// panel entirely and touches none of the source the assertions below read —
// `tsc -b` exit 0, all six tests here green, the whole suite at 260 files /
// 3800 tests / 0 failures, and the shipped panel draws four rows naming no
// search tier. That is the card's own defect, restored, past the file added to
// prevent it.
//
// The reason this file gave for having no render test was wrong, and it was
// written down three times — here, in webSearchSetup.ts's javadoc on
// `webSearchRowValue`, and in webSearchSetup.test.ts's header. All three said a
// server render "cannot reach past pending here". What is true is narrower:
// DoctorPanel fetches in an effect and `renderToStaticMarkup` runs no effects,
// so the row's VALUE is stuck at the pending "…" and cannot be asserted that
// way. The ROW is not. A static render of this panel emits every
// `.doctor-row` element, label and dot and all — that is the half the source
// assertions cannot see, and it is where the slice above hid.
//
// The SOURCE end is the other half, and it is the one rendering cannot reach:
// the review before that measured `search.tier` in place of the row's whole
// value expression, and the `{ addr }` argument dropped from the `t()` call,
// each leaving the full suite green. Asserting that a KEY appears in a file
// says nothing about what the file draws — so the row is pinned as an EQUALITY,
// three fields and no logic, which is only honest because the logic moved into
// `webSearchRowValue`, where webSearchSetup.test.ts pins its output.
//
// So: rendering says the row is on the screen, the equality says it is wired to
// the reader, and webSearchSetup.test.ts says what the reader returns. Cut any
// one of the three and a mutation walks through the gap.
//
// Two things this file asserts the panel must NOT do. It must not spell a tier
// name: that would be a third copy of a decision card 203 spent a whole card
// reducing to one, agreeing with the server exactly until somebody changed the
// table. And it must not hedge "(configured)" once card 222 has landed — the
// last test here fires on the merge itself rather than trusting anyone to
// remember.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DoctorPanel } from "./DoctorPanel";
import { WEB_SEARCH_TIERS } from "./webSearchSetup";
import { dict, t, type Lang } from "../i18n/i18n";
import { currentLang, setLang } from "../state/lang";

const panel = readFileSync(fileURLToPath(new URL("./DoctorPanel.tsx", import.meta.url)), "utf8");
const surfaces = readFileSync(fileURLToPath(new URL("../styles/surfaces.css", import.meta.url)), "utf8");

/** The panel with `//` comments dropped, so a row can be read as code. */
const code = panel.replace(/^[ \t]*\/\/.*$/gm, "");

/** @return the declarations of one CSS rule, as text */
function rule(css: string, selector: string): string {
  const from = css.indexOf(`${selector} {`);
  return from < 0 ? "" : css.slice(from, css.indexOf("}", from));
}

/** One row of the `checks` list as source, whitespace collapsed. */
function row(key: string): string {
  const at = code.indexOf(`key: "${key}"`);
  if (at < 0) return "";
  return code
    .slice(code.lastIndexOf("{", at), code.indexOf("}", at) + 1)
    .replace(/\s+/g, " ")
    .trim();
}

/** Every row the panel DECLARES, in source order. The expected render count is
 *  read from the list rather than typed as a number, so a tenth subsystem is a
 *  one-line change here and a dropped one is a failure. It was nine when this
 *  was written. */
const declared = [...code.matchAll(/key: "(doc\.[A-Za-z]+)"/g)].map((m) => m[1]);

/** The panel as a reader gets it, in one language. Open, socket up, no live
 *  provider — the fetched states stay `pending`, which is all a server render
 *  can reach and all this needs: it asks WHICH ROWS ARE ON THE SCREEN. */
function panelHtml(lang: Lang): string {
  setLang(lang);
  return renderToStaticMarkup(
    <DoctorPanel open={true} onClose={() => {}} status="open" providerInfo={null} permissionMode="ask" />,
  );
}

const wasLang = currentLang();
afterAll(() => setLang(wasLang));

describe("the calibration panel names the web search tier", () => {
  it("draws every declared row, the web-search one among them", () => {
    // The finding this test exists for: `checks.slice(0, 4).map(…)` in
    // DoctorPanel.tsx leaves every source assertion below green — the row's
    // object literal is untouched, the import is untouched, the key is still in
    // the file — and ships a panel with four rows that names no search tier.
    // tsc -b exit 0, 260 files / 3800 tests / 0 failures, feature dead.
    //
    // A count alone would not be enough either: a row can be present and be the
    // wrong one, so the label is read out of the markup in both languages.
    expect(declared).toContain("doc.webSearch");
    for (const lang of ["en", "de"] as const) {
      const html = panelHtml(lang);
      expect(html.split('class="doctor-row"').length - 1, `${lang}: rows on screen`).toBe(declared.length);
      expect(html, `${lang}: the web-search row`).toContain(t(lang, "doc.webSearch"));
    }
  });

  it("draws a row for it at all", () => {
    // The grep from the card, inverted. It answered 0 on c00c361.
    expect(/web.?search|searxng/i.test(panel)).toBe(true);
    expect(panel).toContain('key: "doc.webSearch"');
    expect(dict["doc.webSearch"], "doc.webSearch").toBeDefined();
  });

  it("builds the row from the payload /api/config already served", () => {
    // Not from a second fetch and not from a second derivation: the panel
    // already holds the whole config object, and the block is inside it.
    const call = panel.slice(panel.indexOf("webSearchCheck("));
    expect(call.slice(0, call.indexOf(")"))).toContain("config");
    expect(panel).toContain('from "./webSearchSetup"');
  });

  it("is three fields, two of them the reader's own output and no logic of its own", () => {
    // The review finding, and the reason this assertion is an EQUALITY rather
    // than a `toContain`. The row's value used to be a four-state ternary in
    // the JSX, and the tests around it looked thorough: the key was pinned, the
    // `webSearchCheck(config)` call was pinned, `webSearchCheck` itself was
    // pinned six ways, `tierReading` more. None of them looked at what the row
    // renders. Replacing the whole expression with `search.tier`, and
    // separately dropping the `{ addr }` argument, each left the full suite at
    // 260 files / 3794 tests / 0 failures — the feature could ship reading
    // "duckduckgo", or "…at {addr}", with every gate green.
    //
    // The VALUE is what rendering cannot reach — and only the value. The panel
    // fetches in an effect, `renderToStaticMarkup` runs no effects, so this
    // cell is `…` in the test above no matter what the mapping does. (The row
    // itself renders fine; that is what the test above is for. This file once
    // claimed the whole panel was out of reach, and a slice of the row list
    // walked straight through the gap that claim excused.) So the mapping moved
    // out into `webSearchRowValue`, where webSearchSetup.test.ts pins what it
    // returns, and what is left to hold down here is that this row consults it
    // and holds no opinion beside it. An equality says that; a `toContain`
    // would pass with a second, unpinned expression sitting next to the call.
    expect(row("doc.webSearch")).toBe(
      '{ key: "doc.webSearch", verdict: search.verdict, value: webSearchRowValue(search, lang), }',
    );
  });

  it("phrases the tier it was handed and never picks one", () => {
    for (const tier of WEB_SEARCH_TIERS) {
      expect(panel, `DoctorPanel.tsx spells the tier "${tier}" itself`).not.toContain(tier);
    }
  });

  it("does not hide the answer at 60 percent of its own width", () => {
    // Found live, not in the diff. With an instance configured the row read
    // "searxng — a metasearch instance you run,…" — cell 302 px, sentence
    // 742 px — and the address, the one fact criterion 3 asks for, survived
    // only as a hover tooltip. `llm backend` was losing its host to the same
    // rule on the same build. A calibration panel that clips its measurements
    // is a form again, not an answer.
    const value = rule(surfaces, ".doctor-value");
    expect(value).not.toBe("");
    expect(value).not.toContain("nowrap");
    expect(value).not.toContain("text-overflow");
  });

  it("says which tier it is showing, for exactly as long as that is two answers", () => {
    // Criterion 5, and a tripwire rather than a note on a card.
    //
    // This row reads /api/config, so it reports the CONFIGURED tier, and while
    // a running session can hold a different one the label has to say so —
    // a panel that quietly reported the config while the run used something
    // else would re-create the very defect it exists to reveal.
    //
    // Card 222 removes the difference. It makes WebSearchTool resolve its
    // searcher PER CALL (`Supplier<WebSearcher>`, in both `execute` and
    // `description()`), so a saved address reaches an open session from its
    // next tool call — measured on `card-222-live-settings`, and `set.reachLive`
    // is the sentence its settings page puts on screen to say so. The moment
    // that key exists in this dictionary, the two cards have met, "configured"
    // is no longer a distinction, and a row still hedging it contradicts the
    // settings page about one fact — which is what criterion 1 exists to stop.
    //
    // So the merge fires this, in whichever order the two branches land. There
    // is nothing to remember.
    const hedged = ["de", "en"].every((lang) =>
      /konfiguriert|configured/.test(dict["doc.webSearch"][lang as "de" | "en"].toLowerCase()),
    );
    if (dict["set.reachLive"]) {
      expect(
        hedged,
        "card 222 has landed: set.reachLive is in this dictionary, so web_search now resolves its\n" +
          "tier per call and a saved address reaches an open session. The configured tier IS the live\n" +
          'tier, and doc.webSearch must stop hedging — drop "(configured)" / "(konfiguriert)" from\n' +
          "both languages. That is the whole change; this test then holds the other direction.",
      ).toBe(false);
    } else {
      expect(
        hedged,
        "card 222 has not landed, so a running session may still hold a tier this row cannot see.\n" +
          'doc.webSearch must say "(configured)" / "(konfiguriert)" in both languages until it has.',
      ).toBe(true);
    }
  });
});
