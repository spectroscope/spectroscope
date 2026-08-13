// The open exchange pane's empty-side honesty: a side with no body and no
// lines gets a sentence that says WHY, never a fidelity sentence over silence.
// The recorder writes omitted:"ceiling" lines with no body at all, and a
// response that never closed has an all-default side — both looked identical
// to "nothing to say" before this pin.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { readExchangeDetail } from "../wire/llmWire";
import { emptySideKey, llmReservePx } from "./LlmExchangeDetail";

/** One side the endpoint could answer with, with room to disagree per test. */
const side = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  fidelity: "bytes",
  body: "{}",
  lines: [],
  method: "POST",
  url: "https://api.anthropic.com/v1/messages",
  status: 200,
  error: "",
  aborted: false,
  ...over,
});

const readSideOf = (over: Record<string, unknown>, which: "request" | "response" = "request") => {
  const detail = readExchangeDetail({ request: side(over), response: side(over) });
  if (detail === null) throw new Error("fixture detail did not read");
  return detail[which];
};

describe("readExchangeDetail carries the omitted mark", () => {
  it("reads omitted through to the side shape instead of dropping it", () => {
    expect(readSideOf({ omitted: "ceiling", body: undefined }).omitted).toBe("ceiling");
  });

  it("defaults omitted to empty for a line that dropped nothing", () => {
    expect(readSideOf({}).omitted).toBe("");
  });
});

describe("emptySideKey", () => {
  it("stays silent while there is a body or lines to print", () => {
    expect(emptySideKey(readSideOf({}), false)).toBeNull();
    expect(emptySideKey(readSideOf({ body: undefined, lines: ["data: {}"] }), true)).toBeNull();
  });

  it("names the recording ceiling when the recorder dropped the body there", () => {
    const dropped = readSideOf({ body: undefined, omitted: "ceiling" });
    expect(emptySideKey(dropped, false)).toBe("trace.llm.omittedCeiling");
    // The ceiling sentence wins on the response side too — the body existed
    // and was measured; "never closed" would be the wrong story.
    expect(emptySideKey(dropped, true)).toBe("trace.llm.omittedCeiling");
  });

  it("says the exchange never closed for a null response side", () => {
    expect(emptySideKey(readSideOf({ body: undefined, fidelity: "" }), true)).toBe("trace.llm.noResponse");
  });

  it("claims nothing for an empty request side without an omitted mark", () => {
    // No sentence beats a guessed one: the recorder never omits a request
    // silently, so an empty request side is an older server's shape.
    expect(emptySideKey(readSideOf({ body: undefined, fidelity: "" }), false)).toBeNull();
  });
});

describe("the empty-side sentences exist, both languages", () => {
  it("has trace.llm.omittedCeiling and trace.llm.noResponse", () => {
    for (const key of ["trace.llm.omittedCeiling", "trace.llm.noResponse"]) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key]?.de, `${key}.de`).toBeTruthy();
      expect(dict[key]?.en, `${key}.en`).toBeTruthy();
    }
  });
});

// Card 211, fault B. This pane is the only detail in the trace that arrives
// late, and its growth used to land on a reader who had not moved: 82 px at
// first paint, 1,143 px six milliseconds later, measured in Chrome on the
// owner's session 20260810-230306-72871659, seq 5.5. The room is now held open
// from the frame's own line count — the number the collapsed row already prints
// as "20 lines · 2 kB · 4.5 s".
describe("the room an llm exchange holds open while it loads", () => {
  it("reserves from the frame's own line count on a response row", () => {
    // The owner's row: 20 lines. 107 px of chrome plus 20 lines at 52 px.
    expect(llmReservePx(20, "structured", "response")).toBe(107 + 20 * 52);
  });

  it("stops at the count the pane will actually paint", () => {
    // The structured face prints 20 lines and then says it stopped, so a
    // 36-line answer reserves what 20 lines need and not what 36 would.
    expect(llmReservePx(36, "structured", "response")).toBe(llmReservePx(20, "structured", "response"));
    // The wire face prints up to 200, and reserves accordingly.
    expect(llmReservePx(36, "wire", "response")).toBe(107 + 36 * 52);
    expect(llmReservePx(5000, "wire", "response")).toBeGreaterThan(llmReservePx(36, "wire", "response"));
  });

  it("holds nothing open for a pane that prints no lines", () => {
    // A request row shows the request; the answer's lines are not its subject.
    expect(llmReservePx(20, "structured", "request")).toBe(0);
    // The summary row shows both halves, and the structured face keeps the
    // received lines off it — so there is nothing to hold room for.
    expect(llmReservePx(20, "structured", "both")).toBe(0);
    // The wire face does print them under the summary row.
    expect(llmReservePx(20, "wire", "both")).toBeGreaterThan(0);
    expect(llmReservePx(20, "wire", "request")).toBe(0);
  });

  it("claims nothing when the frame states no lines", () => {
    // A body that was not streamed carries no line count. Deriving a height
    // from its byte size would be a guess wearing a measurement's clothes.
    for (const face of ["structured", "insight", "wire"] as const) {
      expect(llmReservePx(0, face, "response"), face).toBe(0);
      expect(llmReservePx(-3, face, "response"), face).toBe(0);
    }
  });

  it("never opens more than a ceiling of empty pane", () => {
    // A reservation is an estimate. An estimate that opens a screen and a half
    // of nothing is worse than the step it was meant to prevent.
    expect(llmReservePx(100_000, "wire", "response")).toBe(2400);
    expect(llmReservePx(100_000, "insight", "response")).toBe(2400);
  });
});
