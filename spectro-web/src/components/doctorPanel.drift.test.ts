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
// There is no DOM in this suite, so this reads the seam off disk the way
// componentReach.drift.test.ts reads its mounts: the assertion is that the
// panel calls the shared reader and hands it the fetched payload.
// webSearchSetup.test.ts proves what comes out the other end.
//
// The first version of this file did only that, and the review of card 223
// measured what it was worth: replacing the row's whole value expression with
// `search.tier` left every test here green. Asserting that a KEY appears in a
// file says nothing about what the file draws. So the row is now pinned as an
// EQUALITY — three fields, no logic — which is only honest because the logic
// moved somewhere it can be tested for its output.
//
// Two things this file asserts the panel must NOT do. It must not spell a tier
// name: that would be a third copy of a decision card 203 spent a whole card
// reducing to one, agreeing with the server exactly until somebody changed the
// table. And it must not hedge "(configured)" once card 222 has landed — the
// last test here fires on the merge itself rather than trusting anyone to
// remember.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_SEARCH_TIERS } from "./webSearchSetup";
import { dict } from "../i18n/i18n";

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

describe("the calibration panel names the web search tier", () => {
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
    // Nothing here can be pinned by rendering: DoctorPanel fetches in an effect
    // and `renderToStaticMarkup` runs no effects, so a server render of this
    // panel reaches `pending` and stops. So the mapping moved out into
    // `webSearchRowValue`, where webSearchSetup.test.ts pins what it returns,
    // and what is left to hold down is that this row consults it and holds no
    // opinion beside it. An equality says that; a `toContain` would pass with a
    // second, unpinned expression sitting next to the call.
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
