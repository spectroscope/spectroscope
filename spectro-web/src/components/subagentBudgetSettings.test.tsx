// The subagent budget reaches the settings page (card 372).
//
// Two claims, and only one of them has a home in core: that a child's run
// budget has an operator floor, and that the floor is settable BY A PERSON.
// SubagentConfig reads `subagentBudgetSeconds` and a green Java suite answers
// the first. A page with no control leaves the second exactly where card 262
// left the progress guard, configurable through the chain and reachable
// nowhere.
//
// The control assertion RENDERS, and the two wiring assertions call the
// handlers. Card 356's header records why neither reads the source for the
// key's name: its first draft did, and deleting the whole control row left it
// green, because the name still stood in the block's `fields={[...]}` array two
// lines above. A string being present is not a control being present. A control
// being present is not a control saving its own key either, which is the
// likeliest defect in a block copied from the one above it: the patch keeps
// writing the neighbour's field while the markup reads correct.

import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import { NumberField } from "./settingsNumberField";
import { SETTING_REACH, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";
import { drive, typeInto } from "../testkit/driveComponent";

/** The settings key this file is about. */
const FIELD = "subagentBudgetSeconds";

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

describe("the subagent budget is classified before it is drawn", () => {
  it("reaches the next session, which is what buildAgentOnce makes true", () => {
    // MEASURED at the call site rather than inherited from the neighbours it
    // sits with on the page. SessionConnection.buildAgentOnce() builds the
    // SubagentManager from the config it adopted at that moment
    // (SessionConnection.java:1298, taking subagentBudgetSeconds off `active`
    // at 1318), and the manager keeps that config for the life of the session.
    // The budget re-derives its latency window on every spawn, but the floor it
    // compares against is the one it was built with, so a save cannot move the
    // session already open.
    expect(SETTING_REACH.subagentBudgetSeconds).toBe("next-session");
  });

  it("may not share a sentence with a live setting", () => {
    // The other direction, so the block guard is shown still guarding rather
    // than merely not complaining.
    expect(() => reachOf(["subagentBudgetSeconds", "continuationBudget"])).toThrow(/do not all reach/);
  });
});

describe("the subagent budget has a control and a sentence in both languages", () => {
  it("draws a number input for it, measured on the rendered page", () => {
    const html = render();
    expect(html, `${FIELD} has no field on the page`).toContain(`data-progress-field="${FIELD}"`);
    // The field really carries an input, not just a label: an empty field
    // element would otherwise pass for a control.
    const at = html.indexOf(`data-progress-field="${FIELD}"`);
    const around = html.slice(at, at + 400);
    expect(around, "the subagent-budget field renders no number input").toMatch(/<input[^>]*type="number"/);
  });

  it("stands in a block that names it, with the reach visible in the DOM", () => {
    const blocks = [...render().matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toContain(FIELD);
    // It never merges with a neighbour: it shares the turn ceiling's reach and
    // bounds something else entirely, one child's wall clock against the whole
    // run's turns, and one sentence over both would read as one limit. Any
    // block naming it alongside anything else fails here, not only the one
    // ordering a literal would catch.
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

  it("names the unit, because the number alone does not say seconds", () => {
    for (const lang of ["en", "de"] as const) {
      const key = `set.${FIELD}Note`;
      const note = t(lang, key as never);
      // The key itself ends in "Seconds", so a missing translation falling
      // through to it satisfies the pattern below. Rule out the fall-through
      // first, or this case is green on a dictionary that has no such entry.
      expect(note, `${key}/${lang} falls through to its own key`).not.toBe(key);
      expect(note.toLowerCase()).toMatch(/second|sekunde/);
    }
  });
});

describe("the control writes the field it stands for", () => {
  it("saves the number the operator types, under its own key", () => {
    // The assertion the rendered page cannot make. This block was copied from
    // the turn ceiling above it, and a patch left saying `maxTurns` draws a
    // control that looks right, carries the right label and the right sentence,
    // and moves the wrong number.
    const { input, saved } = controlFor(FIELD);
    expect(input, `${FIELD} renders no input to type into`).toBeDefined();
    drive(input as ReactElement, [NumberField], [typeInto("7200")]);
    expect(saved).toEqual([{ subagentBudgetSeconds: 7200 }]);
  });

  it("sends null when the origin row resets it", () => {
    // Null is how a scope is cleared rather than set to zero, and zero is a
    // floor the Java side refuses. A reset wired to the neighbour's key would
    // clear the neighbour and leave this one standing.
    const { origin, saved } = controlFor(FIELD);
    expect(origin, `${FIELD} has no origin row to reset from`).toBeDefined();
    expect(origin?.props.field, "the origin row reports another field's origin").toBe(FIELD);
    (origin?.props.onReset as () => void)();
    expect(saved).toEqual([{ subagentBudgetSeconds: null }]);
  });
});
