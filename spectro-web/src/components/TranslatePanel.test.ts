// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The component itself is covered by the TypeScript build; the engine verdicts
// are what can drift. The stream reducer moved to state/translate.ts with the
// run itself — the panel does not own a translation any more, it starts one.

import { describe, expect, it } from "vitest";
import type { Engines } from "../state/translate";
import { canRun, preferredEngine, reasonKey } from "./TranslatePanel";

const ready: Engines = {
  local: { available: true, model: "qwen3-4b", label: "Qwen3 4B" },
  cloud: { available: true, provider: "anthropic", model: "claude-opus-5" },
};

describe("preferredEngine", () => {
  it("starts on the local model when it can run — nothing leaves the machine", () => {
    expect(preferredEngine(ready)).toBe("local");
  });

  it("falls back to the configured provider when there is no local model", () => {
    expect(preferredEngine({ ...ready, local: { available: false, reason: "no-model" } })).toBe("cloud");
  });

  it("offers nothing when neither engine can run", () => {
    expect(
      preferredEngine({
        local: { available: false, reason: "no-binary" },
        cloud: { available: false, reason: "needs-key" },
      }),
    ).toBeNull();
  });

  it("offers nothing before the probe has answered", () => {
    expect(preferredEngine(null)).toBeNull();
  });
});

describe("reasonKey — say why, never show a button that fails", () => {
  it("names each way an engine can be out", () => {
    expect(reasonKey({ available: false, reason: "no-binary" })).toBe("tr.out.noBinary");
    expect(reasonKey({ available: false, reason: "no-model" })).toBe("tr.out.noModel");
    expect(reasonKey({ available: false, reason: "needs-key" })).toBe("tr.out.needsKey");
    expect(reasonKey({ available: false, reason: "provider-is-local" })).toBe("tr.out.providerIsLocal");
  });

  it("has no reason for an available engine", () => {
    expect(reasonKey({ available: true, model: "qwen3-4b" })).toBeNull();
  });

  it("falls back to a generic line for a reason this build does not know", () => {
    expect(reasonKey({ available: false, reason: "sunspots" })).toBe("tr.out.generic");
    expect(reasonKey({ available: false })).toBe("tr.out.generic");
  });
});

describe("canRun", () => {
  it("needs an available engine and something to translate", () => {
    expect(canRun(ready, "local", 3)).toBe(true);
    expect(canRun(ready, "local", 0)).toBe(false);
    expect(canRun({ ...ready, local: { available: false, reason: "no-model" } }, "local", 3)).toBe(false);
    expect(canRun(null, "local", 3)).toBe(false);
  });
});
