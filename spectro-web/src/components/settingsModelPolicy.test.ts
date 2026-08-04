// Card 121: opening the Settings page silently rewrote a configured model.
//
// The auto-pick that snaps a stale model to a provider's real list persists
// through putSettings, so whether it may run is a WRITE decision, and write
// decisions on this page belong to the operator. The policy under test draws
// that line: looking writes nothing, choosing may snap.

import { describe, expect, it } from "vitest";
import { modelAbsentFromList, settingsMayAutoPick } from "./settingsModelPolicy";

describe("settingsMayAutoPick", () => {
  it("refuses on open — the panel was opened to LOOK, and looking must not write", () => {
    // The measured card-121 failure: open Settings with claude-3-opus configured
    // and absent from the fetched list, and settings.json flips to the list's
    // first entry. The open cause must never reach putSettings.
    expect(settingsMayAutoPick("open")).toBe(false);
  });

  it("allows after a provider gesture — choosing ollama may snap opus to a real model", () => {
    // The legitimate use the picker comment defends: a cloud model carried onto
    // a local backend is nonsense as its default. That snap survives, but only
    // once the operator actually changed the provider in the panel.
    expect(settingsMayAutoPick("gesture")).toBe(true);
  });
});

describe("modelAbsentFromList", () => {
  it("marks a configured model the fetched list does not carry", () => {
    expect(modelAbsentFromList("claude-3-opus", ["claude-opus-4-8", "claude-sonnet-5"])).toBe(true);
  });

  it("does not mark a model the list carries", () => {
    expect(modelAbsentFromList("claude-sonnet-5", ["claude-opus-4-8", "claude-sonnet-5"])).toBe(false);
  });

  it("says nothing on an empty list — no key or backend down proves absence of nothing", () => {
    // The card's sibling case: an empty list must never cause a write, and it
    // must not shout "not offered" either — the provider simply did not answer.
    expect(modelAbsentFromList("claude-3-opus", [])).toBe(false);
  });

  it("never marks an empty selection", () => {
    expect(modelAbsentFromList("", ["claude-opus-4-8"])).toBe(false);
  });
});
