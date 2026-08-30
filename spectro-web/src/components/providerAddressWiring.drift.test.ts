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
import { PROVIDERS } from "./providerPickerMode";

const settingsTsx = read("./SettingsPanel.tsx", import.meta.url);
const pickerTsx = read("./ProviderPicker.tsx", import.meta.url);
const fieldTsx = read("./providerModelField.tsx", import.meta.url);
const onboardingTsx = read("./Onboarding.tsx", import.meta.url);
const appTsx = read("../App.tsx", import.meta.url);

/** The onboarding source with its whitespace collapsed. A sentence in JSX is
 *  laid out by prettier, so a phrase lands wherever the print width puts it:
 *  card 312 round 5 named the three keyless backends by id in that paragraph
 *  and the reflow split "anderen Maschine" across two lines, which reads as
 *  "the German half is gone". The claim below is that the sentence is there,
 *  never that it fits on one source line. */
const onboardingProse = onboardingTsx.replace(/\s+/g, " ");

describe("the settings page carries the address beside the provider that needs it", () => {
  it("renders the field from the one provider→field mapping", () => {
    // addressSpecFor is the single source: the providers it names get their
    // field (preset as placeholder), every other provider hides it.
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
    expect(onboardingProse).toContain("anderen Maschine");
    expect(onboardingProse).toContain("another machine");
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

  // Every address owner, not lmstudio alone: this was a single literal when
  // card 312 added a third owner with a preset of its own (8080), and a guard
  // naming one provider cannot notice a second mirror going stale. The preset
  // is what the settings field shows as its PLACEHOLDER, so a drifted one is a
  // wrong address printed to the operator in the calmest possible voice.
  //
  // Scoped to the method body on purpose. A file-wide /case "ollama" -> "…"/
  // matches `case "ollama" -> "qwen3";` in defaultModelFor twenty lines up and
  // compares a preset against a MODEL ID — measured while writing this, and it
  // would have been green in exactly one direction.
  const presetBody = /static String openAiCompatPreset\([^)]*\)\s*\{([\s\S]*?)\n    \}/.exec(
    spectroConfigJava,
  )?.[1];
  const ollamaFallback = /effectiveOllamaBaseUrl\([\s\S]*?return "([^"]+)";\s*\}/.exec(
    spectroConfigJava,
  )?.[1];

  it("finds both server rules it is about to read", () => {
    expect(presetBody, "openAiCompatPreset is no longer a switch this guard can read").toBeTruthy();
    expect(ollamaFallback, "effectiveOllamaBaseUrl no longer ends in a literal").toBeTruthy();
  });

  it.each(PROVIDERS.filter((p) => addressSpecFor(p) !== null))(
    "mirrors the server's preset for %s",
    (provider) => {
      // Which rule supplies this owner's preset is asked of the server, not
      // assumed: the openai-compat road for the ones its switch names, and
      // effectiveOllamaBaseUrl's own trailing literal for ollama, which has no
      // row there at all.
      const row = new RegExp(`case "${provider}" -> "([^"]+)";`).exec(String(presetBody));
      expect(addressSpecFor(provider)?.preset).toBe(row ? row[1] : ollamaFallback);
    },
  );

  it("reads more than one preset out of the openai-compat switch", () => {
    const owners = PROVIDERS.filter((p) => addressSpecFor(p) !== null);
    const fromSwitch = owners.filter((p) => new RegExp(`case "${p}" -> "`).test(String(presetBody)));
    // Two, so the walk above cannot quietly shrink to ollama's single arm and
    // stop reading openAiCompatPreset at all.
    expect(fromSwitch.length, `only ${fromSwitch} take the openai-compat road`).toBeGreaterThan(1);
  });
});

// ── Card 311, review: the fourth face, beside the field that loses ───────────
// The general baseUrl is edited in the composer gear (it is one of
// workspaceGear's machine-local override keys), and that is where the reported
// symptom starts: the operator types his address there and every request keeps
// going elsewhere. All three surfaces this card served sit beside the WINNING
// field, so the gear said nothing at all.

describe("the composer gear warns beside the general address it edits", () => {
  const gearTsx = read("./ComposerGear.tsx", import.meta.url);
  const gearCss = read("../styles/workspace-gear.css", import.meta.url);

  it("still offers baseUrl as an editable key — the note exists because it does", () => {
    expect(read("./workspaceGear.ts", import.meta.url)).toContain('spec("baseUrl", "text")');
  });

  it("derives the note from the one shared function, on the SELECTED field", () => {
    // The gear's editor shows one key at a time, so the note has to follow
    // localField rather than the popover being open.
    expect(gearTsx).toContain("generalAddressIgnoredNote(");
    expect(gearTsx).toMatch(/generalAddressIgnoredNote\(\s*localField/);
  });

  it("renders the resolved sentence, under a rule the stylesheet declares", () => {
    // Boundaries on both halves, for the reason the override note's pair
    // carries them: a class name is a substring of its own typo.
    expect(gearTsx).toMatch(/wsg-local-note--address["\s]/);
    expect(gearCss).toMatch(/\.wsg-local-note--address\s*[,{]/);
  });

  it("says the whole sentence in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const sentence = t(lang, "wsg.local.addressIgnored", {
        provider: "lmstudio",
        field: "lmstudioBaseUrl",
        addr: "http://gpu-box:1234",
        winner: t(lang, "set.layer.user"),
      });
      expect(sentence, lang).not.toBe("wsg.local.addressIgnored");
      expect(sentence, lang).not.toMatch(/\{[a-z]+\}/i);
      expect(sentence, lang).toContain("http://gpu-box:1234");
      expect(sentence.split("lmstudioBaseUrl").join(""), lang).toContain("lmstudio");
    }
  });
});
