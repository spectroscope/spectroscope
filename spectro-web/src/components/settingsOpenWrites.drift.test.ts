// Card 121, the wiring half, read off disk.
//
// The policy module answers WHEN the settings chooser may write; these tests
// hold the panel to actually asking it. The failure being pinned was wiring,
// not logic: SettingsPanel passed a literal `autoPick: true` into
// useProviderModels, whose resolve handler persists through putSettings — so
// opening the page rewrote a configured model. This suite has no renderer, by
// house rule; what it can see is which props the panel hands over, and that is
// exactly where this bug lived.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";
import { t } from "../i18n/i18n";

const settingsTsx = read("./SettingsPanel.tsx", import.meta.url);
const pickerTsx = read("./ProviderPicker.tsx", import.meta.url);
const fieldTsx = read("./providerModelField.tsx", import.meta.url);
const formTs = read("./providerPickerForm.ts", import.meta.url);

describe("opening Settings writes nothing", () => {
  it("never hands useProviderModels an unconditional auto-pick", () => {
    // The card's one-line cause. A literal `autoPick: true` in this file means
    // the open-the-panel fetch may persist a model the operator never chose.
    expect(settingsTsx).not.toContain("autoPick: true");
  });

  it("derives the auto-pick from the gesture policy", () => {
    expect(settingsTsx).toContain('settingsMayAutoPick(providerTouched ? "gesture" : "open")');
  });

  it("arms the gesture only in the provider select's own change handler", () => {
    // One arming site, inside the onChange that also saves the new provider —
    // any second setter would widen "gesture" beyond an actual user choice.
    expect(settingsTsx.split("setProviderTouched(true)").length - 1).toBe(1);
  });

  it("disarms the gesture on every open, so a reopened panel is looking again", () => {
    expect(settingsTsx).toContain("setProviderTouched(false)");
  });
});

describe("a configured-but-absent model is shown, not swallowed", () => {
  it("asks the settings model field to mark absence", () => {
    expect(settingsTsx).toContain("markAbsent");
    expect(fieldTsx).toContain("modelAbsentFromList(");
  });

  it("says so in both languages, distinctly from the no-list note", () => {
    for (const lang of ["de", "en"] as const) {
      const absent = t(lang, "pp.notOffered");
      expect(absent).not.toBe("pp.notOffered"); // the key resolves
      expect(absent).not.toBe(t(lang, "pp.noList")); // absence ≠ no answer
    }
  });
});

// Card 556, fix round 1: the picker's form moved to providerPickerForm.ts. In
// the live view it still snaps unconditionally, a chooser opened to choose; a
// stored session's picker holds the recorded pair until the owner picks
// (providerPickerForm.test.ts follows both across the fetch).
describe("the header picker's own auto-pick", () => {
  it("snaps unless the form still holds a stored session's recorded pair", () => {
    expect(pickerTsx).not.toContain("useProviderModels(");
    expect(pickerTsx).toContain("usePickerForm({");
    expect(formTs).toContain(
      'const holding = holdRecorded && sel === provider && model === (activeModel ?? "");',
    );
    expect(formTs).toContain("autoPick: !holding,");
  });

  it("does not mark absence — its authoritative snap already resolves it", () => {
    expect(pickerTsx).not.toContain("markAbsent");
    expect(formTs).not.toContain("markAbsent");
  });
});
