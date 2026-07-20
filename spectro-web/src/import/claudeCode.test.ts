// The Claude Code transcript adapter. Real Claude Code JSONL is a log of
// user/assistant message records with content blocks; the adapter maps them
// onto spectroscope's RunEvent stream so real sessions replay through the same
// reducers (chat, graph, flow, lab) as a spectroscope run.
import { describe, expect, it } from "vitest";
// Vite-native raw import: the fixture arrives as a plain string, no fs/paths.
import ccLinear from "./fixtures/cc-linear.jsonl?raw";
import ccSubagent from "./fixtures/cc-subagent.jsonl?raw";
import ccModern from "./fixtures/cc-modern.jsonl?raw";
import { parseTranscript } from "./claudeCode";
import { advanceScene, initialScene } from "../lab/labScene";

describe("claudeCode adapter (linear)", () => {
  const events = parseTranscript(ccLinear);

  it("opens with run_start carrying the first user prompt", () => {
    expect(events[0]).toMatchObject({ type: "run_start", agentId: "main" });
    expect((events[0] as { prompt: string }).prompt).toMatch(/List the files/);
  });

  it("maps thinking, text, tool_use and tool_result", () => {
    expect(events.some((e) => e.type === "thinking_delta")).toBe(true);
    expect(events.some((e) => e.type === "tool_call" && e.name === "Bash")).toBe(true);
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toBeTruthy();
    const callId = (call as { callId: string }).callId;
    expect(events.some((e) => e.type === "tool_result" && e.callId === callId && e.output.includes("config.json"))).toBe(true);
  });

  it("maps usage", () => {
    expect(events.some((e) => e.type === "usage" && e.inputTokens === 1200)).toBe(true);
  });

  it("ends with run_end and folds to a clean scene", () => {
    expect(events.at(-1)).toMatchObject({ type: "run_end" });
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
  });
});

describe("claudeCode adapter (modern format)", () => {
  const events = parseTranscript(ccModern);

  it("skips leading metadata records and opens with the real user prompt", () => {
    expect(events[0]).toMatchObject({ type: "run_start", agentId: "main" });
    expect((events[0] as { prompt: string }).prompt).toMatch(/check the tests/);
  });

  it("maps the Agent tool (the modern Task) to agent_spawn + result close", () => {
    const spawn = events.find((e) => e.type === "agent_spawn");
    expect(spawn).toBeTruthy();
    expect((spawn as { agentId: string }).agentId).toBe("agent-1");
    expect(events.some((e) => e.type === "agent_message" && e.role === "result" && e.from === "agent-1")).toBe(true);
  });

  it("folds to a clean terminal scene", () => {
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

describe("claudeCode adapter (Task subagents via sidechains)", () => {
  const events = parseTranscript(ccSubagent);
  const spawn = events.find((e) => e.type === "agent_spawn") as Extract<import("../events").RunEvent, { type: "agent_spawn" }> | undefined;

  it("emits agent_spawn for a Task tool_use", () => {
    expect(spawn).toBeTruthy();
    expect(spawn!.task).toMatch(/Review/);
  });

  it("routes sidechain text under the child agentId (with its own run_start)", () => {
    expect(events.some((e) => e.type === "run_start" && e.agentId === spawn!.agentId)).toBe(true);
    expect(events.some((e) => e.type === "text_delta" && e.agentId === spawn!.agentId)).toBe(true);
  });

  it("closes the child with a result message and the parent tool_result", () => {
    expect(events.some((e) => e.type === "agent_message" && e.role === "result" && e.from === spawn!.agentId)).toBe(true);
    expect(events.some((e) => e.type === "tool_result" && e.callId === spawn!.agentId)).toBe(true);
  });

  it("folds to a clean terminal scene (no stranded subagents)", () => {
    const scene = events.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});
