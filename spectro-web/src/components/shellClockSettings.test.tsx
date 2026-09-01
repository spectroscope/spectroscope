// The shell clock reaches the settings page (card 359).
//
// Two claims, and only one of them has a home in core: that the budget is
// settable, and that it is settable BY A PERSON. A green Java suite over a page
// with no control answers the first and leaves the second exactly where card
// 262 left the progress guard — configurable through the chain and reachable
// nowhere.
//
// The control assertion RENDERS and looks for the thing an operator would
// touch. Card 356's own header records why: its first draft read the SOURCE for
// the key's name, and deleting the whole control row left the test green,
// because the name still stood in the block's `fields={[...]}` array two lines
// above. A string being present is not a control being present.

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

describe("the shell clock is classified before it is drawn", () => {
  it("reaches the next session, which is what buildAgentOnce makes true", () => {
    // MEASURED, not assumed. SessionConnection.buildAgentOnce() calls
    // StandardTools.all() (SessionConnection.java:1202) and registers the
    // result; runCommand closes over its budget at that moment and there is no
    // setter anywhere. So a save cannot move the session already open — the
    // same reason the guard's three counts are next-session and their
    // neighbour continuationBudget, which SessionConnection re-reads per
    // prompt, is not.
    expect(SETTING_REACH.commandTimeoutSeconds).toBe("next-session");
  });

  it("may not share a sentence with a live setting", () => {
    // The other direction, so the block guard is shown still guarding rather
    // than merely not complaining.
    expect(() => reachOf(["commandTimeoutSeconds", "continuationBudget"])).toThrow(/do not all reach/);
  });
});

describe("the shell clock has a control and a sentence in both languages", () => {
  it("draws a number input for it, measured on the rendered page", () => {
    const html = render();
    expect(html, "commandTimeoutSeconds has no field on the page").toContain(
      'data-progress-field="commandTimeoutSeconds"',
    );
    // The field really carries an input, not just a label — an empty field
    // element would otherwise pass for a control.
    const at = html.indexOf('data-progress-field="commandTimeoutSeconds"');
    const around = html.slice(at, at + 400);
    expect(around, "the shell-clock field renders no number input").toMatch(/<input[^>]*type="number"/);
  });

  it("stands in a block that names it, with the reach visible in the DOM", () => {
    const blocks = [...render().matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toContain("commandTimeoutSeconds");
    // It never merges with the turn ceiling: they happen to share a reach, but
    // one bounds a single shell call and the other bounds the whole run, and a
    // merged block would put one sentence over two unrelated numbers.
    expect(blocks).not.toContain("maxTurns commandTimeoutSeconds");
  });

  it("says what it does, in EN and DE, with no key falling through", () => {
    for (const key of ["set.commandTimeoutSeconds", "set.commandTimeoutSecondsNote"]) {
      expect(Object.prototype.hasOwnProperty.call(dict, key), `${key} is missing`).toBe(true);
      for (const lang of ["en", "de"] as const) {
        // A missing translation falls through to the key itself — assert on the
        // VALUE, because "the key exists" passes on an empty string.
        const text = t(lang, key as never);
        expect(text, `${key}/${lang}`).not.toBe(key);
        expect(text.length, `${key}/${lang}`).toBeGreaterThan(3);
      }
    }
  });

  it("names the unit, because the number alone does not say seconds", () => {
    for (const lang of ["en", "de"] as const) {
      const note = t(lang, "set.commandTimeoutSecondsNote" as never);
      expect(note.toLowerCase()).toMatch(/second|sekunde/);
    }
  });
});

describe("the turn-ceiling note stops quoting a default that moved", () => {
  it("does not still say the run ends after fifteen turns", () => {
    // Card 365 moved the shipped ceiling to 150. The note under this control
    // named the old number in both languages, which is the canon's third house
    // for a lie — after the code and the test, the sentence the operator reads.
    for (const lang of ["en", "de"] as const) {
      expect(t(lang, "set.maxTurnsNote" as never)).not.toMatch(/\b15\b/);
    }
  });
});
