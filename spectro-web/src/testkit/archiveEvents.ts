// A recorded session of any length, built from one repeating cycle (card 431).
//
// Each cycle is one root run with a child agent under it, and together the
// cycles carry every event type the reducer folds: the wire frames of the
// RunEvent union, the socket-only frames (provider_info, workspace_info,
// permission_mode_info, tool_groups_info, local_mode_info, otlp_export) and the import-only ones (user_message,
// tool_result_detail, workflow_state, attachment_image, agent_detail). Which
// types those are is read off reducer.ts by the test that uses this, so a type
// the reducer learns later turns that test red until it is added here.
//
// Every event carries a `ts`: the reducer falls back to Date.now() for a frame
// without one, and two folds of the same list must see the same input.
//
// Test-only by construction: nothing under src/ imports this module except
// *.test.* files, so it never reaches the shipped bundle.

import type { RunEvent } from "../events";

const BASE_TS = 1_783_000_000_000;

/** The events of cycle `c`, stamped from `ts` onward, one millisecond apart. */
function cycle(c: number, ts: number): Array<Record<string, unknown>> {
  const root = "root";
  const child = `w${c}`;
  const run = `r${c}`;
  const read = `c${c}-read`;
  const image = `c${c}-image`;
  const ask = `c${c}-ask`;
  const out: Array<Record<string, unknown>> = [];
  const push = (event: Record<string, unknown>): void => {
    out.push({ ...event, ts: ts + out.length });
  };
  if (c % 10 === 0) {
    push({ type: "provider_info", provider: "ollama", model: `model-${c % 3}`, host: "localhost" });
    push({
      type: "workspace_info",
      sessionId: "20260101-000000-abcdef12",
      path: "/tmp/work",
      configured: true,
      resolved: true,
      mode: "default",
      exists: true,
    });
    push({ type: "permission_mode_info", mode: c % 20 === 0 ? "ask" : "auto" });
    push({
      type: "tool_groups_info",
      off: c % 20 === 0 ? [] : ["browser"],
      groups: [{ name: "browser", tools: ["browser_click"] }],
    });
    push({
      type: "local_mode_info",
      on: c % 20 !== 0,
      rows: [{ key: "sessionsPerChat", value: 3, preset: 3, changed: false, floor: 2 }],
    });
  }
  push({ type: "user_message", text: `question ${c}` });
  push({
    type: "run_start",
    runId: run,
    agentId: root,
    prompt: `prompt ${c}`,
    provider: "ollama",
    model: "m",
  });
  push({ type: "turn_start", agentId: root, turn: 1 });
  push({
    type: "context_info",
    agentId: root,
    turn: 1,
    messages: 3 + c,
    estimatedTokens: 1000 + c,
    threshold: 100_000,
    thresholdSource: "window",
    contextWindow: 128_000,
    parts: [{ label: "system", chars: 400, estTokens: 100 }],
  });
  push({ type: "thinking_delta", agentId: root, text: "Looking at the " });
  push({ type: "thinking_delta", agentId: root, text: "files first." });
  push({ type: "text_delta", agentId: root, text: `Answer ${c}, ` });
  push({ type: "text_delta", agentId: root, text: "in two parts." });
  push({
    type: "llm_exchange",
    xid: `x${c}`,
    agentId: root,
    turn: 1,
    kind: "chat",
    provider: "ollama",
    model: "m",
    transport: "http",
    url: "http://localhost:11434/api/chat",
    status: 200,
    requestBytes: 2000,
    responseBytes: 800,
    responseLines: 12,
    aborted: false,
    fidelity: "verbatim",
    durationMs: 900,
  });
  push({ type: "tool_call", agentId: root, callId: read, name: "read_file", input: { path: `f${c}.ts` } });
  push({
    type: "permission_request",
    agentId: root,
    callId: read,
    name: "read_file",
    input: { path: `f${c}.ts` },
  });
  push({ type: "permission_decision", callId: read, allowed: c % 5 !== 0 });
  push({
    type: "tool_result",
    agentId: root,
    callId: read,
    output: "line 1",
    isError: c % 5 === 0,
    durationMs: 4,
  });
  push({
    type: "tool_result_detail",
    callId: read,
    detail: { fileContent: "line 1", startLine: 1, numLines: 1 },
  });
  push({ type: "workflow_state", callId: read, runState: `{"phase":${c % 4}}` });
  push({
    type: "attachment_image",
    callId: read,
    mediaType: "image/png",
    dataBase64: "iVBORw0KGgo=",
    note: "shot",
  });
  push({ type: "attachment_image", mediaType: "image/png", dataBase64: "iVBORw0KGgo=", standalone: true });
  push({
    type: "hook_decision",
    agentId: root,
    callId: read,
    toolName: "read_file",
    event: "pre_tool_use",
    matcher: "*",
    command: "true",
    timeoutSeconds: 5,
    verdict: "timed-out",
  });
  push({ type: "agent_spawn", agentId: child, parentId: root, task: `sub task ${c}` });
  push({ type: "agent_detail", agentId: child, model: "child-model", launched: c % 2 === 0 });
  push({ type: "run_start", runId: `${run}-child`, agentId: child, parentId: root, prompt: `sub ${c}` });
  push({ type: "text_delta", agentId: child, text: "child says" });
  push({ type: "agent_message", from: root, to: child, role: "user", state: "submitted", text: "go on" });
  push({ type: "usage", agentId: child, inputTokens: 30, outputTokens: 10 });
  push({ type: "run_end", runId: `${run}-child`, stopReason: "end_turn" });
  push({
    type: "question_asked",
    agentId: root,
    callId: ask,
    questions: [{ question: "Which one?", options: [{ label: "a" }, { label: "b" }] }],
  });
  push({ type: "question_answered", callId: ask, answers: c % 3 === 0 ? [] : ["a"], cancelled: c % 3 === 0 });
  push({ type: "steering_message", agentId: root, text: `also check ${c}`, taken: c % 4 !== 0, turn: 1 });
  push({
    type: "no_progress",
    agentId: root,
    detector: "identical_writes",
    count: 3,
    details: ["f.ts"],
    evidence: "Wrote the same file three times.",
    callId: ask,
  });
  push({
    type: "progress_intervention",
    agentId: root,
    callId: ask,
    detector: "identical_writes",
    intervention: "CARRY_ON",
    stoodDown: c % 2 === 0,
  });
  push({
    type: "continuation",
    agentId: root,
    decision: "continued",
    continuation: 1,
    budget: 3,
    openSteps: 1,
    totalSteps: 2,
    inputTokens: 500,
    evidence: "One step open.",
  });
  push({
    type: "goal_check",
    agentId: root,
    outcome: c % 2 === 0 ? "met" : "unmet",
    command: "npm test",
    exitCode: c % 2,
    judge: "exit_code",
    output: "ok",
    durationMs: 12,
    evidence: "exit 0",
  });
  push({ type: "images_withheld", agentId: root, images: 1, model: "m", reason: "no_vision" });
  push({
    type: "settings_ignored",
    key: "permissionMode",
    file: "/tmp/work/.spectro/settings.json",
    hint: "user settings",
    inForce: c % 2 === 0,
    kept: ["model"],
  });
  push({ type: "compaction_state", active: true });
  push({ type: "compaction", agentId: root, removedTurns: 2, summaryChars: 300 });
  push({ type: "compaction_state", active: false, outcome: "compacted" });
  push({ type: "context_cleared", agentId: root, removedMessages: 6 });
  push({
    type: "window_override",
    tokens: 64_000,
    threshold: 51_200,
    thresholdSource: "window_override",
    contextWindow: 64_000,
  });
  push({
    type: "plan",
    agentId: root,
    steps: [
      { text: "read", status: "done" },
      { text: "write", status: c % 2 === 0 ? "in_progress" : "pending" },
    ],
  });
  push({
    type: "tool_call",
    agentId: root,
    callId: image,
    name: "generate_image",
    input: { prompt: "a cat" },
  });
  push({
    type: "image_generated",
    agentId: root,
    callId: image,
    prompt: "a cat",
    provider: "local",
    model: "img",
    mediaType: "image/png",
    blobPath: `blobs/${c}.png`,
    sha256: `sha${c}`,
  });
  push({ type: "tool_result", agentId: root, callId: image, output: "done", isError: false, durationMs: 40 });
  push({ type: "otlp_export", endpoint: "http://localhost:3000", ok: c % 3 !== 0, message: "sent" });
  push({ type: "usage", agentId: root, inputTokens: 100 + c, outputTokens: 50, cacheReadTokens: 10 });
  if (c % 7 === 0) push({ type: "error", agentId: root, message: `failure ${c}` });
  push({ type: "run_end", runId: run, stopReason: c % 7 === 0 ? "error" : "end_turn" });
  return out;
}

/** A run the file stops in the middle of, as a crash or an abort leaves it:
 *  thinking, a permission not yet decided and a question not yet answered, no
 *  run_end. The archive fold's normalizeReplay is what clears those. */
function interrupted(ts: number): Array<Record<string, unknown>> {
  const root = "root";
  const events: Array<Record<string, unknown>> = [
    { type: "run_start", runId: "r-last", agentId: root, prompt: "one more" },
    { type: "turn_start", agentId: root, turn: 1 },
    { type: "thinking_delta", agentId: root, text: "Still thinking" },
    { type: "tool_call", agentId: root, callId: "last-write", name: "write_file", input: { path: "a.ts" } },
    { type: "permission_request", agentId: root, callId: "last-write", name: "write_file", input: {} },
    {
      type: "question_asked",
      agentId: root,
      callId: "last-ask",
      questions: [{ question: "Go on?", options: [{ label: "yes" }] }],
    },
  ];
  return events.map((event, i) => ({ ...event, ts: ts + i }));
}

/** At least `min` events: whole cycles, then one interrupted run. Every event
 *  carries its own `ts`. */
export function archiveEvents(min: number): RunEvent[] {
  const all: Array<Record<string, unknown>> = [];
  for (let c = 0; all.length < min; c++) all.push(...cycle(c, BASE_TS + all.length));
  all.push(...interrupted(BASE_TS + all.length));
  return all as unknown as RunEvent[];
}
