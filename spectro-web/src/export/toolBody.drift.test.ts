// The drift gate for the tool bodies.
//
// This gap arrived silently: describeTool grew fifteen shapes, the export used
// its sibling helper (splitInput) and never its verdict, and every call kept
// printing as the JSON that describes it. Nothing failed. Nobody had to notice.
//
// So the writers are held to the union itself, read off disk the way
// themes.drift.test.ts reads the stylesheets. Two failures it exists to catch,
// and the second is the one a type system cannot:
//   - a kind added to toolViews with no writer here (the Writers record already
//     fails `tsc`, and this says so in words while the build is still running);
//   - a kind added WITH a writer that just draws the raw pair. That compiles, it
//     is green, and it is exactly the state this whole change came out of.
//
// The escape hatch is deliberate and narrow: DRAWN_AS_RAW is a list in the
// source, so "this one really is just its payload" is a decision someone wrote
// down and a reviewer can see.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ToolView } from "../components/toolViews";
import { describeTool } from "../components/toolViews";
import { DRAWN_AS_RAW, TOOL_HTML, toolViewHtml } from "./toolBody";

type Kind = ToolView["kind"];

/**
 * The kinds the ToolView union really declares, read out of its source.
 *
 * The union is parsed rather than derived from a value, because there IS no
 * value: `ToolView` is a type, and a type cannot be enumerated at runtime. A
 * hand-kept list next to it would be one more copy to drift.
 *
 * @return every `kind` literal of the union, in source order
 */
function declaredKinds(): string[] {
  const src = readFileSync(fileURLToPath(new URL("../components/toolViews.ts", import.meta.url)), "utf8");
  const start = src.indexOf("export type ToolView =");
  if (start < 0) throw new Error("toolViews.ts no longer declares `export type ToolView =`");
  // The declaration ends at the blank line that follows it; the union's own
  // members carry semicolons of their own, so a `;` is not the terminator.
  const end = src.indexOf("\n\n", start);
  const decl = src.slice(start, end < 0 ? undefined : end);
  return [...decl.matchAll(/kind:\s*"([a-z]+)"/g)].map((m) => m[1]);
}

/** One call per kind, real enough that describeTool actually reaches it. The
 *  record is typed by the union, so a new kind cannot be added without one. */
const FIXTURES: Record<Kind, { name: string; input: unknown; output?: string; isError?: boolean }> = {
  file: { name: "read_file", input: { path: "auth.ts" }, output: "line one\nline two" },
  write: { name: "write_file", input: { path: "a.ts", content: "x\n" }, output: "wrote" },
  edit: {
    name: "Edit",
    input: { path: "a.ts", old_string: "one", new_string: "two" },
    output: "1 replacement",
  },
  listing: { name: "list_dir", input: { path: "src" }, output: "a.ts\nb/\n" },
  matches: { name: "Grep", input: { pattern: "TODO" }, output: "a.ts:1: TODO\n" },
  command: { name: "Bash", input: { command: "npm run gate" }, output: "12 passed" },
  image: {
    name: "generate_image",
    input: { prompt: "a cat" },
    output: "Image generated with gemini: /demo/cat.png (1024x1024)",
  },
  skill: { name: "Skill", input: { name: "humanizer" }, output: "loaded" },
  mcp: { name: "mcp__ccd_session__mark_chapter", input: { title: "red" }, output: "ok" },
  agents: { name: "spawn_agents", input: { agents: [{ type: "reviewer", task: "read it" }] }, output: "ok" },
  plan: { name: "TodoWrite", input: { todos: [{ content: "ship", status: "pending" }] }, output: "ok" },
  question: {
    name: "AskUserQuestion",
    input: { questions: [{ question: "deploy?", options: [{ label: "yes" }] }] },
    output: 'answered: "deploy?"="yes".',
  },
  web: { name: "WebFetch", input: { url: "https://example.org" }, output: "the page" },
  workflow: { name: "Workflow", input: { script: "export const meta = { name: 'gate' };\n" }, output: "ok" },
  generic: { name: "odd_tool", input: { x: 1 }, output: "ok" },
};

const kinds = declaredKinds();
const ctx = (name: string) => ({ name, lang: "en" as const });

describe("every shape describeTool names, the export can draw", () => {
  it("finds the union in the source, so the check is real", () => {
    expect(kinds.length).toBeGreaterThan(10);
  });

  it("has one writer per declared kind, and no writer for a kind that is gone", () => {
    expect([...Object.keys(TOOL_HTML)].sort()).toEqual([...kinds].sort());
  });

  it("has one fixture per declared kind", () => {
    expect([...Object.keys(FIXTURES)].sort()).toEqual([...kinds].sort());
  });

  it.each(kinds)("the %s fixture really produces that kind", (kind) => {
    const f = FIXTURES[kind as Kind];
    expect(describeTool(f.name, f.input, f.output, f.isError === true).kind).toBe(kind);
  });
});

describe("no shape is quietly left as the raw pair", () => {
  // The failure this fires on: a new kind wired to the generic writer. It
  // compiles, it renders, and it is the gap this module was written to close.
  const raw = (kind: Kind): string => {
    const f = FIXTURES[kind];
    return toolViewHtml({ kind: "generic", input: f.input, output: f.output ?? "" }, ctx(f.name));
  };
  const drawn = (kind: Kind): string => {
    const f = FIXTURES[kind];
    return toolViewHtml(describeTool(f.name, f.input, f.output, f.isError === true), ctx(f.name));
  };

  it.each(kinds.filter((k) => !DRAWN_AS_RAW.includes(k as Kind)))("%s draws as itself", (kind) => {
    expect(
      drawn(kind as Kind),
      `${kind} renders exactly like the raw input/output pair — draw it, or say so in DRAWN_AS_RAW`,
    ).not.toBe(raw(kind as Kind));
    // And it drew something OF ITS OWN. Identity alone would pass a stub that
    // hands the view itself to the generic writer: different bytes, same
    // nothing. The `x-tv-` vocabulary is what a shape is made of, and the raw
    // pair carries none of it.
    expect(drawn(kind as Kind), `${kind} emits no shape markup, only the raw pair's`).toMatch(/x-tv-/);
  });

  it.each(DRAWN_AS_RAW)("%s is the raw pair on purpose", (kind) => {
    expect(drawn(kind)).toBe(raw(kind));
    expect(drawn(kind)).not.toContain("x-tv-");
  });

  it("draws every kind as something", () => {
    for (const kind of kinds) expect(drawn(kind as Kind).length, kind).toBeGreaterThan(0);
  });
});
