// Card 312: llama.cpp is offered wherever the other providers are offered.
//
// The UI half of the card is mostly "does the one mapping know about it" —
// SettingsPanel renders its address field from addressSpecFor and the header
// picker renders from PROVIDERS, so a provider missing from either is a
// provider a user cannot select or cannot point anywhere.

import { describe, expect, it } from "vitest";
import { addressSpecFor } from "./providerAddress";
import { PROVIDERS } from "./providerPickerMode";
import { SETTING_REACH } from "./settingsReach";

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
  it("declares llamacppBaseUrl in the reach table", () => {
    // The TABLE, not the file's text. Every field the provider block lists
    // must have a row here, or the block's own sentence is assembled from an
    // incomplete table — and reading the source for the name would go green on
    // a mention in a comment, which is the defect this card's server-side pin
    // was rewritten for. That the panel actually draws the field INSIDE the
    // provider block is walked by settingsReach.test.tsx, which derives the
    // address fields from the picker instead of typing them out.
    expect(SETTING_REACH.llamacppBaseUrl).toBe("next-session");
  });
});
