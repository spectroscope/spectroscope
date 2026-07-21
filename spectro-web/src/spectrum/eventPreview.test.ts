import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { eventPreview } from "./eventPreview";

describe("eventPreview — a hovered event's type + mini preview", () => {
  it("names the exact wire type and previews the payload per kind", () => {
    expect(eventPreview({ type: "text_delta", agentId: "main", text: "hello ", ts: 1 }))
      .toEqual({ type: "text_delta", detail: "hello" });

    expect(eventPreview({ type: "thinking_delta", agentId: "main", text: "let me think", ts: 1 }))
      .toEqual({ type: "thinking_delta", detail: "let me think" });

    const call = eventPreview({
      type: "tool_call", agentId: "main", callId: "c1", name: "read_file",
      input: { path: "pom.xml" }, ts: 1,
    });
    expect(call.type).toBe("tool_call");
    expect(call.detail).toContain("read_file");
    expect(call.detail).toContain("pom.xml");

    expect(eventPreview({ type: "permission_request", agentId: "main", callId: "c1", name: "write_file", input: {}, ts: 1 }))
      .toMatchObject({ type: "permission_request", detail: expect.stringContaining("write_file") });

    expect(eventPreview({ type: "permission_decision", callId: "c1", allowed: true, ts: 1 }))
      .toEqual({ type: "permission_decision", detail: "allowed" });
    expect(eventPreview({ type: "permission_decision", callId: "c1", allowed: false, ts: 1 }))
      .toEqual({ type: "permission_decision", detail: "denied" });

    const result = eventPreview({
      type: "tool_result", agentId: "main", callId: "c1", output: "not found",
      isError: true, durationMs: 3, ts: 1,
    });
    expect(result.type).toBe("tool_result");
    expect(result.detail).toContain("error");
    expect(result.detail).toContain("not found");

    expect(eventPreview({ type: "run_start", runId: "r1", agentId: "main", prompt: "Summarize the repo", ts: 1 }))
      .toEqual({ type: "run_start", detail: "Summarize the repo" });
    expect(eventPreview({ type: "turn_start", agentId: "main", turn: 2, ts: 1 }))
      .toEqual({ type: "turn_start", detail: "turn 2" });
    expect(eventPreview({ type: "run_end", runId: "r1", stopReason: "end_turn", ts: 1 }))
      .toEqual({ type: "run_end", detail: "end_turn" });
    expect(eventPreview({ type: "error", agentId: "main", message: "boom", ts: 1 }))
      .toEqual({ type: "error", detail: "boom" });

    const msg = eventPreview({
      type: "agent_message", from: "main", to: "worker-1", role: "task",
      state: "submitted", text: "Plan X", ts: 1,
    });
    expect(msg.type).toBe("agent_message");
    expect(msg.detail).toContain("main");
    expect(msg.detail).toContain("worker-1");
    expect(msg.detail).toContain("Plan X");

    expect(eventPreview({ type: "usage", agentId: "main", inputTokens: 120, outputTokens: 30, ts: 1 }))
      .toMatchObject({ type: "usage", detail: expect.stringContaining("120") });
  });

  it("collapses whitespace and truncates a long preview with an ellipsis", () => {
    const long = "x".repeat(400);
    const out = eventPreview({ type: "text_delta", agentId: "main", text: "a\n\n  b   c " + long, ts: 1 });
    expect(out.detail.startsWith("a b c")).toBe(true); // whitespace collapsed
    expect(out.detail.length).toBeLessThanOrEqual(200);
    expect(out.detail.endsWith("…")).toBe(true); // truncation marker
  });

  it("falls back to the bare type for an unknown/marklessly-typed event", () => {
    const unknown = { type: "future_event", agentId: "main", ts: 1 } as unknown as RunEvent;
    expect(eventPreview(unknown)).toEqual({ type: "future_event", detail: "" });
  });
});
