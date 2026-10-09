// Card 473: which session an expanded llm_exchange row reads its bodies from.
// A stored session reads the server's sidecar; an import used to read nothing
// and said "no llm-wire record exists". An import that holds its wire now
// names itself, so the trace and every surface that hands off to it open the
// exchange from the wire in the browser.

import { afterEach, describe, expect, it } from "vitest";
import { holdWires, releaseHeldWires } from "../wire/heldWire";
import { llmWireSessionOf } from "./wireSession";

const IMPORT = "import:spectroscope:s.jsonl";
const EMPTY_LLM = { index: [], pairs: new Map() };

afterEach(() => releaseHeldWires());

describe("llmWireSessionOf", () => {
  it("names an import that holds its llm wire", () => {
    holdWires(IMPORT, { llm: EMPTY_LLM });
    expect(
      llmWireSessionOf({ inFleet: false, replayId: IMPORT, canResume: false, liveSessionId: null }),
    ).toBe(IMPORT);
  });

  it("names nothing for an import that holds no wire", () => {
    expect(
      llmWireSessionOf({ inFleet: false, replayId: IMPORT, canResume: false, liveSessionId: null }),
    ).toBeNull();
  });

  it("keeps the stored session, the live session and the fleet as they were", () => {
    expect(
      llmWireSessionOf({ inFleet: false, replayId: "20261009-1", canResume: true, liveSessionId: null }),
    ).toBe("20261009-1");
    expect(
      llmWireSessionOf({ inFleet: false, replayId: null, canResume: false, liveSessionId: "live-1" }),
    ).toBe("live-1");
    holdWires(IMPORT, { llm: EMPTY_LLM });
    expect(
      llmWireSessionOf({ inFleet: true, replayId: IMPORT, canResume: false, liveSessionId: null }),
    ).toBeNull();
  });
});
