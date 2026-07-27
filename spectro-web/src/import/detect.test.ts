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

  // "unrecognized format" is a dead end: it names neither what arrived nor what
  // was expected. A third format DOES exist in the wild (the owner hit a
  // VS Code/Copilot agent export whose types are dotted and whose payload sits
  // under `data`), so the message has to hand the reader their next move.
  it("names the types it actually saw when nothing matches", () => {
    const vscodeExport = [
      { type: "assistant.turn_start", data: {}, id: "1", timestamp: "2026-07-24T14:43:45.448Z" },
      { type: "tool.execution_start", data: { toolName: "run_in_terminal" }, id: "2" },
      { type: "user.message", data: { content: "hi" }, id: "3" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");

    expect(() => detectAndLoad(vscodeExport)).toThrow(/assistant\.turn_start/);
    expect(() => detectAndLoad(vscodeExport)).toThrow(/tool\.execution_start/);
    // and it must say what it DOES accept, or the reader still has no move
    expect(() => detectAndLoad(vscodeExport)).toThrow(/spectroscope|Claude Code/i);
  });

  it("caps the reported type list so a hostile file cannot flood the dialog", () => {
    const many = Array.from({ length: 60 }, (_, i) => JSON.stringify({ type: `weird.type.${i}` })).join("\n");
    let message = "";
    try {
      detectAndLoad(many);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toBe("");
    expect(message.length).toBeLessThan(400);
  });

  // The types are lifted verbatim from an untrusted file and rendered into the
  // dialog. Newlines would let a crafted file forge extra lines of UI text.
  it("strips control characters out of the reported type names", () => {
    const nasty = JSON.stringify({ type: "evil\nfake: everything is fine" });
    let message = "";
    try {
      detectAndLoad(nasty);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    expect(message).not.toContain("\n");
    expect(message).not.toContain("");
  });
});
