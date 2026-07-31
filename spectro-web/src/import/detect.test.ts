// Format auto-detection: a pasted/picked file is raw spectroscope RunEvent JSONL
// (the wire format, replayed verbatim), a Claude Code transcript, or a VS Code
// agent-mode export (both adapted). Anything else fails loudly with a friendly
// error.
import { describe, expect, it } from "vitest";
import ccLinear from "./fixtures/cc-linear.jsonl?raw";
import ccModern from "./fixtures/cc-modern.jsonl?raw";
import vscodeAgent from "./fixtures/vscode-agent.jsonl?raw";
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

  it("detects a VS Code agent-mode export", () => {
    const { kind, events } = detectAndLoad(vscodeAgent);
    expect(kind).toBe("vscode-agent");
    expect(events[0].type).toBe("run_start");
    // The caller shows a note about the missing tool output off this kind, so a
    // VS Code export must never come back labelled as one of the other two.
    expect(kind).not.toBe("claude-code");
  });

  it("detects a VS Code export that opens on a tool record", () => {
    // The real 893-record export begins mid-session, on tool.execution_start —
    // detection cannot assume the first line is the conversation's first line.
    const clipped = [
      {
        type: "tool.execution_start",
        data: { toolCallId: "c1", toolName: "run_in_terminal", arguments: {} },
        id: "1",
        timestamp: "2026-07-24T14:43:45.448Z",
        parentId: null,
      },
      {
        type: "tool.execution_complete",
        data: { toolCallId: "c1", success: true },
        id: "2",
        timestamp: "2026-07-24T14:43:46.448Z",
        parentId: "1",
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(detectAndLoad(clipped).kind).toBe("vscode-agent");
  });

  it("throws a friendly error on garbage", () => {
    expect(() => detectAndLoad("not json\n{oops")).toThrow();
    expect(() => detectAndLoad("   \n  ")).toThrow();
  });

  // A dotted type alone is not enough: other tools log dotted namespaces too.
  // The VS Code recognizer wants a known type AND the `data` object the whole
  // format hangs its payload on.
  it("does not take a lookalike dotted type for a VS Code export", () => {
    const lookalike = [
      { type: "tool.execution_start", toolName: "run_in_terminal" }, // no data object
      { type: "assistant.message", data: "just a string" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    expect(() => detectAndLoad(lookalike)).toThrow();
  });

  // "unrecognized format" is a dead end: it names neither what arrived nor what
  // was expected, so the message has to hand the reader their next move.
  it("names the types it actually saw when nothing matches", () => {
    const foreign = [
      { type: "langsmith.run.create", payload: {}, id: "1" },
      { type: "langsmith.run.patch", payload: {}, id: "2" },
      { type: "langsmith.feedback", payload: {}, id: "3" },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");

    expect(() => detectAndLoad(foreign)).toThrow(/langsmith\.run\.create/);
    expect(() => detectAndLoad(foreign)).toThrow(/langsmith\.feedback/);
    // and it must say what it DOES accept, or the reader still has no move
    expect(() => detectAndLoad(foreign)).toThrow(/spectroscope|Claude Code/i);
    expect(() => detectAndLoad(foreign)).toThrow(/VS Code/i);
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
