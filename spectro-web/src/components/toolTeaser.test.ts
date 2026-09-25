// What a folded row is FOR: finding ONE call in forty. These tests fix the
// budget question — forty characters of a tool call, and which forty.

import { describe, expect, it } from "vitest";
import { askAnswerTeaser, toolTeaser } from "./toolTeaser";

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

// Card 427, loop wave H3b: a folded ask names what the person answered. Before
// this, an answered question read `[{"question":"Which store?",…` beside
// "waited 6.6 s for you", and the answer was one click away in the open card.
describe("askAnswerTeaser", () => {
  const STORE = {
    questions: [{ question: "Which store?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
  };
  /** The prose our own tool returns, character for character (AskUserQuestionTool.reply). */
  const answered = (question: string, answer: string): string =>
    `The user answered: "${question}"="${answer}". Continue with that answer.`;

  it("names the option chosen, off the result our own tool writes", () => {
    expect(askAnswerTeaser("ask_user_question", STORE, answered("Which store?", "SQLite"))).toEqual({
      text: "SQLite",
      full: "SQLite",
    });
  });

  it("names a reply in the person's own words as they wrote it", () => {
    expect(
      askAnswerTeaser("ask_user_question", STORE, answered("Which store?", "Neither, use DuckDB")),
    ).toEqual({
      text: "Neither, use DuckDB",
      full: "Neither, use DuckDB",
    });
  });

  it("joins the answers of an imported batch in the order the questions were asked", () => {
    const a = "Which store?";
    const b = "Ship it now?";
    const input = {
      questions: [
        { question: a, options: [{ label: "Postgres" }, { label: "SQLite" }] },
        { question: b, options: [{ label: "Yes" }, { label: "Later" }] },
      ],
    };
    const out = `Your questions have been answered: "${b}"="Later", "${a}"="Postgres". You can now continue with these answers in mind.`;
    expect(askAnswerTeaser("AskUserQuestion", input, out)).toEqual({
      text: "Postgres · Later",
      full: "Postgres · Later",
    });
  });

  it("keeps an answer to one line and inside the row's budget", () => {
    const long = `${"word ".repeat(40)}end`;
    const got = askAnswerTeaser(
      "ask_user_question",
      STORE,
      answered("Which store?", `first\nsecond ${long}`),
    );
    expect(got).not.toBeNull();
    expect(got?.text).not.toContain("\n");
    expect(got?.text.startsWith("first second word")).toBe(true);
    expect(got?.text.length).toBeLessThanOrEqual(140);
    expect(got?.text.endsWith("…")).toBe(true);
  });

  it("keeps the whole answer on one line beside the clipped one, for the row's tooltip", () => {
    const long = `${"word ".repeat(40)}end`;
    const got = askAnswerTeaser(
      "ask_user_question",
      STORE,
      answered("Which store?", `first\nsecond ${long}`),
    );
    expect(got?.full).toBe(`first second ${long}`);
    expect(got?.full.length).toBeGreaterThan(140);
    expect(got?.text).toBe(`${got?.full.slice(0, 139)}…`);
  });

  it("has nothing to name while the question is open, released or dismissed", () => {
    expect(askAnswerTeaser("ask_user_question", STORE, undefined)).toBeNull();
    expect(askAnswerTeaser("ask_user_question", STORE, "")).toBeNull();
    expect(
      askAnswerTeaser(
        "ask_user_question",
        STORE,
        "unanswered: nobody answered this question. State the assumption you are proceeding with and carry on.",
      ),
    ).toBeNull();
    expect(
      askAnswerTeaser("AskUserQuestion", STORE, answered("Which store?", "[User dismissed this question]")),
    ).toBeNull();
  });

  it("has nothing to name for a tool that is not a question", () => {
    expect(
      askAnswerTeaser("run_command", { command: "echo SQLite" }, answered("Which store?", "SQLite")),
    ).toBeNull();
  });
});
