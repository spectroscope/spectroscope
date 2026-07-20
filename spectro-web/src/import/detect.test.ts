// Format auto-detection: a pasted/picked file is either raw spectroscope RunEvent
// JSONL (the wire format, replayed verbatim) or a Claude Code transcript
// (adapted). Anything else fails loudly with a friendly error.
import { describe, expect, it } from "vitest";
import ccLinear from "./fixtures/cc-linear.jsonl?raw";
import ccModern from "./fixtures/cc-modern.jsonl?raw";
import type { RunEvent } from "../events";
import { detectAndLoad } from "./detect";

describe("detectAndLoad", () => {
  it("detects a Claude Code transcript", () => {
    const { kind, events } = detectAndLoad(ccLinear);
    expect(kind).toBe("claude-code");
    expect(events[0].type).toBe("run_start");
  });

  it("detects a modern Claude Code transcript with leading metadata records", () => {
    // Real 2026 transcripts open with queue-operation / attachment / ai-title
    // lines BEFORE the first message record — detection must scan past them.
    const { kind, events } = detectAndLoad(ccModern);
    expect(kind).toBe("claude-code");
    expect(events[0].type).toBe("run_start");
  });

  it("detects a raw spectroscope RunEvent JSONL and replays it verbatim", () => {
    const raw: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "hi", ts: 1 },
      { type: "text_delta", agentId: "main", text: "hello", ts: 2 },
      { type: "plan", agentId: "main", steps: [{ text: "x", status: "pending" }], ts: 3 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 4 },
    ];
    const { kind, events } = detectAndLoad(raw.map((e) => JSON.stringify(e)).join("\n"));
    expect(kind).toBe("spectroscope");
    expect(events.length).toBe(raw.length);
    expect(events).toEqual(raw);
  });

  it("throws a friendly error on garbage", () => {
    expect(() => detectAndLoad("not json\n{oops")).toThrow();
    expect(() => detectAndLoad("   \n  ")).toThrow();
  });
});
