// Card 193, the wiring half, read off disk (house rule: no renderer).
//
// The logic module answers WHICH provider gets an address field and WHAT the
// unreachable sentence says; these tests hold the surfaces to actually using
// it. What a source-read can see is exactly where the bug class lives: a
// settings page that renders no field, a picker whose failure sentence keeps
// guessing "start ollama" against a server one hostname away, a probe that
// never re-runs after the address changed, and a first-run sheet that never
// tells the remote-machine reader where to type the address.

import { describe, expect, it } from "vitest";
import { read } from "../testkit/source";
import { t } from "../i18n/i18n";
import { addressSpecFor, LEGACY_SHARED_DEFAULT } from "./providerAddress";

const settingsTsx = read("./SettingsPanel.tsx", import.meta.url);
const pickerTsx = read("./ProviderPicker.tsx", import.meta.url);
const fieldTsx = read("./providerModelField.tsx", import.meta.url);
const onboardingTsx = read("./Onboarding.tsx", import.meta.url);
const appTsx = read("../App.tsx", import.meta.url);

describe("the settings page carries the address beside the provider that needs it", () => {
  it("renders the field from the one provider→field mapping", () => {
    // addressSpecFor is the single source: ollama/lmstudio get their field
    // (preset as placeholder), every other provider hides it.
    expect(settingsTsx).toContain("addressSpecFor(");
    expect(settingsTsx).toContain("placeholder={addressSpec.preset}");
  });

  it("re-runs the reachability probe after an address commit", () => {
    // The probe's fetch is keyed on provider + status; neither changes when
    // only the address does, so the commit must bump the probe epoch.
    expect(settingsTsx).toContain("setProbeEpoch");
    expect(fieldTsx).toContain("probeEpoch");
  });

  it("refreshes /api/config after an address commit, so the named address is fresh", () => {
    expect(settingsTsx).toContain("onAddressSaved");
    expect(appTsx).toContain("onAddressSaved");
  });
});

describe("the failure sentence names the address the probe tried", () => {
  it("both hosts hand the per-provider addresses to the model field", () => {
    expect(settingsTsx).toContain("providerAddress={providerAddress}");
    expect(pickerTsx).toContain("providerAddress={providerAddress}");
  });

  it("the model field derives the note from localDownNote", () => {
    expect(fieldTsx).toContain("localDownNote(");
  });

  it("says the address in both languages, distinctly from the addressless fallback", () => {
    for (const lang of ["de", "en"] as const) {
      const at = t(lang, "pp.localDownAt", { addr: "http://gpu-box:11434" });
      expect(at).not.toBe("pp.localDownAt"); // the key resolves
      expect(at).toContain("http://gpu-box:11434");
      expect(at).not.toBe(t(lang, "pp.localDown"));
    }
  });
});

describe("the startup tutorial points the remote-machine reader at the field", () => {
  it("carries the sentence in both languages, with a way into settings", () => {
    expect(onboardingTsx).toContain("anderen Maschine");
    expect(onboardingTsx).toContain("another machine");
    expect(onboardingTsx).toContain("onOpenSettings");
  });

  it("the app wires that pointer to the session-defaults section", () => {
    expect(appTsx).toContain('setSettingsSection("session")');
  });
});

// ── Card 311: the settings page says the override out loud ───────────────────

describe("the address field says when the general one is being overridden", () => {
  const cssFile = read("../styles/settings-trace.css", import.meta.url);

  it("derives the note from the one shared function", () => {
    expect(settingsTsx).toContain("addressOverrideNote(");
  });

  it("renders the resolved sentence beside the address field", () => {
    expect(settingsTsx).toContain("overrideNote.key");
    // Boundary, not prefix: a class name is a substring of its own typo, so a
    // plain toContain here stays green through a rename to --overriden.
    expect(settingsTsx).toMatch(/provider-field-note--override["\s]/);
  });

  it("carries a rule the stylesheet actually declares", () => {
    // An unknown class is silent — the note renders as a plain hint — and this
    // is the half of that pair the stylesheet owns; the tsx half is the
    // boundary match above. The rule's TOKENS are a second silence
    // (var(--nope) resolves to nothing at all) and they are NOT checked here:
    // phantomTokens.drift.test.ts asks that of every var() in the tree,
    // --accent and --text-dim included. This comment used to claim the pair
    // was in this one assertion, which was a claim about a check that did not
    // exist.
    //
    // Measured: renaming the rule to .provider-field-note--overriden left this
    // file green at 13/13 while the note lost its rule, because "--override"
    // is a prefix of "--overriden". The selector must therefore END here.
    expect(cssFile).toMatch(/\.provider-field-note--override\s*[,{]/);
  });

  it("hands it the same /api/config addresses the failure sentence names", () => {
    // One truth: the note must not re-derive endpointFor from the settings
    // fold while the sentence two rows down reads the server's answer.
    expect(settingsTsx).toContain("providerAddress,\n  );");
  });

  it("speaks the doctor's two facts in both languages", () => {
    // DoctorCommand#perProviderAddressLines names the address that wins and
    // the layer each of the two values came from. Three faces, one truth.
    for (const lang of ["de", "en"] as const) {
      const sentence = t(lang, "set.addressOverride", {
        field: "lmstudioBaseUrl",
        provider: "lmstudio",
        addr: "http://gpu-box:1234",
        winner: t(lang, "set.layer.user"),
        loser: t(lang, "set.layer.flags"),
      });
      expect(sentence, lang).not.toBe("set.addressOverride");
      expect(sentence, lang).not.toMatch(/\{[a-z]+\}/i);
      expect(sentence, lang).toContain("http://gpu-box:1234");
      expect(sentence, lang).toContain("lmstudioBaseUrl");
    }
  });
});

// ── Card 311, review: the two server literals this module mirrors ────────────
// The note answers "and where would clearing the field land me?", which the
// client cannot ask the server — the address a HYPOTHETICAL config resolves to
// is not on /api/config. So two of SpectroConfig's own strings are mirrored in
// providerAddress.ts, and a mirror nobody holds against the original is the
// defect that pays for itself later. Both are read out of the server's source
// here rather than re-typed.

describe("the fallback rule mirrors the server's, by value", () => {
  const spectroConfigJava = read(
    "../../../spectro-core/src/main/java/dev/spectroscope/core/config/SpectroConfig.java",
    import.meta.url,
  );

  it("uses the literal effectiveOpenAiBaseUrl actually reads as unset", () => {
    const m = /effectiveOpenAiBaseUrl\([^)]*\)\s*\{\s*if \(!"([^"]+)"\.equals\(baseUrl\)\)/.exec(
      spectroConfigJava,
    );
    expect(m, "effectiveOpenAiBaseUrl no longer compares baseUrl against one literal").not.toBeNull();
    expect(LEGACY_SHARED_DEFAULT).toBe(m?.[1]);
  });

  it("names the preset that rule falls back to for lmstudio", () => {
    const m = /case "lmstudio" -> "([^"]+)";/.exec(spectroConfigJava);
    expect(m, "openAiCompatPreset no longer carries an lmstudio row").not.toBeNull();
    expect(addressSpecFor("lmstudio")?.preset).toBe(m?.[1]);
  });
});
