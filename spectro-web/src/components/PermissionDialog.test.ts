// House test style: pure logic only, no DOM (the repo has no testing-library).
// What is pinned here is the RULE the gate's lead line follows, because getting
// it wrong is how a person approves the wrong thing: the lead names the resource
// a call touches, and it is never a fold of the call's body.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { gateSubject } from "./PermissionDialog";

describe("gateSubject", () => {
  it("leads a write with the file it will touch, never with the content", () => {
    expect(gateSubject("Write", { path: "/etc/hosts", content: "127.0.0.1 a\n127.0.0.1 b\n" })).toEqual({
      labelKey: "tv.file",
      text: "/etc/hosts",
    });
  });

  it("reads the path under the other vocabularies too", () => {
    expect(gateSubject("create_file", { filePath: "src/a.ts", content: "x\ny" })?.text).toBe("src/a.ts");
    expect(gateSubject("Read", { file_path: "src/b.ts" })?.text).toBe("src/b.ts");
  });

  it("leads an edit with its path", () => {
    const subject = gateSubject("Edit", { path: "pom.xml", old_string: "a\nb", new_string: "c\nd" });
    expect(subject).toEqual({ labelKey: "tv.file", text: "pom.xml" });
  });

  it("has no lead for a command — folded onto one line it stops being the command", () => {
    expect(gateSubject("Bash", { command: "# keep the cache\nrm -rf build" })).toBeNull();
  });

  it("leads a fetch with its url and a search with its query", () => {
    expect(gateSubject("WebFetch", { url: "https://example.com/a" })).toEqual({
      labelKey: "tv.fetch",
      text: "https://example.com/a",
    });
    expect(gateSubject("WebSearch", { query: "spectroscope" })).toEqual({
      labelKey: "tv.search",
      text: "spectroscope",
    });
  });

  it("leads an MCP call with the server and the tool it reaches", () => {
    expect(gateSubject("mcp__Claude_Browser__navigate", { url: "https://x" })).toEqual({
      labelKey: "tv.mcp",
      text: "Claude_Browser · navigate",
    });
  });

  it("invents no lead for a payload that names no resource", () => {
    expect(gateSubject("Weird", { a: 1, b: [2] })).toBeNull();
    expect(gateSubject("update_plan", { steps: [{ text: "one" }] })).toBeNull();
    expect(gateSubject("Write", { content: "no path here" })).toBeNull();
  });

  it("survives a payload that is not an object at all", () => {
    expect(gateSubject("Bash", "rm -rf build")).toBeNull();
    expect(gateSubject("Write", null)).toBeNull();
  });

  it("names only labels the dictionary already carries", () => {
    const calls: [string, unknown][] = [
      ["Write", { path: "a", content: "x\ny" }],
      ["Edit", { path: "a", old_string: "x", new_string: "y" }],
      ["Read", { path: "a" }],
      ["list_dir", { path: "a" }],
      ["WebFetch", { url: "u" }],
      ["WebSearch", { query: "q" }],
      ["mcp__s__t", {}],
      ["Skill", { name: "humanizer" }],
      ["view_image", { path: "a.png" }],
    ];
    const labels = calls
      .map(([name, input]) => gateSubject(name, input)?.labelKey)
      .filter((k) => k !== undefined);
    expect(labels.length).toBe(calls.length);
    for (const key of labels) expect(dict[key], key).toBeDefined();
  });
});
