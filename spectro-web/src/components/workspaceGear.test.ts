import { describe, it, expect } from "vitest";
import { buildGearModel, overridableFields, parseBlockJson, parseLocalOverrideValue, rulesWith, rulesWithout, MODES } from "./workspaceGear";

const wsInfo = { sessionId: "s-1", path: "/Users/x/SpectroDemo", configured: true };
const view = { effective: { permissionMode: "ask" }, origins: {}, files: {},
  layers: { project: { autoApprove: ["run_command:git status*"] } }, workspace: "/Users/x/SpectroDemo" } as never;

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
  expect(parseBlockJson('{ "notes": { "command": "/x" } }')).toEqual(
    { ok: true, value: { notes: { command: "/x" } } });
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
  if (!blank.ok) expect(blank.error.length).toBeGreaterThan(0);
  const typo = parseLocalOverrideValue("thinking", "ture");
  expect(typo.ok).toBe(false);
  if (!typo.ok) expect(typo.error.length).toBeGreaterThan(0);
});

it("parseLocalOverrideValue parses whole numbers, refuses fractions and blanks", () => {
  expect(parseLocalOverrideValue("maxRetries", "3")).toEqual({ ok: true, value: 3 });
  expect(parseLocalOverrideValue("maxRetries", "5.7").ok).toBe(false);
  expect(parseLocalOverrideValue("compactionThreshold", "").ok).toBe(false);
  expect(parseLocalOverrideValue("model", "gpt-oss:20b")).toEqual({ ok: true, value: "gpt-oss:20b" });
  expect(parseLocalOverrideValue("model", "   ").ok).toBe(false);
});
