// House test style: pure logic only, no DOM/testing-library (the repo has none).
// The JSX is covered by the TypeScript build like every other component here;
// what can drift is the judgement the question view rests on — which answer a
// reader is shown. The file body's own judgement moved out with it, to
// bodyFace.ts and bodyFace.test.ts.

import { describe, expect, it } from "vitest";
import { answerFace } from "./ToolViewBody";
import type { AskedQuestion } from "./toolViews";

/** A single-choice question, answered by picking the first option. */
const asked = (over: Partial<AskedQuestion> = {}): AskedQuestion => ({
  header: "Merge",
  question: "Nach main mergen?",
  multiSelect: false,
  options: [
    { label: "Nach main mergen", description: "Direkt auf main", preview: null, chosen: true },
    { label: "Als PR", description: null, preview: null, chosen: false },
  ],
  answer: "Nach main mergen",
  answered: "option",
  ...over,
});

describe("answerFace", () => {
  it("shows only the marks when the answer names options", () => {
    // The marks ARE the answer: labelRun() only reports "option" when the answer
    // consists of labels, so printing the prose under them would say it twice.
    expect(answerFace(asked())).toEqual({ show: "marks" });
  });

  it("shows only the marks for a multi-select, however many were picked", () => {
    const q = asked({
      multiSelect: true,
      options: [
        { label: "Konzept-Dok + Karte 31", description: null, preview: null, chosen: true },
        { label: "Alles committen", description: null, preview: null, chosen: true },
        { label: "Noch mehr Lektionen", description: null, preview: null, chosen: false },
      ],
      answer: "Konzept-Dok + Karte 31,Alles committen",
    });
    expect(answerFace(q)).toEqual({ show: "marks" });
  });

  it("shows the person's own words when no option matched", () => {
    const typed = "sofort react flow, aber schreibe die CLAUDE.md und dokus mit zielen und startegie";
    expect(answerFace(asked({ answered: "text", answer: typed }))).toEqual({
      show: "words",
      text: typed,
    });
  });

  it("says the question was closed without choosing, in our own words", () => {
    // The harness writes the refusal into the answer slot as an instruction to
    // the model ("do not proceed, wait for next instruction"). Read by a person
    // that is a command, not an answer, so the chrome states the outcome and the
    // wire text stays in the raw face.
    const q = asked({ answered: "dismissed", answer: "[User dismissed — do not proceed]" });
    expect(answerFace(q)).toEqual({ show: "note", key: "tv.dismissed" });
  });

  it("says plainly that a question was never answered", () => {
    expect(answerFace(asked({ answered: "none", answer: null }))).toEqual({
      show: "note",
      key: "tv.unanswered",
    });
  });
});
