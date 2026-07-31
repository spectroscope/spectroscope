// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The component itself is covered by the TypeScript build; the engine verdicts
// are what can drift. The stream reducer moved to state/translate.ts with the
// run itself — the panel does not own a translation any more, it starts one.

import { describe, expect, it } from "vitest";
import type { Engines, Passage, Plan, UnitKind } from "../state/translate";
import { canRun, costOf, preferredEngine, reasonKey, reasoningCost, roughly } from "./TranslatePanel";

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

/** A planned call, as planFor hands them to the sheet. */
const call = (kind: UnitKind, text: string, index = 0): Passage => ({
  unitId: `${index}:text`,
  pieceIndex: 0,
  kind,
  text,
});

const planOf = (passages: Passage[]): Plan => ({ units: [], passages });

describe("costOf — what the run will cost, before it starts", () => {
  it("counts the calls and the text in them", () => {
    const cost = costOf([call("answer", "the sky is blue"), call("thinking", "because light scatters", 1)]);
    expect(cost.calls).toBe(2);
    expect(cost.words).toBe(7);
    expect(cost.chars).toBe(37);
  });

  it("costs nothing when there is nothing to send", () => {
    expect(costOf([])).toEqual({ calls: 0, words: 0, chars: 0 });
  });

  it("does not count whitespace as text", () => {
    expect(costOf([call("answer", "  two\n\n  words \n")]).words).toBe(2);
  });
});

describe("reasoningCost — the number the checkbox is about", () => {
  it("counts the reasoning's share of a plan that carries it", () => {
    const plan = planOf([call("answer", "a b c"), call("thinking", "x y", 1), call("thinking", "z", 2)]);
    expect(reasoningCost(plan)).toEqual({ calls: 2, words: 3, chars: 4 });
  });

  it("is zero when the reader left the reasoning out — never a figure we do not have", () => {
    expect(reasoningCost(planOf([call("answer", "a b c")]))).toEqual({ calls: 0, words: 0, chars: 0 });
  });
});

describe("roughly — a size a reader can act on, not a byte count", () => {
  it("leaves a small count alone: rounding 7 words away would be a lie", () => {
    expect(roughly(0)).toBe(0);
    expect(roughly(7)).toBe(7);
    expect(roughly(99)).toBe(99);
  });

  it("rounds to the magnitude as the count grows", () => {
    expect(roughly(104)).toBe(100);
    expect(roughly(1234)).toBe(1200);
    expect(roughly(34567)).toBe(35000);
    // The measured reasoning of a real transcript, in words rather than chars.
    expect(roughly(205565)).toBe(206000);
  });
});
