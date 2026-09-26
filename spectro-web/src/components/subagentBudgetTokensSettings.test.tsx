// The token budget of one child reaches the settings page (card 394).
//
// SubagentConfig reads `subagentBudgetTokens` and a green Java suite answers
// that a child is cut when its spend passes it. This file answers that a person
// can set the number: a control on the page, a sentence in both languages, and
// a patch that writes this key and not the neighbour it was copied from, which
// is card 372's time budget one block up.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import { NumberField } from "./settingsNumberField";
import { SETTING_REACH, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";
import { drive, typeInto } from "../testkit/driveComponent";

/** The settings key this file is about. */
const FIELD = "subagentBudgetTokens";

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

/** Every element in a tree, outermost first. A component element is NOT
 *  evaluated: its children stand in its props, which is where a ReachBlock
 *  keeps the controls, and evaluating one would call a component this file has
 *  no renderer for. */
function elementsIn(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  const found: ReactElement<Record<string, unknown>>[] = [];
  const walk = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n as ReactNode[]) walk(child);
      return;
    }
    if (!isValidElement(n)) return;
    const el = n as ReactElement<Record<string, unknown>>;
    found.push(el);
    walk(el.props.children as ReactNode);
  };
  walk(node);
  return found;
}

/**
 * The control row for one field, read off the element tree rather than off
 * markup, together with every patch its handlers send.
 *
 * There is no DOM in this suite, so nothing is typed into and nothing is
 * clicked. React elements are plain objects, so the row's number field and the
 * origin row's `onReset` can be found and invoked without a browser, which is
 * the only way to see WHICH key a control writes. The number field keeps a
 * draft in state since card 386, so it is typed into through `drive`, which
 * hosts its hooks.
 *
 * @param field the settings key whose row to look for
 * @returns the row's number field, its origin row, and the patches both wrote
 */
function controlFor(field: string): {
  input: ReactElement<Record<string, unknown>> | undefined;
  origin: ReactElement<Record<string, unknown>> | undefined;
  saved: Record<string, unknown>[];
} {
  const saved: Record<string, unknown>[] = [];
  const tree = ProgressGuardSettings({
    anchorId: "progress",
    view: VIEW,
    lang: "en",
    onSave: (patch) => saved.push(patch),
  });
  const row = elementsIn(tree).find((el) => el.props["data-progress-field"] === field);
  const inside = row === undefined ? [] : elementsIn(row);
  return {
    input: inside.find((el) => el.type === NumberField),
    origin: inside.find((el) => typeof el.type === "function" && "onReset" in el.props),
    saved,
  };
}

describe("the subagent token budget is classified before it is drawn", () => {
  it("reaches the next session, which is what buildAgentOnce makes true", () => {
    // Read at the call site: SessionConnection.buildAgentOnce() hands
    // active.subagentBudgetTokens() to the SubagentConfig builder, and the
    // manager keeps that config for the life of the session, so a save lands
    // with the next session and not the one already open.
    expect(SETTING_REACH.subagentBudgetTokens).toBe("next-session");
  });

  it("may not share a sentence with a live setting", () => {
    // The other direction, so the block guard is shown still guarding rather
    // than merely not complaining.
    expect(() => reachOf(["subagentBudgetTokens", "continuationBudget"])).toThrow(/do not all reach/);
  });
});

describe("the subagent token budget has a control and a sentence in both languages", () => {
  it("draws a number input for it, measured on the rendered page", () => {
    const html = render();
    expect(html, `${FIELD} has no field on the page`).toContain(`data-progress-field="${FIELD}"`);
    // The field really carries an input, not just a label: an empty field
    // element would otherwise pass for a control.
    const at = html.indexOf(`data-progress-field="${FIELD}"`);
    const around = html.slice(at, at + 400);
    expect(around, "the token-budget field renders no number input").toMatch(/<input[^>]*type="number"/);
  });

  it("stands in a block that names it, with the reach visible in the DOM", () => {
    const blocks = [...render().matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toContain(FIELD);
    // It never merges with a neighbour: it shares the time budget's reach and
    // bounds something else, one child's spend against one child's clock, and
    // one sentence over both would read as one limit.
    expect(blocks.some((b) => b.split(" ").length > 1 && b.includes(FIELD))).toBe(false);
  });

  it("says what it does, in EN and DE, with no key falling through", () => {
    for (const key of [`set.${FIELD}`, `set.${FIELD}Note`]) {
      expect(Object.prototype.hasOwnProperty.call(dict, key), `${key} is missing`).toBe(true);
      for (const lang of ["en", "de"] as const) {
        // A missing translation falls through to the key itself, so assert on
        // the VALUE: "the key exists" passes on an empty string.
        const text = t(lang, key as never);
        expect(text, `${key}/${lang}`).not.toBe(key);
        expect(text.length, `${key}/${lang}`).toBeGreaterThan(3);
      }
    }
  });

  it("names the unit and what is counted, because the number alone says neither", () => {
    for (const lang of ["en", "de"] as const) {
      const key = `set.${FIELD}Note`;
      const note = t(lang, key as never);
      // The key itself ends in "Tokens", so a missing translation falling
      // through to it satisfies the first pattern. Rule out the fall-through
      // first, or this case is green on a dictionary that has no such entry.
      expect(note, `${key}/${lang} falls through to its own key`).not.toBe(key);
      expect(note.toLowerCase()).toMatch(/token/);
      expect(note.toLowerCase(), `${key}/${lang} does not say input plus output`).toMatch(
        /input.*output|eingabe.*ausgabe/,
      );
    }
  });

  it("says the request of the turn it is cut in still goes out, is cancelled and is not counted", () => {
    // SubagentTokenBudgetTest pins the order on the Java side: the check runs
    // as the next turn starts, and the request of that turn reaches the backend
    // and is torn down without reporting usage. A note that promises a stop
    // before that request promises a saving the code does not make.
    const says = {
      en: [/next turn/, /cancel/, /not in the count/, /bill/],
      de: [/nächsten zug/, /abgebrochen/, /zählt nicht mit/, /berechnen/],
    } as const;
    const promisesTooMuch = /before its next (model call|exchange)|vor seinem nächsten modellaufruf/;
    for (const lang of ["en", "de"] as const) {
      const key = `set.${FIELD}Note`;
      const note = t(lang, key as never).toLowerCase();
      for (const pattern of says[lang]) {
        expect(note, `${key}/${lang} does not match ${pattern}`).toMatch(pattern);
      }
      expect(note, `${key}/${lang}`).not.toMatch(promisesTooMuch);
    }
  });
});

describe("the control writes the field it stands for", () => {
  it("saves the number the operator types, under its own key", () => {
    // The assertion the rendered page cannot make. This block was copied from
    // the time budget above it, and a patch left saying `subagentBudgetSeconds`
    // draws a control that looks right and moves the wrong number.
    const { input, saved } = controlFor(FIELD);
    expect(input, `${FIELD} renders no input to type into`).toBeDefined();
    drive(input as ReactElement, [NumberField], [typeInto("4000000")]);
    expect(saved).toEqual([{ subagentBudgetTokens: 4000000 }]);
  });

  it("sends null when the origin row resets it", () => {
    // Null is how a scope is cleared rather than set to zero, and zero is a
    // floor the Java side refuses. A reset wired to the neighbour's key would
    // clear the neighbour and leave this one standing.
    const { origin, saved } = controlFor(FIELD);
    expect(origin, `${FIELD} has no origin row to reset from`).toBeDefined();
    expect(origin?.props.field, "the origin row reports another field's origin").toBe(FIELD);
    (origin?.props.onReset as () => void)();
    expect(saved).toEqual([{ subagentBudgetTokens: null }]);
  });
});
