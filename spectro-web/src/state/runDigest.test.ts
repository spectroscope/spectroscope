// The run digest (card 294): the compact, deterministic text an OPT-IN
// analysis sends to the provider. These pins are the consent dialog's honesty:
// the digest is exactly reproducible from the events (so what the dialog says
// leaves the machine IS what leaves), every free-text field is capped, and a
// cut is stated inside the digest itself rather than silently applied.
import { describe, expect, it } from "vitest";
import type { RunEvent } from "../events";
import { DIGEST_CAP_CHARS, MAX_DIGEST_AGENTS, buildRunDigest, isLoopbackAddress } from "./runDigest";

const T0 = 1735000000000;

/** A small imported run: main agent, one spawned child that reported back. */
function smallRun(): RunEvent[] {
  return [
    {
      type: "run_start",
      runId: "r1",
      agentId: "main",
      prompt: "Refactor the parser and keep the tests green",
      provider: "ollama",
      model: "glm-5.2:cloud",
      ts: T0,
    },
    {
      type: "agent_spawn",
      agentId: "child-1",
      parentId: "main",
      task: "Scout the parser module",
      ts: T0 + 1000,
    },
    {
      type: "run_start",
      runId: "r2",
      agentId: "child-1",
      parentId: "main",
      prompt: "Scout the parser module",
      model: "claude-haiku-5",
      ts: T0 + 1100,
    },
    {
      type: "agent_message",
      from: "child-1",
      to: "main",
      role: "status",
      state: "working",
      text: "reading parser.ts",
      ts: T0 + 2000,
    },
    { type: "usage", agentId: "child-1", inputTokens: 900, outputTokens: 120, ts: T0 + 2500 },
    {
      type: "agent_message",
      from: "child-1",
      to: "main",
      role: "result",
      state: "completed",
      text: "The parser has two entry points; the second is dead code.",
      ts: T0 + 3000,
    },
    { type: "text_delta", agentId: "main", text: "Refactored. ", ts: T0 + 4000 },
    { type: "text_delta", agentId: "main", text: "The dead entry point is gone.", ts: T0 + 4100 },
    { type: "usage", agentId: "main", inputTokens: 4000, outputTokens: 350, ts: T0 + 4200 },
    { type: "run_end", runId: "r1", stopReason: "end_turn", ts: T0 + 5000 },
  ];
}

describe("buildRunDigest — the run frame", () => {
  it("carries prompt, provider, model, duration and stop reason", () => {
    const digest = buildRunDigest(smallRun());
    expect(digest.text).toContain("Refactor the parser and keep the tests green");
    expect(digest.text).toContain("provider: ollama");
    expect(digest.text).toContain("model: glm-5.2:cloud");
    expect(digest.text).toContain("duration: 5s");
    expect(digest.text).toContain("stop: end_turn");
  });

  it("carries the main agent's answer tail and token counts", () => {
    const digest = buildRunDigest(smallRun());
    expect(digest.text).toContain("The dead entry point is gone.");
    expect(digest.text).toContain("in=4000 out=350");
  });

  it("names its own derivation, so the model knows it reads a digest", () => {
    const digest = buildRunDigest(smallRun());
    expect(digest.text.startsWith("run digest")).toBe(true);
  });

  it("stays standing on an empty stream", () => {
    const digest = buildRunDigest([]);
    expect(digest.agents).toBe(0);
    expect(digest.text).toContain("no run frame recorded");
  });
});

describe("buildRunDigest — the agents", () => {
  it("gives each spawned agent its task, result, state, model and tokens", () => {
    const digest = buildRunDigest(smallRun());
    expect(digest.text).toContain("Scout the parser module");
    expect(digest.text).toContain("The parser has two entry points; the second is dead code.");
    expect(digest.text).toContain("state=completed");
    expect(digest.text).toContain("model=claude-haiku-5");
    expect(digest.text).toContain("in=900 out=120");
    expect(digest.agents).toBe(1);
  });

  it("falls back to the last status line when no result ever came", () => {
    const events = smallRun().filter((e) => !(e.type === "agent_message" && e.role === "result"));
    const digest = buildRunDigest(events);
    expect(digest.text).toContain("reading parser.ts");
  });
});

describe("buildRunDigest — determinism", () => {
  it("is byte-identical across two builds of the same events", () => {
    const events = smallRun();
    const first = buildRunDigest(events);
    const second = buildRunDigest(structuredClone(events));
    expect(second.text).toBe(first.text);
    expect(second.truncated).toBe(first.truncated);
  });
});

describe("buildRunDigest — the caps, each bitten separately", () => {
  it("caps a single long field with a visible cut mark", () => {
    const events = smallRun();
    const start = events[0];
    if (start.type === "run_start") start.prompt = "p".repeat(5000);
    const digest = buildRunDigest(events);
    expect(digest.text).not.toContain("p".repeat(1000));
    expect(digest.text).toContain("p".repeat(300) /* the kept head */);
    expect(digest.text).toContain("…");
  });

  it("caps the agent list and says how many it kept", () => {
    const events: RunEvent[] = [
      {
        type: "run_start",
        runId: "r1",
        agentId: "main",
        prompt: "spawn a lot",
        provider: "ollama",
        model: "m",
        ts: T0,
      },
    ];
    for (let i = 0; i < MAX_DIGEST_AGENTS + 10; i++) {
      events.push({
        type: "agent_spawn",
        agentId: `c${String(i).padStart(3, "0")}`,
        parentId: "main",
        task: `task ${i}`,
        ts: T0 + i,
      });
    }
    const digest = buildRunDigest(events);
    expect(digest.agents).toBe(MAX_DIGEST_AGENTS + 10);
    expect(digest.shown).toBe(MAX_DIGEST_AGENTS);
    expect(digest.truncated).toBe(true);
    expect(digest.text).toContain(`${MAX_DIGEST_AGENTS + 10} recorded, ${MAX_DIGEST_AGENTS} in this digest`);
  });

  it("hard-caps the whole text and states the cut inside the text", () => {
    const events: RunEvent[] = [
      {
        type: "run_start",
        runId: "r1",
        agentId: "main",
        prompt: "big",
        provider: "ollama",
        model: "m",
        ts: T0,
      },
    ];
    for (let i = 0; i < MAX_DIGEST_AGENTS; i++) {
      events.push({
        type: "agent_spawn",
        agentId: `c${i}`,
        parentId: "main",
        task: "x".repeat(4000),
        ts: T0 + i,
      });
      events.push({
        type: "agent_message",
        from: `c${i}`,
        to: "main",
        role: "result",
        state: "completed",
        text: "y".repeat(4000),
        ts: T0 + 1000 + i,
      });
    }
    const digest = buildRunDigest(events);
    expect(digest.text.length).toBeLessThanOrEqual(DIGEST_CAP_CHARS);
    expect(digest.truncated).toBe(true);
    expect(digest.text).toContain("[digest cut at");
  });

  it("does not claim a cut when nothing was cut", () => {
    const digest = buildRunDigest(smallRun());
    expect(digest.truncated).toBe(false);
    expect(digest.text).not.toContain("[digest cut at");
  });
});

describe("isLoopbackAddress — the stays-on-this-machine line", () => {
  it("recognises the loopback shapes", () => {
    expect(isLoopbackAddress("localhost:11434")).toBe(true);
    expect(isLoopbackAddress("localhost")).toBe(true);
    expect(isLoopbackAddress("127.0.0.1:1234")).toBe(true);
    expect(isLoopbackAddress("[::1]:8080")).toBe(true);
  });

  it("never flatters a remote address", () => {
    expect(isLoopbackAddress("api.anthropic.com")).toBe(false);
    expect(isLoopbackAddress("100.90.57.62:1234")).toBe(false);
    expect(isLoopbackAddress("localhost.evil.example")).toBe(false);
    expect(isLoopbackAddress("")).toBe(false);
  });
});
