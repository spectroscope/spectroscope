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
// The second half is the one worth more. It asserts what the panel must NOT
// contain: a tier name. A panel that spelled "duckduckgo" itself would be a
// third copy of a decision card 203 spent a whole card reducing to one, and it
// would agree with the server exactly until somebody changed the table.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WEB_SEARCH_TIERS } from "./webSearchSetup";
import { dict } from "../i18n/i18n";

const panel = readFileSync(fileURLToPath(new URL("./DoctorPanel.tsx", import.meta.url)), "utf8");
const surfaces = readFileSync(fileURLToPath(new URL("../styles/surfaces.css", import.meta.url)), "utf8");

/** @return the declarations of one CSS rule, as text */
function rule(css: string, selector: string): string {
  const from = css.indexOf(`${selector} {`);
  return from < 0 ? "" : css.slice(from, css.indexOf("}", from));
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

  it("says which tier it is showing, because a running session may hold another", () => {
    // Card 222 is deciding whether a live session can carry a tier the config
    // does not. Until it has, this row reports the CONFIGURED tier and says so
    // in its label — a panel that quietly reported the config while the run
    // used something else would re-create the very defect it exists to reveal.
    for (const lang of ["de", "en"] as const) {
      expect(dict["doc.webSearch"][lang].toLowerCase(), lang).toMatch(/konfiguriert|configured/);
    }
  });
});
