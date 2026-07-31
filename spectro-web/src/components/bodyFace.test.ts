// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The component wiring is covered by the TypeScript build; what is worth pinning
// is the judgement — which bodies open as prose, and which .md bodies this
// parser would not reproduce.

import { describe, expect, it } from "vitest";
import { bodyFace, markdownBody } from "./bodyFace";
import { hlLangForPath } from "../workspace/highlight";

describe("markdownBody", () => {
  it("recognises a markdown file by its extension, whatever its case", () => {
    expect(markdownBody("notes.md")).toBe(true);
    expect(markdownBody("/Users/x/Spectroscope/CLAUDE.md")).toBe(true);
    expect(markdownBody("docs/README.MARKDOWN")).toBe(true);
  });

  it("leaves plain text alone — .txt has no markup to render", () => {
    expect(markdownBody("cli-usage.txt")).toBe(false);
    expect(markdownBody("src/App.tsx")).toBe(false);
  });

  it("does not claim a name that merely contains the word", () => {
    expect(markdownBody("md")).toBe(false);
    expect(markdownBody("markdown")).toBe(false);
    expect(markdownBody("notes.md.bak")).toBe(false);
  });

  it("leaves .mdx alone: its JSX is not markdown and would misparse", () => {
    expect(markdownBody("page.mdx")).toBe(false);
  });

  it("cannot disagree with the language table, which is the other path rule", () => {
    // hlLangForPath is the codebase's one path→language rule and it deliberately
    // does not know markdown (workspace/langs/markdown.test.ts says why), so it
    // cannot answer this question and this file has to. The day markdown joins
    // that table, this fails and the two rules get reconciled in one place
    // instead of quietly both claiming a path.
    for (const path of ["a.md", "b.markdown", "C.MD"]) {
      expect(markdownBody(path)).toBe(true);
      expect(hlLangForPath(path)).toBeNull();
    }
    for (const path of ["a.ts", "b.py", "c.json", "d.sh", "e.java"]) {
      expect(markdownBody(path)).toBe(false);
      expect(hlLangForPath(path)).not.toBeNull();
    }
  });
});

describe("bodyFace", () => {
  it("opens a markdown file rendered", () => {
    expect(bodyFace("docs/README.md", "# Title\n\nSome prose with **bold**.\n\n- one\n- two\n")).toEqual({
      rendered: true,
      note: null,
    });
  });

  it("leaves every other body on the bytes, whatever they look like", () => {
    // The same content under a name that is not markdown. A .txt of release
    // notes is full of hashes and dashes and is still a text file.
    const doc = "# Title\n\nSome prose with **bold**.\n";
    expect(bodyFace("notes.txt", doc)).toEqual({ rendered: false, note: null });
    expect(bodyFace("src/App.tsx", doc)).toEqual({ rendered: false, note: null });
    expect(bodyFace("page.mdx", doc)).toEqual({ rendered: false, note: null });
    expect(bodyFace("Makefile", doc)).toEqual({ rendered: false, note: null });
  });

  it("has nothing to render for an empty body", () => {
    expect(bodyFace("README.md", "")).toEqual({ rendered: false, note: null });
    expect(bodyFace("README.md", "\n \n")).toEqual({ rendered: false, note: null });
  });

  it("declines a body that indents, and says so", () => {
    // Measured against this parser: a four-space code block has no branch, so it
    // becomes a paragraph, and `.md p` sets no white-space, so the browser eats
    // the indentation.
    const doc = "# Title\n\nRun it:\n\n    const x = 1;\n    if (x) go();\n\nDone.\n";
    expect(bodyFace("docs/HOWTO.md", doc)).toEqual({ rendered: false, note: "tv.mdIndent" });
  });

  it("declines a code dump that happens to be named .md", () => {
    const dump = "function f(a, b) {\n  return a * b * 2;\n}\nconst s = arr.map(x => x1);\n";
    expect(bodyFace("dump.md", dump)).toEqual({ rendered: false, note: "tv.mdIndent" });
  });

  it("declines a body whose underscores would vanish, and says so", () => {
    // Measured: `SPECTRO_HUB_PORT` parses as SPECTRO + em(HUB) + PORT, so the two
    // underscores are gone from the screen. CommonMark forbids intraword
    // emphasis for exactly this reason; this parser does not.
    const doc = "Set SPECTRO_HUB_PORT and SPECTRO_OTLP_ENDPOINT before boot.\n";
    expect(bodyFace("docs/env.md", doc)).toEqual({ rendered: false, note: "tv.mdWord" });
  });

  it("declines a bold that spans a hard wrap", () => {
    // docs/RELEASE-PLAYBOOK.md, verbatim, and the case that decided this probe
    // was worth having. A paragraph is parsed one line at a time, so the opener
    // on the first line never finds its partner and every pair after it is off
    // by one. Measured render: `**Maven` and `desktop run kit**` sit on screen as
    // plain text while the bold lands on the two spans in between.
    const doc =
      "The end-to-end runbook for cutting a release: the two libraries to **Maven\n" +
      "Central**, one downloadable asset per app/frontend module to the **GitHub\n" +
      "release** (including the self-contained **desktop run kit**), and the website /\n" +
      "portal / docs install snippets flipped to the real coordinates.\n";
    expect(bodyFace("docs/RELEASE-PLAYBOOK.md", doc)).toEqual({ rendered: false, note: "tv.mdWord" });
  });

  it("renders the same sentence once the bold sits on one line", () => {
    const doc =
      "The end-to-end runbook for cutting a release: the two libraries to\n" +
      "**Maven Central**, one downloadable asset per module to the **GitHub release**.\n";
    expect(bodyFace("docs/RELEASE-PLAYBOOK.md", doc)).toEqual({ rendered: true, note: null });
  });

  it("keeps rendering a body whose underscores are inside code", () => {
    // A backtick makes the span a code leaf, so no emphasis is parsed and
    // nothing is dropped. This is how a real doc writes an env var.
    const doc = "# Env\n\nSet `SPECTRO_HUB_PORT` before boot.\n";
    expect(bodyFace("docs/env.md", doc)).toEqual({ rendered: true, note: null });
  });

  it("keeps rendering a fenced block, indentation and underscores and all", () => {
    // A fence is shown verbatim in a `pre`, so neither probe applies to what is
    // inside it — that is the one place the rendered face keeps every byte.
    const doc = "# Env\n\n```ts\nfunction f() {\n  return a_b + c_d;\n}\n```\n\nDone.\n";
    expect(bodyFace("docs/env.md", doc)).toEqual({ rendered: true, note: null });
  });

  it("still reads a body the clip cut in half", () => {
    // The clip lands anywhere, including inside a fence. The parser reports the
    // block as open and shows its text, so nothing is lost and the default holds.
    const doc = "# Title\n\n```ts\nconst x = 1;\nconst y = 2;\n... (truncated)";
    expect(bodyFace("docs/HOWTO.md", doc)).toEqual({ rendered: true, note: null });
  });

  it("names the indentation first when a body trips both probes", () => {
    const doc = "# Title\n\n    x_1 = x_2\n";
    expect(bodyFace("docs/HOWTO.md", doc)).toEqual({ rendered: false, note: "tv.mdIndent" });
  });

  it("reads a table and a quote as the prose they are", () => {
    const doc = "| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n\n1. first\n2. second\n";
    expect(bodyFace("docs/TABLE.md", doc)).toEqual({ rendered: true, note: null });
  });
});
