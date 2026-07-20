import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { advanceScene, fileLabel, initialScene, isLocalProvider } from "./labScene";
import type { Scene } from "./labScene";

const T = 1700000000000;

const runStart = (provider?: string, agentId = "main"): RunEvent =>
  ({ type: "run_start", runId: "r1", agentId, prompt: "hi", provider, ts: T }) as RunEvent;
const toolCall = (name: string, input: unknown = {}, callId = "c1", agentId = "main"): RunEvent =>
  ({ type: "tool_call", agentId, callId, name, input, ts: T }) as RunEvent;

function play(events: RunEvent[], from: Scene = initialScene()): Scene {
  return events.reduce((s, e) => advanceScene(s, e), from);
}

describe("labScene", () => {
  it("a plan event leaves the map inert (unknown to the scene)", () => {
    const before = play([runStart("ollama")]);
    const after = advanceScene(before, { type: "plan", agentId: "main",
      steps: [{ text: "x", status: "pending" }], ts: T } as RunEvent);
    expect(after).toEqual(before);
  });

  it("starts with the packet on the user, nothing active", () => {
    const s = initialScene();
    expect(s.focus).toBe("user");
    expect(s.disk).toBe("idle");
    expect(s.gate).toBe("none");
    expect(s.activeTool).toBeNull();
    expect(s.activeFile).toBeNull();
    expect(s.activeCommand).toBeNull();
    expect(s.activeMcp).toBeNull();
    expect(s.llmLocal).toBeNull();
    expect(s.isError).toBe(false);
  });

  it("run_start focuses the agent and reads provider locality", () => {
    expect(advanceScene(initialScene(), runStart("ollama")).focus).toBe("agent");
    expect(advanceScene(initialScene(), runStart("ollama")).llmLocal).toBe(true);
    expect(advanceScene(initialScene(), runStart("anthropic")).llmLocal).toBe(false);
  });

  it("run_start without a provider keeps the previously known locality", () => {
    const s = play([runStart("ollama"), runStart(undefined)]);
    expect(s.llmLocal).toBe(true);
  });

  it("turn_start and deltas focus the llm", () => {
    expect(play([runStart("anthropic"), { type: "turn_start", agentId: "main", turn: 1, ts: T }]).focus).toBe("llm");
    expect(play([runStart("anthropic"), { type: "text_delta", agentId: "main", text: "…", ts: T }]).focus).toBe("llm");
  });

  it("write_file focuses the disk, writes, and shows the file's basename", () => {
    const s = play([runStart("anthropic"), toolCall("write_file", { path: "src/main/notes.md", content: "x" })]);
    expect(s.focus).toBe("disk");
    expect(s.disk).toBe("write");
    expect(s.activeTool).toBe("write_file");
    expect(s.activeFile).toBe("notes.md");
  });

  it("read_file reads; list_dir reads and shows the directory's last segment", () => {
    const rd = play([runStart("anthropic"), toolCall("read_file", { path: "/Users/me/project/README.md" })]);
    expect(rd.disk).toBe("read");
    expect(rd.activeFile).toBe("README.md");
    const ls = play([runStart("anthropic"), toolCall("list_dir", { path: "src/main" })]);
    expect(ls.disk).toBe("read");
    expect(ls.activeFile).toBe("main");
  });

  it("run_command focuses the shell bubble and carries the command, not the disk", () => {
    const s = play([runStart("anthropic"), toolCall("run_command", { command: "find . -name '*.ts'" })]);
    expect(s.focus).toBe("cmd");
    expect(s.disk).toBe("idle");
    expect(s.activeTool).toBe("run_command");
    expect(s.activeCommand).toBe("find . -name '*.ts'");
  });

  it("an mcp tool focuses the mcp bubble and pretty-prints server and tool", () => {
    const s = play([runStart("anthropic"), toolCall("mcp__notes__search_notes", { query: "x" })]);
    expect(s.focus).toBe("mcp");
    expect(s.activeTool).toBe("mcp__notes__search_notes");
    expect(s.activeMcp).toBe("notes · search_notes");
  });

  it("a permission request parks the packet at a pending gate", () => {
    const s = play([runStart("anthropic"), toolCall("run_command", { command: "rm -rf /" }),
      { type: "permission_request", agentId: "main", callId: "c1", name: "run_command", input: {}, ts: T }]);
    expect(s.focus).toBe("gate");
    expect(s.gate).toBe("pending");
  });

  it("a decision resolves the gate; a denial is an error", () => {
    const allow = play([runStart("anthropic"), toolCall("write_file", { path: "a.txt" }),
      { type: "permission_request", agentId: "main", callId: "c1", name: "write_file", input: {}, ts: T },
      { type: "permission_decision", callId: "c1", allowed: true, ts: T }]);
    expect(allow.gate).toBe("allowed");
    expect(allow.isError).toBe(false);
    const deny = advanceScene(allow, { type: "permission_decision", callId: "c1", allowed: false, ts: T } as RunEvent);
    expect(deny.gate).toBe("denied");
    expect(deny.isError).toBe(true);
  });

  it("tool_result returns focus to the agent and clears all activity", () => {
    const s = play([runStart("anthropic"), toolCall("write_file", { path: "a.txt" }),
      { type: "tool_result", agentId: "main", callId: "c1", output: "ok", isError: false, durationMs: 5, ts: T }]);
    expect(s.focus).toBe("agent");
    expect(s.disk).toBe("idle");
    expect(s.activeTool).toBeNull();
    expect(s.activeFile).toBeNull();
    expect(s.activeCommand).toBeNull();
    expect(s.activeMcp).toBeNull();
  });

  it("an error tool_result is flagged", () => {
    const s = play([runStart("anthropic"), toolCall("read_file", { path: "x" }),
      { type: "tool_result", agentId: "main", callId: "c1", output: "boom", isError: true, durationMs: 1, ts: T }]);
    expect(s.isError).toBe(true);
  });

  it("run_end sends the packet home; error collapses to the user", () => {
    expect(play([runStart("anthropic"), { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T }]).focus).toBe("user");
    const err = play([runStart("anthropic"), toolCall("write_file", { path: "x" }), { type: "error", message: "x", ts: T }]);
    expect(err.focus).toBe("user");
    expect(err.isError).toBe(true);
  });

  it("child-agent events keep the parent packet but mark the active child", () => {
    const parent = play([runStart("anthropic"), { type: "turn_start", agentId: "main", turn: 1, ts: T }]);
    const child = advanceScene(parent, { type: "text_delta", agentId: "explore-1", text: "…", ts: T } as RunEvent);
    expect(child.focus).toBe(parent.focus);
    expect(child.activeChild).toBe("explore-1");
  });

  // ---- subagent cards (A2A-lite) ----------------------------------------

  const spawn = (id: string, task: string): RunEvent =>
    ({ type: "agent_spawn", agentId: id, parentId: "main", task, ts: T }) as RunEvent;
  const msg = (from: string, to: string, role: string, state: string, text: string, label?: string): RunEvent =>
    ({ type: "agent_message", from, to, role, state, text, ...(label ? { label } : {}), ts: T }) as RunEvent;

  it("starts with no subagents — the map looks exactly like before", () => {
    expect(initialScene().subagents).toEqual([]);
    expect(initialScene().activeChild).toBeNull();
  });

  it("a task message creates a card with label, task and lifecycle", () => {
    const s = play([runStart("anthropic"),
      spawn("worker-1", "ROLE… TASK: Plan X"),
      msg("main", "worker-1", "task", "submitted", "Plan X", "build_plan")]);
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0]).toMatchObject({
      id: "worker-1", label: "build_plan", task: "Plan X", state: "submitted", lastStatus: null,
    });
  });

  it("status updates flip the card to working and carry the last line", () => {
    const s = play([runStart("anthropic"),
      spawn("worker-1", "t"), msg("main", "worker-1", "task", "submitted", "Plan X", "build_plan"),
      msg("worker-1", "main", "status", "working", "reading the tree")]);
    expect(s.subagents[0].state).toBe("working");
    expect(s.subagents[0].lastStatus).toBe("reading the tree");
  });

  it("a result message lands the final state; failed flags the card", () => {
    const base = [runStart("anthropic"), spawn("worker-1", "t"),
      msg("main", "worker-1", "task", "submitted", "Plan X")];
    const done = play([...base, msg("worker-1", "main", "result", "completed", "plan written")]);
    expect(done.subagents[0].state).toBe("completed");
    const failed = play([...base, msg("worker-1", "main", "result", "failed", "ERROR: timeout")]);
    expect(failed.subagents[0].state).toBe("failed");
  });

  it("a spawn without a task message still creates a card (merge on id)", () => {
    const s = play([runStart("anthropic"), spawn("explore-1", "Look around")]);
    expect(s.subagents[0]).toMatchObject({
      id: "explore-1", label: null, task: "Look around", state: "submitted", lastStatus: null,
    });
  });

  it("each subagent runs its OWN loop (its events fold into its focus, not the main packet)", () => {
    const s = play([
      runStart("anthropic"),
      spawn("worker-1", "Write a file"),
      msg("main", "worker-1", "task", "submitted", "Write a file", "develop"),
      // the CHILD's own events — its packet, not the parent's:
      { type: "turn_start", agentId: "worker-1", turn: 1, ts: T },
      { type: "tool_call", agentId: "worker-1", callId: "cc", name: "write_file", input: { path: "src/a.ts" }, ts: T },
    ]);
    // the main agent's packet stayed where it was (agent), the child's moved:
    expect(s.focus).toBe("agent");
    expect(s.subagents[0].focus).toBe("disk");
    expect(s.subagents[0].disk).toBe("write");
    expect(s.subagents[0].activeFile).toBe("a.ts");
    expect(s.activeChild).toBe("worker-1");
  });

  it("two subagents each keep their own independent loop", () => {
    const s = play([
      runStart("anthropic"),
      spawn("explore-1", "A"), spawn("explore-2", "B"),
      { type: "tool_call", agentId: "explore-1", callId: "c1", name: "read_file", input: { path: "x.md" }, ts: T },
      { type: "turn_start", agentId: "explore-2", turn: 1, ts: T },
    ]);
    expect(s.subagents[0].focus).toBe("disk"); // explore-1 reading
    expect(s.subagents[0].disk).toBe("read");
    expect(s.subagents[1].focus).toBe("llm");  // explore-2 thinking — independent
  });

  it("two parallel children keep separate cards in spawn order", () => {
    const s = play([runStart("anthropic"),
      spawn("explore-1", "A"), spawn("explore-2", "B"),
      msg("explore-2", "main", "status", "working", "on B")]);
    expect(s.subagents.map((c) => c.id)).toEqual(["explore-1", "explore-2"]);
    expect(s.subagents[1].lastStatus).toBe("on B");
    expect(s.subagents[0].lastStatus).toBeNull();
  });

  it("the ROOT run_end clears the cards (fresh map for the next run)", () => {
    // runStart's runId is "r1"; the root run_end shares it.
    const s = play([runStart("anthropic"), spawn("worker-1", "t"),
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T }]);
    expect(s.subagents).toEqual([]);
  });

  it("a CHILD's own run_end does NOT wipe the cards mid-run", () => {
    // The forwarder merges the child's own run_end (a DIFFERENT runId, no
    // agentId) into the parent stream — it must not clear the strip.
    const s = play([runStart("anthropic"),
      spawn("worker-1", "Plan X"),
      msg("main", "worker-1", "task", "submitted", "Plan X", "build_plan"),
      { type: "text_delta", agentId: "worker-1", text: "…", ts: T },
      { type: "run_end", runId: "child-run-xyz", stopReason: "end_turn", ts: T },
      msg("worker-1", "main", "result", "completed", "plan written")]);
    expect(s.subagents).toHaveLength(1);
    expect(s.subagents[0].task).toBe("Plan X");   // NOT degraded to ""
    expect(s.subagents[0].label).toBe("build_plan");
    expect(s.subagents[0].state).toBe("completed");
  });

  it("a subagent's permission gate resolves on the CHILD loop, leaving the main agent untouched", () => {
    const base = [
      runStart("anthropic"),
      spawn("worker-1", "Write a file"),
      msg("main", "worker-1", "task", "submitted", "Write a file", "develop"),
      { type: "tool_call", agentId: "worker-1", callId: "cc", name: "write_file", input: { path: "a.txt" }, ts: T },
      // the CHILD asks — permission_request carries the agentId:
      { type: "permission_request", agentId: "worker-1", callId: "cc", name: "write_file", input: {}, ts: T },
    ] as RunEvent[];
    const pending = play(base);
    // the child sits at its own gate; the main agent's gate is untouched:
    expect(pending.subagents[0].focus).toBe("gate");
    expect(pending.subagents[0].gate).toBe("pending");
    expect(pending.gate).toBe("none");
    expect(pending.focus).not.toBe("gate");

    // the DECISION has no agentId — it must still land on the child's loop:
    const allowed = advanceScene(pending, { type: "permission_decision", callId: "cc", allowed: true, ts: T } as RunEvent);
    expect(allowed.subagents[0].gate).toBe("allowed");
    expect(allowed.gate).toBe("none");   // main gate never moved
    expect(allowed.isError).toBe(false); // main map not reddened

    // a child denial reddens only the child, never the whole main map:
    const denied = advanceScene(pending, { type: "permission_decision", callId: "cc", allowed: false, ts: T } as RunEvent);
    expect(denied.subagents[0].gate).toBe("denied");
    expect(denied.subagents[0].isError).toBe(true);
    expect(denied.isError).toBe(false);
  });

  it("usage and unknown additive events do not move the packet", () => {
    const before = play([runStart("anthropic"), { type: "turn_start", agentId: "main", turn: 1, ts: T }]);
    expect(advanceScene(before, { type: "usage", agentId: "main", inputTokens: 1, outputTokens: 1, ts: T })).toEqual(before);
    expect(advanceScene(before, { type: "voice_input", agentId: "main", text: "hi", ts: T } as unknown as RunEvent)).toEqual(before);
  });

  it("isLocalProvider recognises only ollama as local", () => {
    expect(isLocalProvider("ollama")).toBe(true);
    expect(isLocalProvider("Ollama")).toBe(true);
    expect(isLocalProvider("anthropic")).toBe(false);
    expect(isLocalProvider(undefined)).toBe(false);
    expect(isLocalProvider(null)).toBe(false);
  });

  it("fileLabel strips the path and middle-truncates long names Apple-style", () => {
    expect(fileLabel("/Users/me/project/README.md")).toBe("README.md");
    expect(fileLabel("settings.gradle.kts")).toBe("settings.gradle.kts");
    const long = fileLabel("/x/this-is-a-really-long-component-file-name.tsx");
    expect(long).toContain("…");
    expect(long.startsWith("this")).toBe(true);
    expect(long.endsWith(".tsx")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(24);
  });
});
