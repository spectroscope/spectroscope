// What a folded row is FOR: finding ONE call in forty. These tests fix the
// budget question — forty characters of a tool call, and which forty.

import { describe, expect, it } from "vitest";
import { toolTeaser } from "./toolTeaser";

/** The wording is the caller's (the card translates, the export carries its own
 *  labels); the tests read English. */
const lines = (n: number): string => `${n} lines`;

const SCRIPT = "export const meta = {\n  name: 'gate',\n};\n";

describe("toolTeaser", () => {
  it("gives a single field the whole row and drops its key", () => {
    expect(toolTeaser("Read", { path: "src/components/ToolCard.tsx" }, lines)).toBe(
      "src/components/ToolCard.tsx",
    );
    expect(toolTeaser("Bash", { command: "npm run gate" }, lines)).toBe("npm run gate");
  });

  it("keeps every key once there are two or more", () => {
    expect(toolTeaser("Grep", { pattern: "prettyJson", path: "src" }, lines)).toBe(
      "pattern: prettyJson · path: src",
    );
  });

  it("names a multi-line body by its size, never by its text", () => {
    expect(toolTeaser("Workflow", { name: "gate", script: SCRIPT }, lines)).toBe(
      "name: gate · script: 3 lines",
    );
  });

  it("keeps the key on a counted body even when it is the only field", () => {
    // A count describes the value instead of being it, and "14 lines" alone says
    // nothing about what has fourteen of them.
    expect(toolTeaser("Workflow", { script: SCRIPT }, lines)).toBe("script: 3 lines");
    expect(toolTeaser("run_command", { command: "cd x\nmake\n" }, lines)).toBe("command: 2 lines");
  });

  it("puts identity first and the body last, whatever order the model sent", () => {
    expect(toolTeaser("Write", { content: "a\nb\nc", path: "x.ts" }, lines)).toBe(
      "path: x.ts · content: 3 lines",
    );
  });

  it("shows a field that merely ends in a break, rather than counting it", () => {
    expect(toolTeaser("Write", { content: "one line\n" }, lines)).toBe("one line");
  });

  it("never emits a break, nor the escape that stood for one", () => {
    const teaser = toolTeaser("X", { a: "one\ntwo", b: "carriage\rreturn", c: "tab\there" }, lines);
    expect(teaser).not.toContain("\n");
    expect(teaser).not.toContain("\r");
    expect(teaser).not.toContain("\\n");
    expect(teaser).toContain("b: carriage return");
  });

  it("clips each value, so one long field cannot eat the fields after it", () => {
    const teaser = toolTeaser("mcp__srv__tool", { a: "x".repeat(30_000), b: "tail" }, lines);
    expect(teaser.length).toBeLessThanOrEqual(140);
    expect(teaser).toContain("…");
    expect(teaser).toContain("b: tail");
  });

  it("clips the whole row when there are many fields", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 40; i++) wide[`field${i}`] = `value${i}`;
    const teaser = toolTeaser("mcp__srv__tool", wide, lines);
    expect(teaser.length).toBeLessThanOrEqual(140);
    expect(teaser.startsWith("field0: value0 · field1: value1")).toBe(true);
  });

  it("summarises nothing as nothing — an empty payload adds no punctuation", () => {
    expect(toolTeaser("Skill", {}, lines)).toBe("");
  });

  it("says the key when the value is an empty string", () => {
    expect(toolTeaser("Write", { path: "", content: "a\nb" }, lines)).toBe("path: · content: 2 lines");
  });

  it("prints a payload that is not an object as itself, not as JSON", () => {
    expect(toolTeaser("X", "just a string", lines)).toBe("just a string");
    expect(toolTeaser("X", 42, lines)).toBe("42");
    expect(toolTeaser("X", null, lines)).toBe("null");
    expect(toolTeaser("X", undefined, lines)).toBe("");
    expect(toolTeaser("X", ["a", "b"], lines)).toBe('["a","b"]');
  });

  it("flattens a bare multi-line string, which has no key to be lifted under", () => {
    expect(toolTeaser("X", "first\nsecond", lines)).toBe("first second");
  });

  it("keeps a nested object as compact json — it has no breaks to lift", () => {
    expect(toolTeaser("Workflow", { args: { a: 1 }, name: "w" }, lines)).toBe('args: {"a":1} · name: w');
  });

  it("prints numbers and booleans as themselves", () => {
    expect(toolTeaser("Read", { path: "x", offset: 10, all: false }, lines)).toBe(
      "path: x · offset: 10 · all: false",
    );
  });
});
