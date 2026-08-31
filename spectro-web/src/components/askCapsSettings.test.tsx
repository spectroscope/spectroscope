// The ask caps reach the settings page (card 356).
//
// WHY A TEST HERE AT ALL, when the Java side already pins the behaviour: the
// caps being settable and the caps being SETTABLE BY A PERSON are two claims,
// and only the first one has a home in core. The owner's ask was the second —
// "wo stelle ich das ein: ich will all diese dinge auf einer settings seite
// haben" — so a green core and a page with no control would answer the wrong
// half.
//
// WHAT THIS FILE DELIBERATELY DOES NOT DO. It does not type the list of three
// keys and then assert that same list appears. That shape is the canon's
// most-repeated defect (card 312 found it three times in one card): a hand-list
// guarded by a test typing the same hand-list can never go red. The coverage
// assertion below derives its expectation from SETTING_REACH — the module the
// page itself reads — so a fourth cap added to the reach table with no control
// turns this red.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import { ReachBlock, SETTING_REACH, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";

/** The smallest view the page can draw: every key effective, none overridden. */
const VIEW = {
  effective: Object.fromEntries(Object.keys(SETTING_REACH).map((k) => [k, 1])),
  origins: {},
  layers: {},
  files: {},
  workspace: null,
} as never;

/** The ask caps, taken from the reach table rather than typed here. */
const ASK_CAPS = Object.keys(SETTING_REACH).filter(
  (k) => k === "questionsPerRun" || k.startsWith("maxQuestion"),
);

describe("the ask caps are classified before they are drawn", () => {
  it("names all three, and finds them by shape rather than by a typed list", () => {
    // If a fourth cap joins the reach table it lands here automatically, and
    // every assertion below then demands a control for it.
    expect(ASK_CAPS.sort()).toEqual(["maxQuestionChars", "maxQuestionOptions", "questionsPerRun"]);
  });

  it("reaches the next session, which is what buildAgentOnce makes true", () => {
    // Measured rather than assumed: SessionConnection registers the tool inside
    // buildAgentOnce() and the tool holds its caps as final fields, so a save
    // cannot move the session already open.
    for (const cap of ASK_CAPS) {
      expect(SETTING_REACH[cap as keyof typeof SETTING_REACH]).toBe("next-session");
    }
    expect(reachOf(ASK_CAPS as never)).toBe("next-session");
  });

  it("shares one honest sentence, so they may stand in one block", () => {
    expect(() => reachOf(ASK_CAPS as never)).not.toThrow();
    // …and the other direction: mixing in the live one must still throw, or the
    // block guard has stopped guarding.
    expect(() => reachOf([...ASK_CAPS, "continuationBudget"] as never)).toThrow(/do not all reach/);
  });
});

describe("every cap has a control and a sentence in both languages", () => {
  it("draws a NUMBER INPUT for each one, measured on the rendered page", () => {
    // ⚠️ THE FIRST DRAFT OF THIS ASSERTION SURVIVED ITS OWN BITE, and the record
    // belongs here rather than in a commit nobody re-reads. It was
    // `expect(panel).toContain(`"${cap}"`)` — reading the SOURCE for the cap's
    // name. Deleting the whole control row for maxQuestionChars left the test
    // green, because the name still stands in the block's own `fields={[...]}`
    // array two lines above. It asserted that a string was present, not that a
    // control was, which is the same shape as card 312's hand-lists.
    //
    // So it renders instead, and looks for the thing an operator would touch:
    // a field element carrying the cap's name, with a number input inside it.
    const html = renderToStaticMarkup(
      <ProgressGuardSettings anchorId="progress" view={VIEW} lang="en" onSave={() => {}} />,
    );
    for (const cap of ASK_CAPS) {
      expect(html, `${cap} has no field on the page`).toContain(`data-progress-field="${cap}"`);
    }
    // …and each field really carries an input, not just a label: count them, so
    // a field rendered empty cannot pass for a control.
    const inputs = html.match(/<input[^>]*type="number"/g) ?? [];
    expect(inputs.length).toBeGreaterThanOrEqual(ASK_CAPS.length);
  });

  it("says what each one does, in EN and DE, with no key falling through", () => {
    for (const cap of ASK_CAPS) {
      for (const key of [`set.${cap}`, `set.${cap}Note`]) {
        expect(Object.prototype.hasOwnProperty.call(dict, key), `${key} is missing`).toBe(true);
        for (const lang of ["en", "de"] as const) {
          const text = t(lang, key as never);
          // A missing translation falls through to the key itself — assert on
          // the VALUE, because "the key exists" passes on an empty string.
          expect(text, `${key}/${lang}`).not.toBe(key);
          expect(text.length, `${key}/${lang}`).toBeGreaterThan(3);
        }
      }
    }
  });

  it("tells the reader that zero switches the asking off", () => {
    // The one number whose meaning is not obvious from its name: card 265's own
    // O4 wanted a way to de-register the ask entirely, and 0 is it. A note that
    // does not say so leaves the operator guessing what the floor means.
    for (const lang of ["en", "de"] as const) {
      expect(t(lang, "set.questionsPerRunNote" as never)).toContain("0");
    }
  });

  it("renders the block with its reach visible", () => {
    const html = renderToStaticMarkup(
      <ReachBlock lang="en" fields={ASK_CAPS as never}>
        <span>fields</span>
      </ReachBlock>,
    );
    expect(html).toContain('data-reach="next-session"');
    expect(html).toContain("questionsPerRun");
  });
});
