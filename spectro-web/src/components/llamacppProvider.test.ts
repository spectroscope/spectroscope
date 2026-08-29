// Card 312: llama.cpp is offered wherever the other providers are offered.
//
// The UI half of the card is mostly "does the one mapping know about it" —
// SettingsPanel renders its address field from addressSpecFor and the header
// picker renders from PROVIDERS, so a provider missing from either is a
// provider a user cannot select or cannot point anywhere.

import { describe, expect, it } from "vitest";
import { addressSpecFor } from "./providerAddress";
import { PROVIDERS } from "./providerPickerMode";
import { read } from "../testkit/source";
import { t } from "../i18n/i18n";

describe("the picker offers llamacpp", () => {
  it("lists it as a selectable backend", () => {
    expect(PROVIDERS).toContain("llamacpp");
  });

  it("keeps it distinct from lmstudio", () => {
    // The whole point of the card: pointing lmstudio at a llama-server works
    // on the wire and loses the two things llama.cpp can actually answer.
    expect(PROVIDERS).toContain("lmstudio");
    expect(new Set(PROVIDERS).size).toBe(PROVIDERS.length);
  });
});

describe("llamacpp carries its own address", () => {
  it("maps to its own settings field", () => {
    expect(addressSpecFor("llamacpp")?.field).toBe("llamacppBaseUrl");
  });

  it("offers llama-server's documented default port as the placeholder", () => {
    // `--port PORT  port to listen (default: 8080)`, from the bundled binary.
    expect(addressSpecFor("llamacpp")?.preset).toBe("http://localhost:8080");
  });

  it("does not steal lmstudio's field", () => {
    // Bitten separately: a mapping that returned llamacppBaseUrl for every
    // provider would satisfy the assertion above on its own.
    expect(addressSpecFor("lmstudio")?.field).toBe("lmstudioBaseUrl");
    expect(addressSpecFor("ollama")?.field).toBe("ollamaBaseUrl");
  });

  it("still hides the field for the cloud providers", () => {
    expect(addressSpecFor("anthropic")).toBeNull();
    expect(addressSpecFor("openai")).toBeNull();
  });
});

describe("the settings page can explain the new field", () => {
  const reachTsx = read("./settingsReach.tsx", import.meta.url);
  const settingsTsx = read("./SettingsPanel.tsx", import.meta.url);

  it("declares llamacppBaseUrl in the reach table", () => {
    // Every field the provider block lists must have a row, or the block's
    // own sentence is assembled from an incomplete table.
    expect(reachTsx).toContain("llamacppBaseUrl");
  });

  it("names the field in the provider block's reach list", () => {
    expect(settingsTsx).toContain('"llamacppBaseUrl"');
  });
});

describe("the copy exists in both locales", () => {
  it("has an onboarding body for llama.cpp in EN and DE", () => {
    for (const lang of ["en", "de"] as const) {
      const copy = t(lang, "onb.llamacppBody");
      expect(copy).not.toBe("onb.llamacppBody");
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it("says in both locales that the model id is not a chooser", () => {
    for (const lang of ["en", "de"] as const) {
      const copy = t(lang, "onb.llamacppModelIsALabel");
      expect(copy).not.toBe("onb.llamacppModelIsALabel");
      expect(copy.length).toBeGreaterThan(20);
    }
  });

  it("does not ship the same string for both locales", () => {
    // A DE key filled with the EN sentence passes a "key exists" test and is
    // still an untranslated string on the page.
    expect(t("de", "onb.llamacppBody")).not.toBe(t("en", "onb.llamacppBody"));
    expect(t("de", "onb.llamacppModelIsALabel")).not.toBe(t("en", "onb.llamacppModelIsALabel"));
  });
});
