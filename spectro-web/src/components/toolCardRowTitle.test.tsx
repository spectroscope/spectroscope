// Card 416, loop wave H3d: the folded row names its whole teaser as its title.
//
// The H3c browser stage read the folded card of a rewritten call at 390px as
// `run_command c…`: the row is one nowrap line with an ellipsis, and it had no
// title, so the rewrite was on the page (the DOM held the whole teaser) and out
// of reach of the eye. The title sits on the row's button itself, so it is the
// tooltip anywhere on the row. The button's name comes from its content, so by
// HTML-AAM 4.2 ("use the flat string of the title attribute if it was not used
// as the accessible name") the same text is its accessible description.
//
// House style: renderToStaticMarkup, no DOM. Only the head button is read.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "./ToolCard";
import { askAnswerTeaser, toolTeaser } from "./toolTeaser";
import type { ToolCard as ToolCardModel } from "../state/reducer";
import { t } from "../i18n/i18n";
import { setLang } from "../state/lang";

afterEach(() => setLang("en"));

const card = (patch: Partial<ToolCardModel>): ToolCardModel => ({
  callId: "c1",
  agentId: "main",
  name: "run_command",
  input: { command: "rtk ls -la", originalCommand: "ls -la", rewrittenBy: "rtk" },
  status: "ok",
  output: "755  .spectro/\n",
  durationMs: 0,
  permission: "allowed",
  startedAt: 1,
  ...patch,
});

/** The head button's opening tag, and the button whole. */
function head(model: ToolCardModel): { open: string; whole: string } {
  const html = renderToStaticMarkup(<ToolCard card={model} live={false} />);
  const m = /(<button[^>]*class="tool-card-head[^"]*"[^>]*>)[\s\S]*?<\/button>/.exec(html);
  if (m === null) throw new Error("no tool-card-head in the markup");
  return { open: m[1], whole: m[0] };
}

/** The title attribute of an opening tag, entities decoded, or null. */
function titleOf(openTag: string): string | null {
  const m = / title="([^"]*)"/.exec(openTag);
  if (m === null) return null;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const lines = (n: number): string => t("en", "tv.lines", { n });

describe("the folded row's title", () => {
  it("names the whole teaser of a rewritten call, both commands and the rewriter", () => {
    const model = card({});
    expect(titleOf(head(model).open)).toBe(
      "command: rtk ls -la · originalCommand: ls -la · rewrittenBy: rtk",
    );
    expect(titleOf(head(model).open)).toBe(toolTeaser(model.name, model.input, lines));
  });

  it("is the teaser the row prints, for any tool, not only run_command", () => {
    for (const model of [
      card({ name: "read_file", input: { path: "spectro-web/src/components/ToolCard.tsx" } }),
      card({ name: "grep", input: { pattern: "tool-card-head", path: "spectro-web/src" } }),
      card({ name: "write_file", input: { path: "notes.md", content: "one\ntwo\nthree\n" } }),
      card({ name: "run_command", input: { command: "echo hi" } }),
    ]) {
      const teaser = toolTeaser(model.name, model.input, lines);
      expect(teaser).not.toBe("");
      const { open, whole } = head(model);
      expect(titleOf(open)).toBe(teaser);
      expect(whole).toContain(`<span class="tool-preview">${teaser.replace(/&/g, "&amp;")}</span>`);
    }
  });

  it("carries a teaser the row clips, the ellipsis where the teaser has one", () => {
    const long = `echo ${"x".repeat(200)}`;
    const model = card({ input: { command: long } });
    const teaser = toolTeaser(model.name, model.input, lines);
    expect(teaser.endsWith("…")).toBe(true);
    expect(titleOf(head(model).open)).toBe(teaser);
  });

  it("names the whole answer on an answered question, as the answer's own tooltip does", () => {
    const model = card({
      name: "ask_user_question",
      input: {
        questions: [{ question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
      },
      output: 'The user answered: "Which store?"="SQLite". Continue with that answer.',
      permission: undefined,
    });
    const answer = askAnswerTeaser(model.name, model.input, model.output);
    expect(answer?.full).toBe("SQLite");
    expect(titleOf(head(model).open)).toBe("SQLite");
  });

  it("is left off when the teaser is empty, rather than set to nothing", () => {
    const model = card({ name: "list_sessions", input: {} });
    expect(toolTeaser(model.name, model.input, lines)).toBe("");
    expect(titleOf(head(model).open)).toBeNull();
  });

  it("words a counted body in the reader's language, as the row does", () => {
    const model = card({ name: "write_file", input: { path: "notes.md", content: "one\ntwo\nthree\n" } });
    setLang("de");
    const german = toolTeaser(model.name, model.input, (n) => t("de", "tv.lines", { n }));
    expect(german).not.toBe(toolTeaser(model.name, model.input, lines));
    expect(titleOf(head(model).open)).toBe(german);
  });
});
