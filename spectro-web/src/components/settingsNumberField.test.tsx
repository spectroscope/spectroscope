// Card 386: the settings page's number field, typed into.
//
// Criterion 2 in the card's words: the test fires the change event with an
// empty value, and it does not assert on the `min` attribute, because a test
// that checks the attribute stays green while the defect is still there. So
// every case below presses the handler the field built and reads what was
// saved.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NumberField } from "./settingsNumberField";
import { drive, leave, theInput, typeInto, type El } from "../testkit/driveComponent";
import { t } from "../i18n/i18n";
import type { SettingsView } from "../state/serverSettings";

/** A view where the shell limit reads 900 and questions per run read 9. */
function viewWith(extra: Partial<SettingsView> = {}): SettingsView {
  return {
    effective: { commandTimeoutSeconds: 900, questionsPerRun: 9, dockMaxWidth: 1200 },
    origins: {},
    layers: {},
    files: {},
    workspace: null,
    floors: { commandTimeoutSeconds: 1, questionsPerRun: 0, dockMaxWidth: 260 },
    ...extra,
  };
}

/** Types each value in turn into one field and answers what it saved and
 *  the tree of the pass after the last step. */
function typed(
  field: string,
  steps: Parameters<typeof drive>[2],
  view = viewWith(),
  lang: "en" | "de" = "en",
) {
  const saved: Record<string, unknown>[] = [];
  const tree = drive(
    <NumberField view={view} field={field} lang={lang} onSave={(patch) => saved.push(patch)} />,
    [NumberField],
    steps,
  );
  return { saved, tree };
}

/** The held note under the field, or undefined when there is none. */
const heldNote = (tree: El[]): El | undefined =>
  tree.find((el) => el.props["data-number-held"] !== undefined);

describe("clearing a field to retype it", () => {
  it("sends no zero when the field is emptied", () => {
    // Scenario one of the card: the shell time limit shows 900, the number
    // is selected and deleted.
    const { saved } = typed("commandTimeoutSeconds", [typeInto("")]);
    expect(saved).toEqual([]);
  });

  it("sends no zero for an emptied field whose zero is legal", () => {
    // Where zero is legal the floor does not stop a zero, so only the empty
    // check does: questions per run cleared to retype must not switch the
    // agent's questions off.
    const { saved } = typed("questionsPerRun", [typeInto("")]);
    expect(saved).toEqual([]);
  });

  it("saves the new number once it is typed", () => {
    const { saved } = typed("commandTimeoutSeconds", [typeInto(""), typeInto("4"), typeInto("45")]);
    expect(saved).toEqual([{ commandTimeoutSeconds: 4 }, { commandTimeoutSeconds: 45 }]);
  });

  it("keeps the empty field empty while it is being edited", () => {
    // A controlled input whose handler saves nothing snaps back to the stored
    // value, and the operator could never type a number that starts below the
    // floor (a dock width of 300 starts with a 3).
    const { tree } = typed("commandTimeoutSeconds", [typeInto("")]);
    expect(theInput(tree).props.value).toBe("");
  });

  it("shows the stored value again when the field is left empty", () => {
    const { tree, saved } = typed("commandTimeoutSeconds", [typeInto(""), leave]);
    expect(theInput(tree).props.value).toBe("900");
    expect(saved).toEqual([]);
  });

  it("says why nothing was saved, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const { tree } = typed("commandTimeoutSeconds", [typeInto("")], viewWith(), lang);
      const note = heldNote(tree);
      expect(note, `${lang}: an empty field says nothing`).toBeDefined();
      expect(note?.props.children).toBe(t(lang, "set.numberEmpty"));
      expect(t(lang, "set.numberEmpty")).not.toBe("set.numberEmpty");
    }
  });
});

describe("a number below the floor", () => {
  it("is not sent", () => {
    const { saved } = typed("commandTimeoutSeconds", [typeInto("0")]);
    expect(saved).toEqual([]);
  });

  it("lets a width be typed digit by digit past its floor", () => {
    const { saved } = typed("dockMaxWidth", [typeInto(""), typeInto("3"), typeInto("30"), typeInto("300")]);
    expect(saved).toEqual([{ dockMaxWidth: 300 }]);
  });

  it("names the floor it is below, in both languages", () => {
    for (const lang of ["en", "de"] as const) {
      const { tree } = typed("dockMaxWidth", [typeInto("30")], viewWith(), lang);
      expect(heldNote(tree)?.props.children).toBe(t(lang, "set.numberHeld", { floor: 260 }));
      expect(t(lang, "set.numberHeld", { floor: 260 })).toContain("260");
    }
  });

  it("marks the input, and a saved value clears the mark", () => {
    const below = typed("dockMaxWidth", [typeInto("30")]).tree;
    expect(theInput(below).props["aria-invalid"]).toBe(true);
    const fine = typed("dockMaxWidth", [typeInto("300")]).tree;
    expect(theInput(fine).props["aria-invalid"]).toBeUndefined();
    expect(heldNote(fine)).toBeUndefined();
  });
});

describe("a legal zero stays legal", () => {
  it("saves questions per run 0", () => {
    // Scenario three of the card.
    const { saved } = typed("questionsPerRun", [typeInto("0")]);
    expect(saved).toEqual([{ questionsPerRun: 0 }]);
  });
});

describe("the lowest value comes from the server", () => {
  it("renders the floor the view carries as the input's min", () => {
    const html = renderToStaticMarkup(
      <NumberField
        view={viewWith({ floors: { dockMaxWidth: 7 } })}
        field="dockMaxWidth"
        lang="en"
        onSave={() => {}}
      />,
    );
    expect(html).toMatch(/<input[^>]*type="number"[^>]*min="7"/);
  });

  it("refuses by the floor the view carries, not by one of its own", () => {
    const view = viewWith({ floors: { dockMaxWidth: 7 } });
    expect(typed("dockMaxWidth", [typeInto("30")], view).saved).toEqual([{ dockMaxWidth: 30 }]);
  });
});
