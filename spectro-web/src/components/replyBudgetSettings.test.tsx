// The completion budget reaches the settings page (card 364).
//
// `AgentOptions.Builder.maxTokens` was public, documented, and called ZERO
// times in every main source of every module. The seam existed, so an audit
// asking "is this parameterised?" scored the number as reachable — and no
// operator could move it on any face. Making it a settings key answers half of
// that; the other half is the half card 359's own header names, and card 262
// paid for before either: settable through the chain and reachable nowhere.
//
// The control assertion RENDERS. A key's name also stands in the block's
// `fields={[...]}` array two lines above the control, so reading the source for
// it stays green when the whole control row is deleted.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import { SETTING_REACH, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";

/** The smallest view the page can draw: every key effective, none overridden. */
const VIEW = {
  effective: Object.fromEntries(Object.keys(SETTING_REACH).map((k) => [k, 1])),
  origins: {},
  layers: {},
  files: {},
  workspace: null,
} as never;

const render = (lang: "en" | "de" = "en"): string =>
  renderToStaticMarkup(
    <ProgressGuardSettings anchorId="progress" view={VIEW} lang={lang} onSave={() => {}} />,
  );

describe("the reply budget is classified before it is drawn", () => {
  it("reaches the next session, which is where Agent reads it", () => {
    // Measured rather than inherited from its neighbours: Agent's runLoop takes
    // `options.maxTokens()` once, before the first token flows, and there is no
    // setter for it — unlike continuationBudget, which SessionConnection
    // re-reads per prompt and which is therefore live.
    expect(SETTING_REACH.maxTokens).toBe("next-session");
  });

  it("may not share a sentence with a live setting", () => {
    expect(() => reachOf(["maxTokens", "continuationBudget"])).toThrow(/do not all reach/);
  });
});

describe("the reply budget has a control and a sentence in both languages", () => {
  it("draws a number input for it, measured on the rendered page", () => {
    const html = render();
    expect(html, "maxTokens has no field on the page").toContain('data-progress-field="maxTokens"');
    const at = html.indexOf('data-progress-field="maxTokens"');
    const around = html.slice(at, at + 400);
    expect(around, "the reply-budget field renders no number input").toMatch(/<input[^>]*type="number"/);
  });

  it("stands in a block of its own, with the reach visible in the DOM", () => {
    const blocks = [...render().matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toContain("maxTokens");
    // It shares maxTurns' reach and must still not share its sentence: one
    // bounds how much a single call may WRITE, the other how many calls a run
    // may MAKE, and a merged block would read as one limit.
    expect(blocks.some((b) => b.split(" ").length > 1 && b.includes("maxTokens"))).toBe(false);
  });

  it("says what it does, in EN and DE, with no key falling through", () => {
    for (const key of ["set.maxTokens", "set.maxTokensNote"]) {
      expect(Object.prototype.hasOwnProperty.call(dict, key), `${key} is missing`).toBe(true);
      for (const lang of ["en", "de"] as const) {
        const text = t(lang, key as never);
        expect(text, `${key}/${lang}`).not.toBe(key);
        expect(text.length, `${key}/${lang}`).toBeGreaterThan(3);
      }
    }
  });

  it("warns that a backend may hold a lower ceiling than the one typed here", () => {
    // The honest half of the sentence. The OpenAI-compatible provider clamps
    // every request to a hard 16,000 of its own, so a person who types 32,000
    // and watches a reply stop earlier has been told why before they look.
    for (const lang of ["en", "de"] as const) {
      expect(t(lang, "set.maxTokensNote" as never)).toMatch(/16[,.]000/);
    }
  });
});
