import { describe, expect, it } from "vitest";
import {
  approvesExecution,
  composeEntry,
  entryReadingKey,
  rawEntries,
  withEntry,
  withoutEntry,
  type AllowlistEntry,
  type AllowlistView,
} from "./allowlistSetup";
import { dict } from "../i18n/i18n";

function entry(over: Partial<AllowlistEntry>): AllowlistEntry {
  return {
    raw: "read_file#read",
    tool: "read_file",
    wildcard: false,
    tier: "read",
    toolTier: "read",
    valuePrefix: null,
    inertBecause: null,
    ...over,
  };
}

describe("composeEntry", () => {
  it("always writes the tier out, even when read is the default", () => {
    // A permissions file whose lines only mean what they mean if you know a
    // rule is a permissions file nobody can audit by reading.
    expect(composeEntry("read_file", "read", "")).toBe("read_file#read");
  });

  it("writes a family wildcard with its tier", () => {
    expect(composeEntry("mcp__playwright__*", "read", "")).toBe("mcp__playwright__*#read");
  });

  it("appends the value prefix after the tier, and stars it once", () => {
    expect(composeEntry("run_command", "eval-execute", "git status")).toBe(
      "run_command#eval-execute:git status*",
    );
    expect(composeEntry("run_command", "eval-execute", "git status*")).toBe(
      "run_command#eval-execute:git status*",
    );
  });

  it("writes nothing without a tool or a tier", () => {
    expect(composeEntry("", "read", "")).toBe("");
    expect(composeEntry("read_file", "", "")).toBe("");
    expect(composeEntry("   ", "read", "")).toBe("");
  });
});

describe("withEntry / withoutEntry", () => {
  it("appends a new line and refuses a duplicate", () => {
    expect(withEntry(["read_file#read"], "write_file#write")).toEqual(["read_file#read", "write_file#write"]);
    expect(withEntry(["read_file#read"], "read_file#read")).toBeNull();
    expect(withEntry(["read_file#read"], "")).toBeNull();
  });

  it("removes by exact line, never by tool name", () => {
    const current = ["write_file#write:docs/*", "write_file#write:src/*"];
    expect(withoutEntry(current, "write_file#write:docs/*")).toEqual(["write_file#write:src/*"]);
    expect(withoutEntry(current, "write_file#write")).toBeNull();
  });
});

describe("entryReadingKey", () => {
  it("names each shape, and every key it can return exists in both languages", () => {
    const cases: AllowlistEntry[] = [
      entry({}),
      entry({ wildcard: true, tool: "mcp__playwright__", toolTier: null }),
      entry({ valuePrefix: "git status" }),
      entry({ tier: null, inertBecause: "a wildcard entry has to name its tier" }),
    ];
    expect(cases.map(entryReadingKey)).toEqual([
      "set.alExact",
      "set.alFamily",
      "set.alScoped",
      "set.alInert",
    ]);
    for (const key of cases.map(entryReadingKey)) {
      expect(dict[key], `missing dict key ${key}`).toBeDefined();
      expect(dict[key].de).not.toBe("");
      expect(dict[key].en).not.toBe("");
    }
  });

  it("calls an inert entry inert before anything else about it", () => {
    // An inert wildcard is both a wildcard and inert; what a reader needs first
    // is that it approves nothing.
    expect(entryReadingKey(entry({ wildcard: true, tier: null, inertBecause: "no tier" }))).toBe(
      "set.alInert",
    );
  });
});

describe("approvesExecution", () => {
  it("flags exactly the entries that approve running code", () => {
    expect(approvesExecution(entry({ tier: "eval-execute" }))).toBe(true);
    expect(approvesExecution(entry({ tier: "write" }))).toBe(false);
    expect(approvesExecution(entry({ tier: "read" }))).toBe(false);
    expect(approvesExecution(entry({ tier: null }))).toBe(false);
  });
});

describe("rawEntries", () => {
  const view: AllowlistView = {
    schemaVersion: 1,
    mapVersion: "2026-08-13",
    tiers: ["read", "write", "eval-execute"],
    scopes: { user: [entry({ raw: "read_file#read" })] },
    effective: [],
    files: {},
  };

  it("reads one scope's own lines, in file order", () => {
    expect(rawEntries(view, "user")).toEqual(["read_file#read"]);
  });

  it("answers an empty list for a scope with no entries and for no view at all", () => {
    expect(rawEntries(view, "project")).toEqual([]);
    expect(rawEntries(null, "user")).toEqual([]);
  });
});
