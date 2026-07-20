import { describe, it, expect, beforeEach } from "vitest";
import { readLegacyLocalStorage, clearLegacyLocalStorage, __setTestHooks } from "./graduation";

describe("localStorage graduation", () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    __setTestHooks({
      get: (k) => store[k] ?? null,
      remove: (k) => { delete store[k]; },
    });
  });

  it("collects both legacy keys into one patch", () => {
    store["forge:sessionDefaults"] = JSON.stringify({ provider: "openai", model: "gpt-5.4-nano", thinking: false });
    store["forge:lastWorkspace"] = "/Users/x/SpectroDemo";
    expect(readLegacyLocalStorage()).toEqual({
      provider: "openai", model: "gpt-5.4-nano", thinking: false, workspace: "/Users/x/SpectroDemo" });
  });

  it("answers null when nothing is stored", () => {
    expect(readLegacyLocalStorage()).toBeNull();
  });

  it("clear removes both keys", () => {
    store["forge:sessionDefaults"] = "{}";
    store["forge:lastWorkspace"] = "/x";
    clearLegacyLocalStorage();
    expect(store["forge:sessionDefaults"]).toBeUndefined();
    expect(store["forge:lastWorkspace"]).toBeUndefined();
  });
});
