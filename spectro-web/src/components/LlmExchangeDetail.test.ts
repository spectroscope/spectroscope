// The open exchange pane's empty-side honesty: a side with no body and no
// lines gets a sentence that says WHY, never a fidelity sentence over silence.
// The recorder writes omitted:"ceiling" lines with no body at all, and a
// response that never closed has an all-default side — both looked identical
// to "nothing to say" before this pin.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { readExchangeDetail } from "../wire/llmWire";
import { emptySideKey } from "./LlmExchangeDetail";

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
