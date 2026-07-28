import { describe, it, expect } from "vitest";
import {
  buildGearModel,
  overrideSpec,
  overrideSupport,
  overridableFields,
  parseBlockJson,
  parseLocalOverrideValue,
  rulesWith,
  rulesWithout,
  MODES,
} from "./workspaceGear";
import { PROVIDERS } from "./providerPickerMode";
import { IMAGE_MODELS } from "./imageModels";

const wsInfo = { sessionId: "s-1", path: "/Users/x/SpectroDemo", configured: true };
const view = {
  effective: { permissionMode: "ask" },
  origins: {},
  files: {},
  layers: { project: { autoApprove: ["run_command:git status*"] } },
  workspace: "/Users/x/SpectroDemo",
} as never;

describe("workspaceGear model", () => {
  it("builds the pinned model from the settings view", () => {
    const m = buildGearModel(view, wsInfo, "ask");
    expect(m.pinned).toBe(true);
    expect(m.workspaceName).toBe("SpectroDemo");
    expect(m.rules).toEqual(["run_command:git status*"]);
  });

  it("an unpinned session disables everything but the mode", () => {
    const m = buildGearModel(null, { ...wsInfo, configured: false }, "auto");
    expect(m.pinned).toBe(false);
    expect(m.mode).toBe("auto");
    expect(m.rules).toEqual([]);
  });

  it("the live mode wins over the file value", () => {
    expect(buildGearModel(view, wsInfo, "readonly").mode).toBe("readonly");
  });

  it("rule list ops trim, dedupe and refuse blanks", () => {
    expect(rulesWith(["a"], "  b ")).toEqual(["a", "b"]);
    expect(rulesWith(["a"], "a")).toEqual(["a"]);
    expect(rulesWith(["a"], "   ")).toEqual(["a"]);
    expect(rulesWithout(["a", "b"], "a")).toEqual(["b"]);
  });

  it("exposes exactly the three modes in order", () => {
    expect(MODES.map((m) => m.id)).toEqual(["ask", "auto", "readonly"]);
  });
});

it("local overrides offer only session-scoped scalars", () => {
  const fields = overridableFields();
  expect(fields).toContain("provider");
  expect(fields).toContain("maxRetries");
  expect(fields).not.toContain("workspace");
  expect(fields).not.toContain("logLevel");
  expect(fields).not.toContain("mcpServers");
});

it("parseBlockJson answers ok or a readable error", () => {
  expect(parseBlockJson('{ "notes": { "command": "/x" } }')).toEqual({
    ok: true,
    value: { notes: { command: "/x" } },
  });
  const bad = parseBlockJson("{ nope");
  expect(bad.ok).toBe(false);
  if (!bad.ok) expect(bad.error.length).toBeGreaterThan(0);
});

it("parseLocalOverrideValue coerces booleans strictly — only true/false pass", () => {
  expect(parseLocalOverrideValue("thinking", "true")).toEqual({ ok: true, value: true });
  expect(parseLocalOverrideValue("thinking", "TRUE")).toEqual({ ok: true, value: true });
  expect(parseLocalOverrideValue("promptCaching", "false")).toEqual({ ok: true, value: false });
  const blank = parseLocalOverrideValue("thinking", "  ");
  expect(blank.ok).toBe(false);
  if (!blank.ok) expect(blank.problem.key).toBe("wsg.local.err.blank");
  const typo = parseLocalOverrideValue("thinking", "ture");
  expect(typo.ok).toBe(false);
  if (!typo.ok) expect(typo.problem.key).toBe("wsg.local.err.bool");
});

it("parseLocalOverrideValue parses whole numbers, refuses fractions and blanks", () => {
  expect(parseLocalOverrideValue("maxRetries", "3")).toEqual({ ok: true, value: 3 });
  expect(parseLocalOverrideValue("maxRetries", "5.7").ok).toBe(false);
  expect(parseLocalOverrideValue("compactionThreshold", "").ok).toBe(false);
  expect(parseLocalOverrideValue("model", "gpt-oss:20b")).toEqual({ ok: true, value: "gpt-oss:20b" });
  expect(parseLocalOverrideValue("model", "   ").ok).toBe(false);
});

describe("local-override support (the owner cannot see today's value)", () => {
  // A view shaped like the real GET /api/settings answer: the fold's effective
  // config, per-field provenance, and the raw layers. Only `local` is this
  // popover's own scope; everything else is what an override would beat.
  const supportView = {
    effective: {
      provider: "anthropic",
      model: "claude-opus-5",
      baseUrl: "http://localhost:11434",
      thinking: false,
      imageProvider: "gemini",
      imageModel: null,
      maxRetries: 2,
      promptCaching: true,
      compactionThreshold: 100000,
      sttModel: null,
    },
    origins: {
      provider: { winner: "user", shadowed: ["env"] },
      model: { winner: "user", shadowed: [] },
      maxRetries: { winner: "defaults", shadowed: [] },
      thinking: { winner: "local", shadowed: ["user"] },
    },
    files: {},
    layers: { local: { thinking: false } },
    workspace: "/Users/x/SpectroDemo",
  } as never;

  it("answers each key's effective value, its provenance and whether local already sets it", () => {
    const model = overrideSupport("model", supportView);
    expect(model.effective).toBe("claude-opus-5");
    expect(model.origin).toEqual({ winner: "user", shadowed: [] });
    expect(model.setLocally).toBe(false);

    // The local scope already owns `thinking`: the effective value IS the
    // override, and the row must say so rather than offering to "beat" itself.
    const thinking = overrideSupport("thinking", supportView);
    expect(thinking.effective).toBe(false);
    expect(thinking.origin?.winner).toBe("local");
    expect(thinking.setLocally).toBe(true);
  });

  it("survives a view that has not loaded (or a server without provenance)", () => {
    const blank = overrideSupport("model", null);
    expect(blank.effective).toBe(null);
    expect(blank.origin).toBeUndefined();
    expect(blank.setLocally).toBe(false);
  });

  it("enumerates provider and imageProvider from the SAME lists the rest of the app uses", () => {
    expect(overrideSpec("provider").kind).toBe("enum");
    expect(overrideSpec("provider").options).toEqual([...PROVIDERS]);
    expect(overrideSpec("imageProvider").kind).toBe("enum");
    expect(overrideSpec("imageProvider").options).toEqual(Object.keys(IMAGE_MODELS));
  });

  it("types the booleans and bounds the numbers where the bound is real", () => {
    expect(overrideSpec("thinking").kind).toBe("boolean");
    expect(overrideSpec("promptCaching").kind).toBe("boolean");
    // RetryPolicy.from clamps a negative to 0, so 0 is the honest floor.
    expect(overrideSpec("maxRetries")).toMatchObject({ kind: "number", min: 0, max: null });
    // Compaction.maybeCompact runs when lastInputTokens >= threshold, so a
    // threshold of 0 would compact on an empty context, every single turn.
    expect(overrideSpec("compactionThreshold")).toMatchObject({ kind: "number", min: 1, max: null });
  });

  it("invents no constraint for a key whose legal set is not knowable from source", () => {
    for (const field of ["model", "baseUrl", "sttModel"]) {
      const spec = overrideSpec(field);
      expect(spec.kind).toBe("text");
      expect(spec.options).toEqual([]);
      expect(spec.min).toBe(null);
    }
  });

  it("every overridable key carries a spec and a description key", () => {
    for (const field of overridableFields()) {
      const spec = overrideSpec(field);
      expect(spec.field).toBe(field);
      expect(spec.descKey).toBe(`wsg.local.desc.${field}`);
    }
  });
});

describe("local-override validation names the problem", () => {
  it("refuses an unknown provider and says which ones exist", () => {
    const bad = parseLocalOverrideValue("provider", "gpt5");
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problem.key).toBe("wsg.local.err.enum");
      expect(bad.problem.params.value).toBe("gpt5");
      expect(bad.problem.params.allowed).toContain("anthropic");
    }
    expect(parseLocalOverrideValue("provider", "ollama")).toMatchObject({ ok: true, value: "ollama" });
  });

  it("refuses a number below its floor and names the floor", () => {
    const retries = parseLocalOverrideValue("maxRetries", "-1");
    expect(retries.ok).toBe(false);
    if (!retries.ok) {
      expect(retries.problem.key).toBe("wsg.local.err.min");
      expect(retries.problem.params.min).toBe("0");
    }
    const threshold = parseLocalOverrideValue("compactionThreshold", "0");
    expect(threshold.ok).toBe(false);
    if (!threshold.ok) expect(threshold.problem.params.min).toBe("1");
    expect(parseLocalOverrideValue("maxRetries", "0")).toEqual({ ok: true, value: 0 });
  });

  it("carries a translatable problem for every refusal, never a baked English string", () => {
    const cases: [string, string][] = [
      ["thinking", "ture"],
      ["maxRetries", "5.7"],
      ["model", "   "],
      ["imageProvider", "midjourney"],
    ];
    for (const [field, raw] of cases) {
      const out = parseLocalOverrideValue(field, raw);
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.problem.key.startsWith("wsg.local.err.")).toBe(true);
    }
  });
});
