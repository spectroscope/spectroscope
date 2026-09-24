// Card 245 put tokens per second on the answer's line. Card 374 gave that line
// two readings, and the rate rides in extended only, so a source text assertion
// that the rate is rendered would now be wider than the code. The promise and
// the coverage are made the same width here: the rate is pinned through the
// builder, in the mode where it appears, and the chat is pinned to render the
// builder at all, because a formatter nobody renders is a feature that shipped
// dead (the sessionRowDensity lesson). No DOM in this suite, and Chat cannot
// server render, so the consumer half is read off the source.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";
import { answerLineSegments, tokensPerSecond, type AnswerLineTurn } from "../format";

const chat = stripComments(read("./Chat.tsx", import.meta.url));

const TURN: AnswerLineTurn = {
  usage: { inputTokens: 7498, outputTokens: 84 },
  durationMs: 3300,
  endTs: Date.UTC(2026, 8, 18, 9, 0, 3, 300),
  model: "gpt-4o-mini",
};

describe("the answer line's rate, card 245 inside card 374's extended reading", () => {
  it("computes the rate from this turn's output tokens and measured duration", () => {
    const rate = answerLineSegments("extended", TURN).find((s) => s.kind === "rate");
    expect(rate?.value).toBe(tokensPerSecond(84, 3300));
  });

  it("keeps the rate out of the everyday reading, which is three numbers", () => {
    expect(answerLineSegments("normal", TURN).map((s) => s.kind)).toEqual(["in", "out", "duration"]);
  });

  it("renders the built segments instead of a hand assembled row", () => {
    expect(chat).toContain("answerLineSegments(answerLine, turn, lang)");
    expect(chat).not.toContain("tokensPerSecond(turn.usage.outputTokens, turn.durationMs)");
  });
});
