// Card 584: what the start sheet decides about a row and its pick, without a
// renderer. A row serves when the server's check says so, or when the owner
// picked a model from a list that answered in that check; a private row is
// offered local providers only. Start sends only the picks that serve and
// differ from the playbook's model.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import {
  applyPick,
  blockingRows,
  cloudModel,
  offersFor,
  parsePickValue,
  pickValue,
  reasonLines,
  rowServes,
  startPicks,
} from "./playbookPicks";
import type { ModelCheck, ModelOffer, StartPreview } from "./playbookRuns";

function check(over: Partial<ModelCheck> & Pick<ModelCheck, "node">): ModelCheck {
  return {
    name: over.node,
    kind: "step",
    choice: "strong",
    privacy: "cheap",
    provider: "anthropic",
    model: "claude-opus-5-5",
    serves: false,
    viaProvider: null,
    viaModel: null,
    reason: "rejected-key",
    httpStatus: 401,
    keySource: "environment",
    ...over,
  };
}

const OFFERS: ModelOffer[] = [
  { provider: "ollama", kind: "local", models: ["qwen3:8b", "llama3:8b"] },
  { provider: "openai", kind: "cloud", models: ["gpt-5"] },
];

const PLAN = check({ node: "write_plan", name: "Write plan" });
const TIDY = check({
  node: "tidy",
  name: "Tidy",
  privacy: "private",
  provider: "ollama",
  model: "qwen3:8b",
  serves: true,
  reason: null,
  httpStatus: null,
  keySource: null,
});
const REVIEW = check({
  node: "plan_review",
  name: "Plan review",
  kind: "review",
  reason: "timeout",
  httpStatus: null,
});

const PREVIEW: StartPreview = {
  dir: "/pb",
  hash: "sha256:ab",
  findings: [],
  steps: [],
  skills: [],
  commands: [],
  refusals: [],
  models: [PLAN, TIDY, REVIEW],
  offers: OFFERS,
};

describe("what a row offers", () => {
  it("offers every provider whose list answered to a cheap row and local ones only to a private row", () => {
    expect(offersFor(PLAN, OFFERS).map((o) => o.provider)).toEqual(["ollama", "openai"]);
    expect(offersFor(TIDY, OFFERS).map((o) => o.provider)).toEqual(["ollama"]);
  });

  it("writes a pick as one option value and reads it back, a model that holds a bar included", () => {
    expect(pickValue(undefined)).toBe("");
    expect(pickValue({ provider: "ollama", model: "llama3:8b" })).toBe("ollama|llama3:8b");
    expect(parsePickValue("ollama|llama3:8b")).toEqual({ provider: "ollama", model: "llama3:8b" });
    expect(parsePickValue("openrouter|a/b|c")).toEqual({ provider: "openrouter", model: "a/b|c" });
    expect(parsePickValue("")).toBeNull();
    expect(parsePickValue("ollama|")).toBeNull();
    expect(parsePickValue("|m")).toBeNull();
  });
});

// Fix round (review D2): Ollama forwards a model tagged cloud, or with a tag
// ending in -cloud, to its cloud; a private row is never offered one.
describe("Ollama cloud models", () => {
  const WITH_CLOUD: ModelOffer[] = [
    { provider: "ollama", kind: "local", models: ["qwen3:8b", "minimax-m3:cloud", "gpt-oss:120b-cloud"] },
    { provider: "lmstudio", kind: "local", models: ["x:cloud"] },
    { provider: "llamacpp", kind: "local", models: [] },
  ];
  const ONLY_CLOUD: ModelOffer[] = [{ provider: "ollama", kind: "local", models: ["glm-5.3:cloud"] }];

  it("are named by the tag", () => {
    expect(cloudModel("ollama", "minimax-m3:cloud")).toBe(true);
    expect(cloudModel("ollama", "gpt-oss:120b-cloud")).toBe(true);
    expect(cloudModel("ollama", "qwen3:8b")).toBe(false);
    expect(cloudModel("ollama", "cloudy:7b")).toBe(false);
    expect(cloudModel("ollama", "cloud")).toBe(false);
    expect(cloudModel("lmstudio", "x:cloud"), "the naming is Ollama's").toBe(false);
  });

  it("are left out for a private row and offered to a cheap one", () => {
    expect(offersFor(TIDY, WITH_CLOUD).find((o) => o.provider === "ollama")?.models).toEqual(["qwen3:8b"]);
    expect(offersFor(PLAN, WITH_CLOUD).find((o) => o.provider === "ollama")?.models).toEqual([
      "qwen3:8b",
      "minimax-m3:cloud",
      "gpt-oss:120b-cloud",
    ]);
    expect(offersFor(TIDY, ONLY_CLOUD), "a provider with nothing left is not offered").toEqual([]);
  });

  it("cannot be picked for a private row", () => {
    expect(applyPick({}, TIDY, "ollama|minimax-m3:cloud", WITH_CLOUD)).toEqual({});
    expect(rowServes(TIDY, { provider: "ollama", model: "minimax-m3:cloud" }, WITH_CLOUD)).toBe(false);
    expect(applyPick({}, PLAN, "ollama|minimax-m3:cloud", WITH_CLOUD)).toEqual({
      write_plan: { provider: "ollama", model: "minimax-m3:cloud" },
    });
  });
});

describe("whether a row serves", () => {
  it("is the server's answer while nothing is picked", () => {
    expect(rowServes(PLAN, undefined, OFFERS)).toBe(false);
    expect(rowServes(TIDY, undefined, OFFERS)).toBe(true);
  });

  it("is true for a pick from a list that answered, and false for anything else", () => {
    expect(rowServes(PLAN, { provider: "ollama", model: "llama3:8b" }, OFFERS)).toBe(true);
    expect(rowServes(PLAN, { provider: "openai", model: "gpt-5" }, OFFERS)).toBe(true);
    expect(rowServes(PLAN, { provider: "ollama", model: "nope" }, OFFERS), "not in the list").toBe(false);
    expect(rowServes(PLAN, { provider: "anthropic", model: "claude-opus-5-5" }, OFFERS), "no list").toBe(
      false,
    );
    expect(
      rowServes(TIDY, { provider: "openai", model: "gpt-5" }, OFFERS),
      "a private row on the cloud",
    ).toBe(false);
  });
});

describe("what blocks Start", () => {
  it("is every row without a model that serves, steps and review checks alike", () => {
    expect(blockingRows(PREVIEW, {}).map((m) => m.node)).toEqual(["write_plan", "plan_review"]);
  });

  it("lets a pick that serves unblock its row, and only its row", () => {
    const picks = applyPick({}, PLAN, "ollama|llama3:8b", OFFERS);
    expect(blockingRows(PREVIEW, picks).map((m) => m.node)).toEqual(["plan_review"]);
    const both = applyPick(picks, REVIEW, "openai|gpt-5", OFFERS);
    expect(blockingRows(PREVIEW, both)).toEqual([]);
  });

  it("blocks nothing for a server that sends no model rows", () => {
    expect(blockingRows({ ...PREVIEW, models: undefined, offers: undefined }, {})).toEqual([]);
  });
});

describe("picking", () => {
  it("sets a pick, clears it with the playbook's default, and treats the playbook's own model as no pick", () => {
    const picked = applyPick({}, PLAN, "ollama|llama3:8b", OFFERS);
    expect(picked).toEqual({ write_plan: { provider: "ollama", model: "llama3:8b" } });
    expect(applyPick(picked, PLAN, "", OFFERS)).toEqual({});
    expect(applyPick(picked, TIDY, "ollama|qwen3:8b", OFFERS), "the default again is no pick").toEqual(
      picked,
    );
  });

  it("refuses a value that is not offered to the row", () => {
    expect(applyPick({}, TIDY, "openai|gpt-5", OFFERS)).toEqual({});
    expect(applyPick({}, PLAN, "ollama|invented", OFFERS)).toEqual({});
  });

  it("sends only the picks that serve, for rows of this preview", () => {
    const picks = {
      write_plan: { provider: "ollama", model: "llama3:8b" },
      tidy: { provider: "openai", model: "gpt-5" },
      gone: { provider: "ollama", model: "llama3:8b" },
    };
    expect(startPicks(PREVIEW, picks)).toEqual({ write_plan: { provider: "ollama", model: "llama3:8b" } });
    expect(startPicks(PREVIEW, {})).toEqual({});
  });
});

describe("the reason a row names", () => {
  const en = (lines: { key: string; vars: Record<string, string> }[]): string[] =>
    lines.map(({ key, vars }) =>
      Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, () => v), dict[key]?.en ?? key),
    );

  it("says a rejected key with its HTTP status and where the key came from, never the key", () => {
    expect(en(reasonLines(PLAN))).toEqual([
      "anthropic rejected the key (HTTP 401).",
      "The key comes from the environment of the app.",
    ]);
    expect(en(reasonLines({ ...PLAN, httpStatus: 403, keySource: "saved" }))).toEqual([
      "anthropic rejected the key (HTTP 403).",
      "The key is the one saved in the app.",
    ]);
  });

  it("has one line for every reason the server names", () => {
    const line = (reason: string, over: Partial<ModelCheck> = {}): string =>
      en(reasonLines({ ...PLAN, reason, httpStatus: null, keySource: null, ...over }))[0];
    expect(line("refused")).toBe("anthropic does not answer: the connection was refused.");
    expect(line("timeout")).toBe("anthropic does not answer: the check timed out.");
    expect(line("http-503", { httpStatus: 503 })).toBe(
      "anthropic answered the model list check with HTTP 503.",
    );
    expect(line("http-429")).toBe("anthropic answered the model list check with HTTP 429.");
    expect(line("bad-answer")).toBe("anthropic answered, but not with a model list.");
    expect(line("not-listed")).toBe("anthropic answers, but its model list does not have claude-opus-5-5.");
    expect(line("private-on-cloud")).toBe("This step is private, and anthropic is a cloud provider.");
    expect(line("needs-key")).toBe("No key is set for anthropic.");
    expect(line("no-key")).toBe("No key is set for anthropic.");
    expect(line("needs-signin")).toBe("anthropic is not signed in.");
    expect(line("needs-download")).toBe("The built-in runtime has no model on disk yet.");
    expect(line("unknown")).toBe("anthropic is not a provider this app knows.");
    expect(line("configured")).toBe("anthropic was not checked.");
    expect(line("check-timeout")).toBe("anthropic did not finish the check of its model list in time.");
    expect(line("check-error")).toBe("The check of the model list of anthropic broke off without an answer.");
    expect(line("something-new")).toBe("anthropic does not answer (something-new).");
  });

  it("names nothing for a row that serves, and the fallback when one serves in its place", () => {
    expect(reasonLines(TIDY)).toEqual([]);
    expect(en(reasonLines({ ...TIDY, viaProvider: "lmstudio", viaModel: "qwen3-8b" }))).toEqual([
      "Runs on the fallback lmstudio qwen3-8b.",
    ]);
  });

  it("has every key in both languages, with no dash", () => {
    const keys = Object.keys(dict).filter(
      (k) => k.startsWith("pb.run.why.") || k.startsWith("pb.run.keyFrom."),
    );
    expect(keys.length).toBeGreaterThanOrEqual(15);
    for (const k of [...keys, "pb.run.via", "pb.run.pickLabel", "pb.run.pickDefault", "pb.run.picked"]) {
      expect(dict[k]?.de, k).toBeTruthy();
      expect(dict[k]?.en, k).toBeTruthy();
      expect(`${dict[k].de} ${dict[k].en}`, k).not.toMatch(/[–—]/);
    }
  });
});
