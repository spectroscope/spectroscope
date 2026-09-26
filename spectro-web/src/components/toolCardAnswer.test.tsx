// Card 427, loop wave H3b: the folded row of an answered question names the
// answer.
//
// Measured in the H3a browser stage: after an answer in auto mode the
// ask_user_question card stayed folded and its row read the raw input
// (`[{"question":"Which store?",…`) beside "waited 6.6 s for you". The answer
// itself was one click away, in the open card.
//
// House style: renderToStaticMarkup, no DOM. The folded row is the card's first
// button, `.tool-card-head`; the body below it is in the markup too (it is
// hidden by CSS, not left out), so every check here reads the head alone.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolCard } from "./ToolCard";
import type { ToolCard as ToolCardModel } from "../state/reducer";
import { setLang } from "../state/lang";
import { dict } from "../i18n/i18n";

const STORE = {
  questions: [{ question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
};

const ask = (patch: Partial<ToolCardModel>): ToolCardModel => ({
  callId: "c1",
  agentId: "main",
  name: "ask_user_question",
  input: STORE,
  status: "ok",
  output: 'The user answered: "Which store?"="SQLite". Continue with that answer.',
  durationMs: 0,
  askWaitMs: 6_600,
  startedAt: 1,
  ...patch,
});

/** The folded row: the markup of the card's own head button, and nothing below it. */
function head(card: ToolCardModel, lang: "en" | "de" = "en"): string {
  setLang(lang);
  const html = renderToStaticMarkup(<ToolCard card={card} live={false} />);
  const m = /<button[^>]*class="tool-card-head[^"]*"[^>]*>[\s\S]*?<\/button>/.exec(html);
  if (m === null) throw new Error("no tool-card-head in the markup");
  return m[0];
}

/** The teaser the row shows for STORE when it names no answer: the input, as json. */
const INPUT_TEASER = "[{&quot;question&quot;:&quot;Which store?&quot;";

describe("the folded row of an answered question", () => {
  it("names the answer, in English and in German", () => {
    const en = head(ask({}), "en");
    expect(en).toContain(dict["ask.answerLabel"].en);
    expect(en).toContain(">SQLite<");
    const de = head(ask({}), "de");
    expect(de).toContain(dict["ask.answerLabel"].de);
    expect(de).toContain(">SQLite<");
  });

  it("names the answer in place of the raw input, and keeps the wait beside it", () => {
    const row = head(ask({}));
    expect(row).not.toContain(INPUT_TEASER);
    expect(row).toContain(dict["ask.waited"].en.replace("{d}", "6.6 s"));
  });

  it("shows the answer clipped to 140 characters and gives the whole answer as the tooltip", () => {
    const long = `Neither, ${"keep the files local and use DuckDB ".repeat(6)}end`;
    expect(long.length).toBeGreaterThan(140);
    const row = head(
      ask({ output: `The user answered: "Which store?"="${long}". Continue with that answer.` }),
    );
    expect(row).toContain(`title="${long}"`);
    expect(row).toContain(`<span class="tool-answer-text">${long.slice(0, 139)}…</span>`);
  });

  it("marks the row as one that carries an answer, the hook its narrow layout hangs on", () => {
    expect(head(ask({}))).toMatch(/class="tool-card-head tool-card-head--answered"/);
  });

  it("keeps the input teaser while the question is open or was released", () => {
    for (const card of [
      ask({ status: "pending", output: undefined, durationMs: undefined, askWaitMs: undefined }),
      ask({
        output:
          "unanswered: nobody answered this question. State the assumption you are proceeding with and carry on.",
      }),
    ]) {
      const row = head(card);
      expect(row).toContain(INPUT_TEASER);
      expect(row).not.toContain(dict["ask.answerLabel"].en);
      expect(row).toMatch(/class="tool-card-head"/);
    }
  });

  it("leaves every other tool's row as it was", () => {
    const row = head({
      callId: "c2",
      agentId: "main",
      name: "run_command",
      input: { command: "echo gated-427" },
      status: "ok",
      output: "gated-427",
      durationMs: 12,
      startedAt: 1,
    });
    expect(row).toContain("echo gated-427");
    expect(row).not.toContain(dict["ask.answerLabel"].en);
  });
});
