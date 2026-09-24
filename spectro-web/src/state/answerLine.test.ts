// Pins for the answer line's reading (card 374). Mirrors state/chatWidth.test.ts,
// plus the two things that file cannot reach: the parser and the notification.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANSWER_LINE_MODES,
  currentAnswerLine,
  parseAnswerLine,
  setAnswerLine,
  subscribeAnswerLine,
} from "./answerLine";

describe("answerLine", () => {
  beforeEach(() => {
    setAnswerLine("normal");
  });

  it("offers exactly the two readings, normal first", () => {
    expect(ANSWER_LINE_MODES).toEqual(["normal", "extended"]);
  });

  it("reads normal from an empty profile and from anything unknown", () => {
    expect(parseAnswerLine(null)).toBe("normal");
    expect(parseAnswerLine("wide")).toBe("normal");
    expect(parseAnswerLine("")).toBe("normal");
    expect(parseAnswerLine("normal")).toBe("normal");
    expect(parseAnswerLine("extended")).toBe("extended");
  });

  it("set + read round-trips", () => {
    setAnswerLine("extended");
    expect(currentAnswerLine()).toBe("extended");
  });

  it("notifies once on a change, never on a no-op, never after unsubscribe", () => {
    const seen = vi.fn();
    const off = subscribeAnswerLine(seen);
    setAnswerLine("extended");
    expect(seen).toHaveBeenCalledTimes(1);
    setAnswerLine("extended");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
    setAnswerLine("normal");
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
