import { describe, expect, it } from "vitest";
import type { ClientMessage, RunEvent } from "../events";
import { initialState, normalizeReplay, recordOutgoing, reduce, reduceAll } from "./reducer";

// A realistic root run: prompt -> streamed answer -> usage -> end.
const happyPath: RunEvent[] = [
  { type: "run_start", runId: "r1", agentId: "main", prompt: "Summarize pom.xml", provider: "anthropic", ts: 1 },
  { type: "turn_start", agentId: "main", turn: 1, ts: 2 },
  { type: "text_delta", agentId: "main", text: "The pom ", ts: 3 },
  { type: "text_delta", agentId: "main", text: "declares one module.", ts: 4 },
  { type: "usage", agentId: "main", inputTokens: 120, outputTokens: 30, ts: 5 },
  { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 6 },
];

describe("reduce — session-wide agents (persistence data model)", () => {
  it("the root run adds the main agent", () => {
    const s = reduceAll(initialState, happyPath.slice(0, 1));
    expect(s.agents).toHaveLength(1);
    expect(s.agents[0]).toMatchObject({ id: "main", parentId: null, state: "working" });
  });

  it("folds a subagent from spawn + A2A messages (label, task, status, result)", () => {
    const s = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts: 1 },
      { type: "agent_spawn", agentId: "worker-1", parentId: "main", task: "Plan X", ts: 2 },
      { type: "agent_message", from: "main", to: "worker-1", role: "task", state: "submitted", text: "Plan X", label: "build_plan", ts: 3 },
      { type: "agent_message", from: "worker-1", to: "main", role: "status", state: "working", text: "drafting", ts: 4 },
      { type: "usage", agentId: "worker-1", inputTokens: 40, outputTokens: 12, ts: 5 },
      { type: "agent_message", from: "worker-1", to: "main", role: "result", state: "completed", text: "done", ts: 6 },
    ] as RunEvent[]);
    const worker = s.agents.find((a) => a.id === "worker-1");
    expect(worker).toMatchObject({
      id: "worker-1", parentId: "main", label: "build_plan", task: "Plan X",
      state: "completed", lastStatus: "drafting", inTokens: 40, outTokens: 12,
    });
  });

  it("keeps agents ACROSS run_end (they persist for the whole session)", () => {
    const s = reduceAll(initialState, [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "go", provider: "ollama", ts: 1 },
      { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "look", ts: 2 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 },
    ] as RunEvent[]);
    expect(s.agents.map((a) => a.id)).toEqual(["main", "explore-1"]);
    expect(s.agents.find((a) => a.id === "main")?.state).toBe("completed");
  });

  it("initialState (a new chat) starts with no agents", () => {
    expect(initialState.agents).toEqual([]);
  });
});

describe("reduce — happy path", () => {
  it("builds a user turn and one accumulated assistant turn", () => {
    const state = reduceAll(initialState, happyPath);
    expect(state.turns).toEqual([
      { kind: "user", text: "Summarize pom.xml" },
      { kind: "assistant", agentId: "main", text: "The pom declares one module.", thinking: "" },
    ]);
  });

  it("tracks running across run_start/run_end and keeps the stop reason", () => {
    const midRun = reduceAll(initialState, happyPath.slice(0, 3));
    expect(midRun.running).toBe(true);
    expect(midRun.rootRunId).toBe("r1");

    const done = reduceAll(initialState, happyPath);
    expect(done.running).toBe(false);
    expect(done.rootRunId).toBeNull();
    expect(done.lastStopReason).toBe("end_turn");
  });

  it("accumulates usage and exposes the provider for the header chip", () => {
    const state = reduceAll(initialState, happyPath);
    expect(state.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(state.provider).toBe("anthropic");
  });

  it("keeps session totals across runs but resets the per-run usage", () => {
    const secondRun: RunEvent[] = [
      { type: "run_start", runId: "r2", agentId: "main", prompt: "Again", ts: 10 },
      { type: "usage", agentId: "main", inputTokens: 200, outputTokens: 50, ts: 11 },
      { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 12 },
    ];
    const state = reduceAll(initialState, [...happyPath, ...secondRun]);
    expect(state.usage).toEqual({ inputTokens: 320, outputTokens: 80 });
    expect(state.runUsage).toEqual({ inputTokens: 200, outputTokens: 50 });
  });
});

describe("reduce — thinking (reasoning stream)", () => {
  const run: RunEvent = {
    type: "run_start", runId: "r1", agentId: "main", prompt: "Add 17 and 25", ts: 1,
  };

  it("accumulates thinking_delta into the current assistant turn's buffer", () => {
    const state = reduceAll(initialState, [
      run,
      { type: "thinking_delta", agentId: "main", text: "Let me ", ts: 2 },
      { type: "thinking_delta", agentId: "main", text: "add them.", ts: 3 },
    ]);
    const last = state.turns[state.turns.length - 1];
    expect(last).toEqual({ kind: "assistant", agentId: "main", text: "", thinking: "Let me add them." });
  });

  it("sets thinkingActive while streaming, then clears it when the answer text starts", () => {
    const thinking = reduceAll(initialState, [
      run,
      { type: "thinking_delta", agentId: "main", text: "reasoning", ts: 2 },
    ]);
    expect(thinking.thinkingActive).toBe(true);

    const answered = reduce(thinking, { type: "text_delta", agentId: "main", text: "42.", ts: 3 });
    expect(answered.thinkingActive).toBe(false);
    const last = answered.turns[answered.turns.length - 1];
    expect(last).toEqual({ kind: "assistant", agentId: "main", text: "42.", thinking: "reasoning" });
  });

  it("clears thinkingActive when a tool call arrives instead of an answer", () => {
    const state = reduceAll(initialState, [
      run,
      { type: "thinking_delta", agentId: "main", text: "I should read the file", ts: 2 },
      { type: "tool_call", agentId: "main", callId: "c1", name: "read_file", input: {}, ts: 3 },
    ]);
    expect(state.thinkingActive).toBe(false);
  });

  it("keeps the buffer on a thinking-only turn (never answered)", () => {
    const state = normalizeReplay(reduceAll(initialState, [
      run,
      { type: "thinking_delta", agentId: "main", text: "pondering", ts: 2 },
      // no text_delta, no run_end — replay of a torn session
    ]));
    const last = state.turns[state.turns.length - 1];
    expect(last).toEqual({ kind: "assistant", agentId: "main", text: "", thinking: "pondering" });
    expect(state.thinkingActive).toBe(false); // normalizeReplay clears the live indicator
  });

  it("run_end clears thinkingActive", () => {
    const state = reduceAll(initialState, [
      run,
      { type: "thinking_delta", agentId: "main", text: "hmm", ts: 2 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 3 },
    ]);
    expect(state.thinkingActive).toBe(false);
  });

  it("fills thinking on replay through the same reducer", () => {
    const stored: RunEvent[] = [
      run,
      { type: "thinking_delta", agentId: "main", text: "step 1. ", ts: 2 },
      { type: "thinking_delta", agentId: "main", text: "step 2.", ts: 3 },
      { type: "text_delta", agentId: "main", text: "Answer.", ts: 4 },
      { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 5 },
    ];
    const state = normalizeReplay(reduceAll(initialState, stored));
    const last = state.turns[state.turns.length - 1];
    expect(last).toEqual({ kind: "assistant", agentId: "main", text: "Answer.", thinking: "step 1. step 2." });
  });
});

describe("reduce — tool call and result pairing", () => {
  const call: RunEvent = {
    type: "tool_call", agentId: "main", callId: "c1", name: "read_file",
    input: { path: "pom.xml" }, ts: 3,
  };

  it("creates a pending card keyed by callId and a tool turn", () => {
    const state = reduce(reduce(initialState, happyPath[0]!), call);
    expect(state.turns[state.turns.length - 1]).toEqual({ kind: "tool", callId: "c1" });
    expect(state.cards["c1"]).toMatchObject({
      callId: "c1", agentId: "main", name: "read_file",
      input: { path: "pom.xml" }, status: "pending", startedAt: 3,
    });
  });

  it("pairs the result onto the same card (ok + duration)", () => {
    const result: RunEvent = {
      type: "tool_result", agentId: "main", callId: "c1",
      output: "<project>...</project>", isError: false, durationMs: 412, ts: 4,
    };
    const state = reduceAll(initialState, [happyPath[0]!, call, result]);
    expect(state.cards["c1"]).toMatchObject({ status: "ok", output: "<project>...</project>", durationMs: 412 });
  });

  it("marks failed tools as error", () => {
    const failure: RunEvent = {
      type: "tool_result", agentId: "main", callId: "c1",
      output: "ERROR: no such file", isError: true, durationMs: 9, ts: 4,
    };
    const state = reduceAll(initialState, [happyPath[0]!, call, failure]);
    expect(state.cards["c1"]?.status).toBe("error");
  });

  it("ignores results for unknown callIds instead of crashing", () => {
    const orphan: RunEvent = {
      type: "tool_result", agentId: "main", callId: "ghost",
      output: "", isError: false, durationMs: 1, ts: 4,
    };
    const state = reduce(initialState, orphan);
    // The chat model is untouched — but the frame still shows in the wire view.
    expect(state.turns).toEqual([]);
    expect(state.cards).toEqual({});
    expect(state.trace).toHaveLength(1);
  });

  it("splits assistant text around a tool card into separate turns", () => {
    const events: RunEvent[] = [
      happyPath[0]!,
      { type: "text_delta", agentId: "main", text: "Let me look. ", ts: 2 },
      call,
      { type: "text_delta", agentId: "main", text: "Done.", ts: 5 },
    ];
    const state = reduceAll(initialState, events);
    expect(state.turns.map((t) => t.kind)).toEqual(["user", "assistant", "tool", "assistant"]);
  });
});

describe("reduce — permission flow", () => {
  const base: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "write it", ts: 1 },
    { type: "tool_call", agentId: "main", callId: "c9", name: "write_file", input: { path: "note.txt" }, ts: 2 },
    { type: "permission_request", agentId: "main", callId: "c9", name: "write_file", input: { path: "note.txt" }, ts: 3 },
  ];

  it("queues the request and flags the card", () => {
    const state = reduceAll(initialState, base);
    expect(state.pendingPermissions).toEqual([
      { callId: "c9", agentId: "main", name: "write_file", input: { path: "note.txt" } },
    ]);
    expect(state.cards["c9"]?.permission).toBe("pending");
  });

  it("is idempotent per callId (replay must not duplicate the modal)", () => {
    const duplicated = reduceAll(initialState, [...base, base[2]!]);
    expect(duplicated.pendingPermissions).toHaveLength(1);
  });

  it("allow clears the queue and marks the card allowed", () => {
    const state = reduceAll(initialState, [
      ...base,
      { type: "permission_decision", callId: "c9", allowed: true, ts: 4 },
    ]);
    expect(state.pendingPermissions).toHaveLength(0);
    expect(state.cards["c9"]?.permission).toBe("allowed");
  });

  it("deny clears the queue and marks the card denied", () => {
    const state = reduceAll(initialState, [
      ...base,
      { type: "permission_decision", callId: "c9", allowed: false, ts: 4 },
    ]);
    expect(state.pendingPermissions).toHaveLength(0);
    expect(state.cards["c9"]?.permission).toBe("denied");
  });
});

describe("reduce — subagents", () => {
  const withChild: RunEvent[] = [
    { type: "run_start", runId: "r1", agentId: "main", prompt: "explore src", ts: 1 },
    { type: "agent_spawn", agentId: "explore-1", parentId: "main", task: "list all TODOs", ts: 2 },
    { type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main", prompt: "list all TODOs", ts: 3 },
    { type: "text_delta", agentId: "explore-1", text: "Found 3.", ts: 4 },
    { type: "run_end", runId: "r2", stopReason: "end_turn", ts: 5 },
  ];

  it("gives subagent runs no user bubble, only an info line", () => {
    const state = reduceAll(initialState, withChild);
    const userTurns = state.turns.filter((t) => t.kind === "user");
    expect(userTurns).toHaveLength(1);
    expect(state.turns[1]).toEqual({
      kind: "info", text: "Subagent explore-1 spawned: list all TODOs", tone: "neutral",
      infoKey: "info.spawned", infoVars: { id: "explore-1", task: "list all TODOs" },
      agentId: "explore-1", // the chat groups the line into the child's thread
    });
  });

  it("keeps the root run 'running' when only the child run ends", () => {
    const state = reduceAll(initialState, withChild);
    expect(state.running).toBe(true);

    const ended = reduce(state, { type: "run_end", runId: "r1", stopReason: "end_turn", ts: 6 });
    expect(ended.running).toBe(false);
  });

  it("keeps deltas of different agents in separate turns", () => {
    const state = reduceAll(initialState, [
      ...withChild,
      { type: "text_delta", agentId: "main", text: "Summary.", ts: 7 },
    ]);
    const assistants = state.turns.filter((t) => t.kind === "assistant");
    expect(assistants).toEqual([
      { kind: "assistant", agentId: "explore-1", text: "Found 3.", thinking: "" },
      { kind: "assistant", agentId: "main", text: "Summary.", thinking: "" },
    ]);
  });
});

describe("reduce — forward compatibility and errors", () => {
  it("ignores unknown event types everywhere except the wire trace", () => {
    const unknown = { type: "telemetry_v2", agentId: "main", ts: 1 } as unknown as RunEvent;
    const state = reduce(initialState, unknown);
    expect(state.turns).toEqual([]);
    expect(state.cards).toEqual({});
    expect(state.trace.map((t) => t.type)).toEqual(["telemetry_v2"]);

    // Trace aside, an unknown event changes NOTHING about the derived state.
    const mixed = reduceAll(initialState, [...happyPath.slice(0, 3), unknown, ...happyPath.slice(3)]);
    const clean = reduceAll(initialState, happyPath);
    expect({ ...mixed, trace: [] }).toEqual({ ...clean, trace: [] });
  });

  it("renders error events as error turns", () => {
    const state = reduce(initialState, { type: "error", message: "Provider unreachable", ts: 1 });
    expect(state.turns).toEqual([{ kind: "error", text: "Provider unreachable" }]);
  });

  it("records compaction as a warn-toned info line", () => {
    const state = reduce(initialState, {
      type: "compaction", agentId: "main", removedTurns: 12, summaryChars: 2048, ts: 1,
    });
    expect(state.turns[0]).toEqual({
      kind: "info", text: "History compacted: 12 turns summarized", tone: "warn",
      infoKey: "info.compacted", infoVars: { n: 12 },
    });
  });
});

describe("reduce — image generation", () => {
  const generated: RunEvent = {
    type: "image_generated", agentId: "main", callId: "img-1",
    prompt: "a blacksmith spectroscope at dusk", provider: "gemini",
    model: "gemini-2.5-flash-image", mediaType: "image/png",
    blobPath: "/home/dev/.spectro/blobs/ab12cd.png", sha256: "ab12cd", ts: 9,
  };

  it("appends the image with all gallery fields", () => {
    const state = reduce(initialState, generated);
    expect(state.images).toEqual([
      {
        callId: "img-1", prompt: "a blacksmith spectroscope at dusk",
        provider: "gemini", model: "gemini-2.5-flash-image",
        mediaType: "image/png", blobPath: "/home/dev/.spectro/blobs/ab12cd.png",
        sha256: "ab12cd", ts: 9,
      },
    ]);
  });

  it("ignores a duplicate callId (a reconnect replays the history)", () => {
    const state = reduceAll(initialState, [generated, generated]);
    expect(state.images).toHaveLength(1);
  });

  it("keeps distinct callIds in arrival order", () => {
    const second: RunEvent = { ...generated, callId: "img-2", prompt: "the same spectroscope at noon", ts: 12 };
    const state = reduceAll(initialState, [generated, second]);
    expect(state.images.map((i) => i.callId)).toEqual(["img-1", "img-2"]);
  });

  it("fills the gallery on replay through the same reducer", () => {
    const stored: RunEvent[] = [...happyPath.slice(0, 3), generated, ...happyPath.slice(3)];
    const state = normalizeReplay(reduceAll(initialState, stored));
    expect(state.images).toHaveLength(1);
    expect(state.images[0]?.callId).toBe("img-1");
  });

  it("still ignores unknown event types without touching the gallery", () => {
    const unknown = { type: "image_upscaled", callId: "img-1", ts: 10 } as unknown as RunEvent;
    const state = reduce(reduce(initialState, generated), unknown);
    expect(state.images).toHaveLength(1);
  });
});

describe("reduce — wire trace (trace tab)", () => {
  it("records every incoming event with dir 'in', increasing seq and the raw payload", () => {
    const state = reduceAll(initialState, happyPath);
    expect(state.trace).toHaveLength(happyPath.length);
    expect(state.trace.map((t) => t.type)).toEqual(happyPath.map((e) => e.type));
    expect(state.trace.map((t) => t.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(state.trace.every((t) => t.dir === "in")).toBe(true);
    expect(state.trace[0]?.payload).toBe(happyPath[0]); // the raw event object, not a copy
    expect(state.trace[0]?.ts).toBe(1); // ts taken from the event
    expect(state.trace[0]?.agentId).toBe("main");
  });

  it("records unknown event types too — that is the point of a wire view", () => {
    const unknown = { type: "telemetry_v2", agentId: "worker-1", ts: 42 } as unknown as RunEvent;
    const state = reduce(initialState, unknown);
    expect(state.trace).toHaveLength(1);
    expect(state.trace[0]).toMatchObject({
      seq: 1, dir: "in", ts: 42, type: "telemetry_v2", agentId: "worker-1", payload: unknown,
    });
  });

  it("falls back to Date.now() when a frame carries no ts", () => {
    const before = Date.now();
    const state = reduce(initialState, { type: "mystery" } as unknown as RunEvent);
    const after = Date.now();
    expect(state.trace[0]?.ts).toBeGreaterThanOrEqual(before);
    expect(state.trace[0]?.ts).toBeLessThanOrEqual(after);
    expect(state.trace[0]?.agentId).toBeUndefined();
  });

  it("caps the trace at 5000 entries, dropping the oldest", () => {
    const flood: RunEvent[] = Array.from({ length: 5010 }, (_, i) =>
      ({ type: "text_delta", agentId: "main", text: "x", ts: i }) as RunEvent,
    );
    const state = reduceAll(initialState, flood);
    expect(state.trace).toHaveLength(5000);
    expect(state.trace[0]?.seq).toBe(11); // the first ten fell off the window
    expect(state.trace[4999]?.seq).toBe(5010);
  });

  it("recordOutgoing appends a dir 'out' entry and continues the seq counter", () => {
    const message: ClientMessage = { type: "user_message", text: "hi" };
    const state = recordOutgoing(reduceAll(initialState, happyPath), message);
    const last = state.trace[state.trace.length - 1];
    expect(last).toMatchObject({
      seq: happyPath.length + 1, dir: "out", type: "user_message", payload: message,
    });
    // Outgoing frames are trace-only: the chat model does not change.
    expect(state.turns).toEqual(reduceAll(initialState, happyPath).turns);
  });

  it("traces every ClientMessage type, not just user messages", () => {
    let state = recordOutgoing(initialState, { type: "abort" });
    state = recordOutgoing(state, { type: "permission_response", callId: "c1", allowed: false });
    state = recordOutgoing(state, { type: "set_image_provider", provider: "openai" });
    state = recordOutgoing(state, { type: "set_thinking", enabled: false });
    expect(state.trace.map((t) => [t.dir, t.type])).toEqual([
      ["out", "abort"], ["out", "permission_response"], ["out", "set_image_provider"],
      ["out", "set_thinking"],
    ]);
  });

  it("carries the additive remember/persist flags on permission_response without a new type", () => {
    const state = recordOutgoing(initialState, {
      type: "permission_response", callId: "c1", allowed: true, remember: true, persist: true,
    });
    const last = state.trace[state.trace.length - 1];
    // Same OutgoingKind — just extra optional fields on the existing frame.
    expect(last.type).toBe("permission_response");
    expect(last.payload).toMatchObject({
      type: "permission_response", callId: "c1", allowed: true, remember: true, persist: true,
    });
  });
});

describe("reduce — context_info (context ring)", () => {
  const info: RunEvent = {
    type: "context_info", agentId: "main", turn: 3, messages: 12,
    estimatedTokens: 8100, threshold: 100000,
    parts: [
      { label: "system prompt", chars: 1200, estTokens: 300 },
      { label: "history", chars: 31200, estTokens: 7800 },
    ],
    ts: 9,
  };

  it("stores the snapshot without adding a chat turn", () => {
    const state = reduce(initialState, info);
    expect(state.context).toEqual({
      turn: 3, messages: 12, estimatedTokens: 8100, threshold: 100000,
      parts: [
        { label: "system prompt", chars: 1200, estTokens: 300 },
        { label: "history", chars: 31200, estTokens: 7800 },
      ],
    });
    expect(state.turns).toHaveLength(0);
    expect(state.trace.map((t) => t.type)).toEqual(["context_info"]); // wire view sees it
  });

  it("keeps only the latest snapshot", () => {
    const later: RunEvent = { ...info, turn: 4, estimatedTokens: 9900, ts: 12 };
    const state = reduceAll(initialState, [info, later]);
    expect(state.context?.turn).toBe(4);
    expect(state.context?.estimatedTokens).toBe(9900);
  });
});

describe("reduce — lastInputTokens (context ring)", () => {
  it("tracks the last usage of the main agent only; subagents do not move it", () => {
    const state = reduceAll(initialState, [
      { type: "usage", agentId: "main", inputTokens: 2411, outputTokens: 186, ts: 1 },
      { type: "usage", agentId: "explore-1", inputTokens: 9999, outputTokens: 1, ts: 2 },
    ]);
    expect(state.lastInputTokens).toBe(2411);
  });

  it("is last-wins, not a sum — each usage reports the full request size", () => {
    const state = reduceAll(initialState, [
      { type: "usage", agentId: "main", inputTokens: 2411, outputTokens: 186, ts: 1 },
      { type: "usage", agentId: "main", inputTokens: 3050, outputTokens: 12, ts: 2 },
    ]);
    expect(state.lastInputTokens).toBe(3050);
    expect(state.usage.inputTokens).toBe(5461); // the session total still accumulates
  });

  it("adds the additive cache counts — with prompt caching the raw in is only the remainder", () => {
    // Anthropic + caching: 13 uncached in, but 1.5k rode from the cache — the
    // window really holds ~1.7k tokens and the ring must say so.
    const state = reduceAll(initialState, [
      { type: "usage", agentId: "main", inputTokens: 13, outputTokens: 1084,
        cacheReadTokens: 1500, cacheCreationTokens: 200, ts: 1 },
    ]);
    expect(state.lastInputTokens).toBe(1713);
    expect(state.usage.inputTokens).toBe(13); // totals stay raw (billing view)
  });
});

describe("replay — same reducer as live", () => {
  it("replaying a stored event list equals having lived it", () => {
    const live = happyPath.reduce(reduce, initialState); // event-by-event, as the socket delivers
    const replayed = reduceAll(initialState, happyPath); // one batch, as REST delivers
    expect(replayed).toEqual(live);
  });

  it("normalizeReplay closes running state and open questions of a torn session", () => {
    const torn: RunEvent[] = [
      { type: "run_start", runId: "r1", agentId: "main", prompt: "dangerous", ts: 1 },
      { type: "tool_call", agentId: "main", callId: "c1", name: "run_command", input: { command: "rm x" }, ts: 2 },
      { type: "permission_request", agentId: "main", callId: "c1", name: "run_command", input: { command: "rm x" }, ts: 3 },
      // no decision, no run_end — the session file just stops here
    ];
    const state = normalizeReplay(reduceAll(initialState, torn));
    expect(state.running).toBe(false);
    expect(state.pendingPermissions).toHaveLength(0);
    expect(state.cards["c1"]).toBeDefined(); // history stays visible
  });
});

describe("reduce — attachments", () => {
  const parked = { name: "photo.png", mediaType: "image/png", dataBase64: "aWJt" };
  const startWithRefs: RunEvent = {
    type: "run_start", runId: "r1", agentId: "main", prompt: "What is this?",
    provider: "anthropic",
    attachments: [{ kind: "image", mediaType: "image/png", blobPath: "/x/blobs/3f7a", sha256: "3f7a1111deadbeef" }],
    ts: 1,
  };

  it("live: the root run_start picks up the parked thumbnails and clears the outbox", () => {
    const withOutbox = { ...initialState, outboxAttachments: [parked] };
    const state = reduce(withOutbox, startWithRefs);
    expect(state.turns[0]).toEqual({
      kind: "user", text: "What is this?", attachments: [parked],
    });
    expect(state.outboxAttachments).toBeNull();
  });

  it("replay: no bytes available — a placeholder per attachment, no blob route", () => {
    const state = reduce(initialState, startWithRefs);
    expect(state.turns[0]).toEqual({
      kind: "user", text: "What is this?\n[image 3f7a1111]",
    });
  });

  it("a run_start without attachments builds the same turn as without attachments", () => {
    const state = reduce(initialState, happyPath[0]!);
    expect(state.turns[0]).toEqual({ kind: "user", text: "Summarize pom.xml" });
  });

  it("a subagent run_start never consumes the outbox", () => {
    const child: RunEvent = {
      type: "run_start", runId: "r2", agentId: "explore-1", parentId: "main",
      prompt: "look around", ts: 2,
    };
    const withOutbox = { ...initialState, outboxAttachments: [parked] };
    const state = reduce(withOutbox, child);
    expect(state.turns).toHaveLength(0);
    expect(state.outboxAttachments).toEqual([parked]); // still parked for the root run
  });
});

describe("reduce — voice input", () => {
  it("treats a bonus-2 voice_input line as audit-only: no chat turn, but visible in the trace", () => {
    // Old frontends have no case for voice_input — it must fall through to the default
    // (chat model untouched) while the wire view still records it. This mirrors the
    // Java side, where the provenance line never enters the provider history.
    const voice = {
      type: "voice_input", agentId: "main", durationMs: 3200, model: "ggml-small", ts: 0,
    } as unknown as RunEvent;

    const state = reduce(initialState, voice);
    expect(state.turns).toEqual([]);
    expect(state.trace.map((t) => t.type)).toEqual(["voice_input"]);

    // A voice turn (audit line before the run) derives the SAME chat as a typed one.
    const withVoice = reduceAll(initialState, [voice, ...happyPath]);
    const typed = reduceAll(initialState, happyPath);
    expect({ ...withVoice, trace: [] }).toEqual({ ...typed, trace: [] });
  });
});

describe("reduce — plan snapshot (latest-wins)", () => {
  const plan = (steps: { text: string; status: string }[], ts: number): RunEvent =>
    ({ type: "plan", agentId: "main", steps, ts }) as RunEvent;

  it("starts null and is set by a plan event", () => {
    expect(initialState.plan).toBeNull();
    const s = reduceAll(initialState, [
      plan([{ text: "read files", status: "completed" }], 1),
    ]);
    expect(s.plan).toEqual([{ text: "read files", status: "completed" }]);
  });

  it("the latest plan fully replaces the previous one", () => {
    const s = reduceAll(initialState, [
      plan([{ text: "a", status: "pending" }, { text: "b", status: "pending" }], 1),
      plan([{ text: "a", status: "completed" }], 2),
    ]);
    expect(s.plan).toEqual([{ text: "a", status: "completed" }]);
  });

  it("a fresh state (New chat) resets the plan", () => {
    expect(initialState.plan).toBeNull();
  });
});

describe("workspace_info (socket-only frame)", () => {
  it("stores the announcement and keeps it out of the turn flow", () => {
    const frame = {
      type: "workspace_info", sessionId: "s-1",
      path: "/tmp/spectroscope-ws/s-1", configured: false, ts: 1,
    } as unknown as RunEvent;
    const s = reduce(initialState, frame);
    expect(s.workspace).toEqual({ sessionId: "s-1", path: "/tmp/spectroscope-ws/s-1", configured: false });
    expect(s.turns).toHaveLength(0);
    // the trace still shows the frame — that is the didactic point
    expect(s.trace[s.trace.length - 1].type).toBe("workspace_info");
  });
});

describe("provider_info (socket-only frame)", () => {
  it("announces the active backend, latest wins, and stays out of the turn flow", () => {
    const boot = {
      type: "provider_info", provider: "ollama", model: "qwen3",
      host: "localhost:11434", ts: 1,
    } as unknown as RunEvent;
    const s1 = reduce(initialState, boot);
    expect(s1.providerInfo).toEqual({ provider: "ollama", model: "qwen3", host: "localhost:11434" });
    expect(s1.provider).toBe("ollama");
    expect(s1.turns).toHaveLength(0);
    expect(s1.trace[s1.trace.length - 1].type).toBe("provider_info");

    // The switch frame replaces the announcement — the chip follows the wire.
    const switched = {
      type: "provider_info", provider: "anthropic", model: "claude-opus-4-8",
      host: "api.anthropic.com", ts: 2,
    } as unknown as RunEvent;
    const s2 = reduce(s1, switched);
    expect(s2.providerInfo).toEqual({
      provider: "anthropic", model: "claude-opus-4-8", host: "api.anthropic.com",
    });
    expect(s2.provider).toBe("anthropic");
  });
});

describe("permission_mode_info (socket-only frame)", () => {
  it("folds the permission_mode_info frame", () => {
    const frame = { type: "permission_mode_info", mode: "auto", ts: 1 } as unknown as RunEvent;
    const next = reduce(initialState, frame);
    expect(next.permissionMode).toBe("auto");
  });
});
