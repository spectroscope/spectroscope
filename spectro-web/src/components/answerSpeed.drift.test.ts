// Card 245: tokens per second stands in the answer's meta row, beside the in
// and out counts — the owner's words. The math itself is pinned in
// format.test.ts; this file pins the CONSUMER, because a formatter nobody
// renders is a feature that shipped dead (the sessionRowDensity lesson). No
// DOM in this suite, and Chat cannot server-render (its input hooks touch
// browser APIs), so the row is read off the source.

import { describe, expect, it } from "vitest";
import { read, stripComments } from "../testkit/source";

const chat = stripComments(read("./Chat.tsx", import.meta.url));

describe("the answer meta row — tokens per second rides beside in and out", () => {
  it("computes the rate from the same turn's usage and measured duration", () => {
    expect(chat).toContain("tokensPerSecond(turn.usage.outputTokens, turn.durationMs)");
  });

  it("renders the rate after the out count and before the wall clock", () => {
    const outSegment = chat.indexOf("${turn.usage.outputTokens} out");
    const speedSegment = chat.indexOf("${tps}");
    const wallClock = chat.indexOf("clockTime(turn.endTs");
    expect(outSegment).toBeGreaterThan(-1);
    expect(speedSegment).toBeGreaterThan(outSegment);
    expect(wallClock).toBeGreaterThan(speedSegment);
  });
});
