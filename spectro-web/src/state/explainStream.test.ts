import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { feedToPlainText, buildTextFeed } from "./textFeed";
import { buildExplainDigest, parseNdjsonChunk, DIGEST_CAP_CHARS } from "./explainStream";

const ts = 1;

function smallRun(): RunEvent[] {
  return [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "2+2?", provider: "ollama", ts },
    { type: "thinking_delta", agentId: "main", text: "math.", ts },
    { type: "text_delta", agentId: "main", text: "4", ts },
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts },
  ];
}

describe("buildExplainDigest — the bounded run digest", () => {
  it("is the plain text feed verbatim when the run fits the cap", () => {
    const events = smallRun();
    expect(buildExplainDigest(events)).toBe(feedToPlainText(buildTextFeed(events)));
  });

  it("elides the middle (head + tail survive) when the run exceeds the cap", () => {
    const big: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "HEAD-MARK", provider: "ollama", ts },
    ];
    for (let i = 0; i < 400; i++) {
      big.push({ type: "text_delta", agentId: "main", text: `filler ${i} `.repeat(20), ts });
    }
    big.push({ type: "run_end", runId: "r1", stopReason: "end_turn", ts });
    const digest = buildExplainDigest(big, 4000);
    expect(digest.length).toBeLessThan(4200); // cap + the elision marker, never the full text
    expect(digest).toContain("HEAD-MARK"); // the head survives
    expect(digest).toContain("characters elided"); // the cut is honest, not silent
    expect(digest).toContain("[run_end end_turn]"); // the tail survives
  });

  it("has a default cap high enough for normal sessions", () => {
    expect(DIGEST_CAP_CHARS).toBeGreaterThanOrEqual(20000);
  });
});

describe("parseNdjsonChunk — incremental line protocol", () => {
  it("parses complete lines and keeps the partial tail pending", () => {
    const r1 = parseNdjsonChunk("", '{"meta":{"provider":"anthropic","model":"m1"}}\n{"delta":"Hel');
    expect(r1.messages).toEqual([{ meta: { provider: "anthropic", model: "m1" } }]);
    expect(r1.pending).toBe('{"delta":"Hel');
    const r2 = parseNdjsonChunk(r1.pending, 'lo"}\n{"done":true}\n');
    expect(r2.messages).toEqual([{ delta: "Hello" }, { done: true }]);
    expect(r2.pending).toBe("");
  });

  it("survives a garbage line without dropping the rest", () => {
    const r = parseNdjsonChunk("", 'not-json\n{"delta":"ok"}\n');
    expect(r.messages).toEqual([{ delta: "ok" }]);
  });
});
