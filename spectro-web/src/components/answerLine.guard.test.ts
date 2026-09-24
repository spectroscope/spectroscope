// Card 374 criterion 2: ANSWER_LINE_MODES is the ONE list of readings. The
// dictionary and the builder are both checked THROUGH it, so a third reading
// added to the source turns this red before anything else is touched. No mode
// is typed out here, which is the difference between a guard and two copies of
// a hand list (CLAUDE.md section 8).

import { describe, expect, it } from "vitest";
import { ANSWER_LINE_MODES } from "../state/answerLine";
import { answerLineSegments, type AnswerLineTurn } from "../format";
import { dict } from "../i18n/i18n";

const TURN: AnswerLineTurn = {
  usage: {
    inputTokens: 812,
    outputTokens: 1040,
    cacheReadTokens: 40100,
    cacheCreationTokens: 1200,
  },
  durationMs: 8200,
  endTs: Date.UTC(2026, 8, 18, 9, 0, 8, 200),
  model: "claude-sonnet-5",
};

describe("the answer line's readings come from one list", () => {
  it("names the section from its own key, in both languages", () => {
    expect(dict["aline.title"].de).toBe("Antwortzeile");
    expect(dict["aline.title"].en).toBe("answer line");
    expect(dict["aline.title"].de).not.toBe(dict["disc.title"].de);
  });

  it("gives every reading a name and a hint", () => {
    expect(ANSWER_LINE_MODES.length).toBeGreaterThan(1);
    for (const m of ANSWER_LINE_MODES) {
      expect(dict[`aline.${m}`], `aline.${m}`).toBeDefined();
      expect(dict[`aline.${m}.hint`], `aline.${m}.hint`).toBeDefined();
    }
  });

  it("gives every reading its own segment list for one and the same answer", () => {
    const lists = ANSWER_LINE_MODES.map((m) =>
      answerLineSegments(m, TURN)
        .map((s) => s.kind)
        .join(","),
    );
    expect(new Set(lists).size).toBe(ANSWER_LINE_MODES.length);
  });
});
