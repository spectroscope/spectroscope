// Card 265, criterion 8, against a REAL imported transcript rather than a
// fixture. The rule: a question read out of somebody else's session must carry
// no live control. It was answered months ago, by another person, on another
// machine — and the renderer that draws it keys on the TOOL NAME, so nothing
// about the drawing itself can tell the two apart.
//
// The fixture version of this test would have passed on a reducer that queued
// the question, because a fixture ends where the author decided it ends. A real
// file is where the shape that breaks it lives: an interrupted call whose
// tool_result never came.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript } from "./claudeCode";
import { initialState, normalizeReplay, reduceAll } from "../state/reducer";

/** The owner's own Claude Code transcripts. Absent on any other machine, and a
 *  test that cannot find its evidence says so instead of passing quietly. */
const CORPUS = join(homedir(), ".claude", "projects", "-Users-christopher-ezell-Spectroscope");

const withAnAsk = (): string | null => {
  if (!existsSync(CORPUS)) return null;
  for (const name of readdirSync(CORPUS)) {
    if (!name.endsWith(".jsonl")) continue;
    const text = readFileSync(join(CORPUS, name), "utf8");
    if (text.includes("AskUserQuestion")) return text;
  }
  return null;
};

describe("an imported question is read-only (card 265, criterion 8)", () => {
  const text = withAnAsk();

  it.skipIf(text === null)("carries no pending question after the import folds", () => {
    const events = parseTranscript(text as string);
    const folded = normalizeReplay(reduceAll(initialState, events));

    // The premise: this really is a transcript with an answered question in it.
    const asks = Object.values(folded.cards).filter((c) => c.name === "AskUserQuestion");
    expect(asks.length, "the corpus file must contain an AskUserQuestion call").toBeGreaterThan(0);

    // And the rule: nothing in it is waiting on anybody.
    expect(folded.pendingAsks).toEqual([]);
  });
});
