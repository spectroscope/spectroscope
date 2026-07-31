// Card 88, web half: the reasoning control's brain. The capability record from
// GET /api/models/capabilities is the ONLY truth — no model-name list lives in
// the client. This suite pins the record parse, the seg-cell derivation (which
// cells exist, which are pressed, which are greyed and why), the click
// transitions (explicit choice / back to the model default), the per-model
// persistence store, and the set_reasoning wire frame.

import { beforeEach, describe, expect, it } from "vitest";
import {
  __setTestHooks,
  cellClick,
  choiceFor,
  fetchCapability,
  noneNote,
  orderedEfforts,
  parseCapability,
  reasoningFrame,
  segCells,
  setReasoningChoice,
  wireChoice,
  type ReasoningCapability,
  type ReasoningChoice,
} from "./reasoning";

const DEFAULT: ReasoningChoice = { mode: "default" };

/** A full record as the server serializes it (anthropic effort family). */
const OPUS: ReasoningCapability = {
  control: "effort",
  defaultOn: true,
  offSwitch: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  defaultEffort: "medium",
  offMaxEffort: "high",
  wire: "output_config.effort",
  source: "static",
};

/** An ollama think-toggle family. */
const TOGGLE: ReasoningCapability = {
  control: "toggle",
  defaultOn: true,
  offSwitch: true,
  efforts: [],
  defaultEffort: null,
  offMaxEffort: null,
  wire: "think",
  source: "api",
};

describe("parseCapability", () => {
  it("round-trips a full record", () => {
    expect(parseCapability(JSON.parse(JSON.stringify(OPUS)))).toEqual(OPUS);
  });

  it("fills missing fields with the none-record defaults", () => {
    const cap = parseCapability({ control: "toggle" });
    expect(cap).toEqual({
      control: "toggle",
      defaultOn: false,
      offSwitch: false,
      efforts: [],
      defaultEffort: null,
      offMaxEffort: null,
      wire: null,
      source: "static",
    });
  });

  it("rejects garbage (null / non-object / unknown control)", () => {
    expect(parseCapability(null)).toBeNull();
    expect(parseCapability("effort")).toBeNull();
    expect(parseCapability({ control: "sometimes" })).toBeNull();
  });

  it("drops non-string effort entries instead of rendering them", () => {
    const cap = parseCapability({ control: "effort", efforts: ["low", 3, "high"] });
    expect(cap?.efforts).toEqual(["low", "high"]);
  });
});

describe("orderedEfforts", () => {
  it("normalizes a descending record order to the canonical ladder", () => {
    // openrouter answers [max..low]; the seg must read low->max regardless.
    const cap = { ...OPUS, efforts: ["max", "xhigh", "high", "medium", "low"] };
    expect(orderedEfforts(cap)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps the record order when a token is unknown to the ladder", () => {
    const cap = { ...OPUS, efforts: ["deep", "shallow"] };
    expect(orderedEfforts(cap)).toEqual(["deep", "shallow"]);
  });

  it("ranks openai's 'none' rung below everything (their off travels as an effort)", () => {
    const cap = { ...OPUS, efforts: ["high", "none", "low"] };
    expect(orderedEfforts(cap)).toEqual(["none", "low", "high"]);
  });
});

describe("segCells — none", () => {
  it("a model without a reasoning control renders NO cells", () => {
    const none = parseCapability({ control: "none", defaultOn: true });
    expect(segCells(none as ReasoningCapability, DEFAULT)).toEqual([]);
  });
});

describe("segCells — toggle", () => {
  it("renders on/off, with the default state pressed", () => {
    const cells = segCells(TOGGLE, DEFAULT);
    expect(cells.map((c) => c.id)).toEqual(["on", "off"]);
    expect(cells[0].pressed).toBe(true); // defaultOn reflects as pressed 'on'
    expect(cells[1].pressed).toBe(false);
    expect(cells[1].disabled).toBe(false);
  });

  it("greys 'off' when no wire-level OFF exists", () => {
    const cells = segCells({ ...TOGGLE, offSwitch: false }, DEFAULT);
    expect(cells[1].disabled).toBe(true);
    expect(cells[1].reason).toBe("no-off");
  });

  it("an explicit off presses the off cell", () => {
    const cells = segCells(TOGGLE, { mode: "off" });
    expect(cells[0].pressed).toBe(false);
    expect(cells[1].pressed).toBe(true);
  });
});

describe("segCells — effort", () => {
  it("renders off + the ladder, model default pressed when nothing is chosen", () => {
    const cells = segCells(OPUS, DEFAULT);
    expect(cells.map((c) => c.id)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
    expect(cells.find((c) => c.id === "medium")?.pressed).toBe(true); // defaultEffort
    expect(cells.find((c) => c.id === "off")?.pressed).toBe(false);
  });

  it("omits the off cell entirely when the endpoint has no off state", () => {
    const cells = segCells({ ...OPUS, offSwitch: false, offMaxEffort: null }, DEFAULT);
    expect(cells.map((c) => c.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("an explicit effort presses that cell, not the default", () => {
    const cells = segCells(OPUS, { mode: "on", effort: "max" });
    expect(cells.find((c) => c.id === "max")?.pressed).toBe(true);
    expect(cells.find((c) => c.id === "medium")?.pressed).toBe(false);
  });

  it("greys off above offMaxEffort (opus-5: off is legal only at/below high)", () => {
    const at = (choice: ReasoningChoice): boolean =>
      segCells(OPUS, choice).find((c) => c.id === "off")?.disabled ?? false;
    expect(at({ mode: "on", effort: "xhigh" })).toBe(true);
    expect(at({ mode: "on", effort: "max" })).toBe(true);
    expect(at({ mode: "on", effort: "high" })).toBe(false);
    expect(at(DEFAULT)).toBe(false); // defaultEffort medium sits below the cap
    const capped = segCells(OPUS, { mode: "on", effort: "max" }).find((c) => c.id === "off");
    expect(capped?.reason).toBe("cap");
  });

  it("names the level the cap sits at — the greyed reason has to say WHICH", () => {
    // Live plate read "off only up to off": the tooltip interpolated the cell's
    // own id instead of the record's offMaxEffort.
    const capped = segCells(OPUS, { mode: "on", effort: "max" }).find((c) => c.id === "off");
    expect(capped?.capAt).toBe("high");
  });

  it("an opt-in model (defaultOn false, no defaultEffort) presses nothing by default", () => {
    const optIn = { ...OPUS, defaultOn: false, defaultEffort: null, offSwitch: false, offMaxEffort: null };
    expect(segCells(optIn, DEFAULT).some((c) => c.pressed)).toBe(false);
  });
});

describe("cellClick", () => {
  it("selects an effort as an explicit on+effort choice", () => {
    expect(cellClick(OPUS, DEFAULT, "high")).toEqual({ mode: "on", effort: "high" });
  });

  it("clicking the explicit effort again returns to the model default", () => {
    expect(cellClick(OPUS, { mode: "on", effort: "high" }, "high")).toEqual(DEFAULT);
  });

  it("off toggles between explicit off and the model default", () => {
    expect(cellClick(OPUS, DEFAULT, "off")).toEqual({ mode: "off" });
    expect(cellClick(OPUS, { mode: "off" }, "off")).toEqual(DEFAULT);
  });

  it("a toggle's on cell makes the default explicit, then clears it", () => {
    expect(cellClick(TOGGLE, DEFAULT, "on")).toEqual({ mode: "on" });
    expect(cellClick(TOGGLE, { mode: "on" }, "on")).toEqual(DEFAULT);
  });
});

describe("choice store", () => {
  beforeEach(() => {
    setReasoningChoice("anthropic", "claude-opus-5", { mode: "default" });
    setReasoningChoice("ollama", "qwen3:8b", { mode: "default" });
  });

  it("answers the default for a pair that never chose", () => {
    expect(choiceFor("anthropic", "claude-opus-5")).toEqual(DEFAULT);
  });

  it("remembers a choice per (provider, model) pair", () => {
    setReasoningChoice("anthropic", "claude-opus-5", { mode: "on", effort: "max" });
    expect(choiceFor("anthropic", "claude-opus-5")).toEqual({ mode: "on", effort: "max" });
    expect(choiceFor("ollama", "qwen3:8b")).toEqual(DEFAULT); // untouched pair
  });

  it("choosing the default forgets the entry", () => {
    setReasoningChoice("ollama", "qwen3:8b", { mode: "off" });
    setReasoningChoice("ollama", "qwen3:8b", { mode: "default" });
    expect(choiceFor("ollama", "qwen3:8b")).toEqual(DEFAULT);
  });
});

describe("reasoningFrame", () => {
  it("carries mode and effort on the wire", () => {
    expect(reasoningFrame({ mode: "on", effort: "low" })).toEqual({
      type: "set_reasoning",
      mode: "on",
      effort: "low",
    });
  });

  it("omits the effort key entirely when none is chosen", () => {
    expect(reasoningFrame({ mode: "off" })).toEqual({ type: "set_reasoning", mode: "off" });
    expect(reasoningFrame({ mode: "default" })).toEqual({ type: "set_reasoning", mode: "default" });
  });
});

describe("fetchCapability", () => {
  beforeEach(() => {
    __setTestHooks(null);
  });

  it("parses the endpoint's record and caches per (provider, model)", async () => {
    let calls = 0;
    __setTestHooks({
      fetchFn: (async () => {
        calls += 1;
        return { ok: true, json: async () => OPUS } as Response;
      }) as typeof fetch,
    });
    expect(await fetchCapability("anthropic", "claude-opus-5")).toEqual(OPUS);
    expect(await fetchCapability("anthropic", "claude-opus-5")).toEqual(OPUS);
    expect(calls).toBe(1);
    expect(await fetchCapability("anthropic", "claude-sonnet-5")).toEqual(OPUS);
    expect(calls).toBe(2); // a different pair is its own fetch
  });

  it("answers null (unknown) on a non-ok response — never a fake none-record", async () => {
    __setTestHooks({
      fetchFn: (async () => ({ ok: false, json: async () => ({}) }) as Response) as typeof fetch,
    });
    expect(await fetchCapability("anthropic", "err-model")).toBeNull();
  });

  it("answers null when the fetch itself throws", async () => {
    __setTestHooks({
      fetchFn: (async () => {
        throw new Error("down");
      }) as typeof fetch,
    });
    expect(await fetchCapability("ollama", "gone")).toBeNull();
  });

  it("does NOT cache a failed probe — a server that comes back gets asked again", async () => {
    let calls = 0;
    __setTestHooks({
      fetchFn: (async () => {
        calls += 1;
        if (calls === 1) throw new Error("server still booting");
        return { ok: true, json: async () => TOGGLE } as Response;
      }) as typeof fetch,
    });
    expect(await fetchCapability("ollama", "qwen3:8b")).toBeNull();
    expect(await fetchCapability("ollama", "qwen3:8b")).toEqual(TOGGLE);
    expect(calls).toBe(2);
    await fetchCapability("ollama", "qwen3:8b");
    expect(calls).toBe(2); // the record that ARRIVED is cached
  });
});

// The wire is the second place the record rules. A choice outlives the record
// that produced it (localStorage across releases, an API overlay that narrows
// the ladder), so the send site clamps against the CURRENT record: what the UI
// does not offer, the client does not spend.
describe("wireChoice", () => {
  it("spends nothing while the record is unknown — the seg shows nothing either", () => {
    expect(wireChoice(null, { mode: "on", effort: "high" })).toEqual(DEFAULT);
  });

  it("spends nothing on a model with no reasoning control", () => {
    const none = parseCapability({ control: "none", defaultOn: true }) as ReasoningCapability;
    expect(wireChoice(none, { mode: "off" })).toEqual(DEFAULT);
  });

  it("drops an off the record has no wire switch for", () => {
    expect(wireChoice({ ...TOGGLE, offSwitch: false }, { mode: "off" })).toEqual(DEFAULT);
    expect(wireChoice(TOGGLE, { mode: "off" })).toEqual({ mode: "off" });
  });

  it("drops an effort the record no longer lists, keeping the on", () => {
    // A stored 'xhigh' after the API overlay narrowed the ladder to low..high.
    const narrowed = { ...OPUS, efforts: ["low", "medium", "high"] };
    expect(wireChoice(narrowed, { mode: "on", effort: "xhigh" })).toEqual({ mode: "on" });
    expect(wireChoice(narrowed, { mode: "on", effort: "high" })).toEqual({ mode: "on", effort: "high" });
  });

  it("drops an effort on a toggle record — that field does not exist there", () => {
    expect(wireChoice(TOGGLE, { mode: "on", effort: "high" })).toEqual({ mode: "on" });
  });

  it("passes a legal choice through unchanged, by identity", () => {
    const choice: ReasoningChoice = { mode: "on", effort: "max" };
    expect(wireChoice(OPUS, choice)).toBe(choice);
  });
});

// control "none" renders no cells anywhere; in Settings it says so out loud,
// and defaultOn still carries whether a thinking stream will show up.
describe("noneNote", () => {
  it("reports a silent model when the record says it does not reason", () => {
    expect(noneNote({ ...TOGGLE, control: "none", defaultOn: false })).toBe("quiet");
  });

  it("reports a thinker with no switch when the record says it reasons anyway", () => {
    expect(noneNote({ ...TOGGLE, control: "none", defaultOn: true })).toBe("thinks");
  });
});
