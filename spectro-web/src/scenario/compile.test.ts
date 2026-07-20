import { describe, it, expect } from "vitest";
import { compile } from "./compile";
import type { Dsl } from "./dsl";

const BASE = 1_783_000_000_000;

const tiny: Dsl = {
  id: "tiny",
  name: { en: "Tiny", de: "Winzig" },
  prompt: { en: "Hello", de: "Hallo" },
  provider: "ollama",
  steps: [{ think: { en: "hmm", de: "hm" } }, { say: { en: "Hi there", de: "Hallo dort" } }],
};

describe("compile core", () => {
  it("opens with run_start + turn_start and a context_info seed", () => {
    const ev = compile(tiny, "en", BASE);
    expect(ev[0]).toMatchObject({ type: "run_start", agentId: "main", prompt: "Hello", provider: "ollama" });
    expect(ev[1]).toMatchObject({ type: "turn_start", agentId: "main", turn: 1 });
    expect(ev[2]).toMatchObject({ type: "context_info", agentId: "main" });
  });

  it("resolves localized text per language", () => {
    const de = compile(tiny, "de", BASE);
    expect(de[0]).toMatchObject({ prompt: "Hallo" });
    expect(de.find((e) => e.type === "thinking_delta")).toMatchObject({ text: "hm" });
    expect(de.find((e) => e.type === "text_delta")).toMatchObject({ text: "Hallo dort" });
  });

  it("localizes the auto-seeded context part labels", () => {
    const en = compile(tiny, "en", BASE)[2] as { parts: { label: string }[] };
    const de = compile(tiny, "de", BASE)[2] as { parts: { label: string }[] };
    expect(en.parts.map((p) => p.label)).toEqual(["system prompt", "tool schemas", "conversation"]);
    expect(de.parts.map((p) => p.label)).toEqual(["System-Prompt", "Tool-Schemas", "Konversation"]);
  });

  it("ends with a trailing usage + run_end", () => {
    const ev = compile(tiny, "en", BASE);
    expect(ev[ev.length - 2].type).toBe("usage");
    expect(ev[ev.length - 1]).toMatchObject({ type: "run_end", stopReason: "end_turn" });
  });

  it("assigns deterministic monotonic timestamps", () => {
    const ev = compile(tiny, "en", BASE);
    ev.forEach((e, i) => expect(e.ts).toBe(BASE + i * 1200));
  });

  it("emits only known RunEvent types", () => {
    const known = new Set(["run_start","turn_start","text_delta","thinking_delta","tool_call","permission_request","permission_decision","tool_result","agent_spawn","compaction","usage","run_end","error","image_generated","context_info","agent_message"]);
    for (const e of compile(tiny, "en", BASE)) expect(known.has(e.type)).toBe(true);
  });
});

const toolsDsl: Dsl = {
  id: "tools", name: "Tools", prompt: "do stuff", provider: "ollama",
  steps: [
    { read: "src/Main.java", result: "class Main {}" },
    { run: "./gradlew test" },                       // default gate allow
    { run: "rm -rf x", gate: "deny" },               // denied
    { mcp: "notes__search_notes", input: { query: "q" }, gate: "deny" },
  ],
};

describe("compile tools + gates", () => {
  const ev = compile(toolsDsl, "en");
  const byType = (t: string) => ev.filter((e) => e.type === t);

  it("read_file emits tool_call + tool_result (no permission)", () => {
    const call = byType("tool_call").find((e: any) => e.name === "read_file") as any;
    expect(call.input).toEqual({ path: "src/Main.java" });
    const res = byType("tool_result").find((e: any) => e.callId === call.callId) as any;
    expect(res.output).toBe("class Main {}");
    expect(res.isError).toBe(false);
  });

  it("run_command default-gates allow: request + decision(true) + ok result", () => {
    const call = byType("tool_call").find((e: any) => e.name === "run_command" && e.input.command === "./gradlew test") as any;
    const dec = byType("permission_decision").find((e: any) => e.callId === call.callId) as any;
    expect(dec.allowed).toBe(true);
  });

  it("gate deny produces decision(false) + error result", () => {
    const call = byType("tool_call").find((e: any) => e.input?.command === "rm -rf x") as any;
    const dec = byType("permission_decision").find((e: any) => e.callId === call.callId) as any;
    const res = byType("tool_result").find((e: any) => e.callId === call.callId) as any;
    expect(dec.allowed).toBe(false);
    expect(res.isError).toBe(true);
    expect(res.output).toMatch(/denied/i);
  });

  it("mcp expands to mcp__server__tool with permission", () => {
    const call = byType("tool_call").find((e: any) => e.name === "mcp__notes__search_notes") as any;
    expect(call).toBeTruthy();
    expect(byType("permission_request").some((e: any) => e.callId === call.callId)).toBe(true);
  });
});

const spawnDsl: Dsl = {
  id: "sp", name: "Spawn", prompt: "plan it", provider: "ollama",
  steps: [
    { think: "delegate" },
    { spawn: "worker-1", label: "build_plan", task: { en: "Plan the flag", de: "Plane das Flag" },
      steps: [{ think: "load skill" }, { status: "drafting" }, { say: "# Plan" }] },
    { say: "here is the plan" },
  ],
};
const fanoutDsl: Dsl = {
  id: "fo", name: "Fan", prompt: "review", provider: "ollama",
  steps: [
    { fanout: { label: "review", tool: "review", agents: [
      { id: "bugs", task: "find bugs", steps: [{ think: "nulls" }, { say: "## Bugs" }] },
      { id: "perf", task: "check perf", steps: [{ think: "n+1" }, { say: "## Perf" }] },
    ] } },
    { say: "summary" },
  ],
};

describe("compile subagents", () => {
  it("spawn wraps a parent build_plan call around the child lifecycle", () => {
    const ev = compile(spawnDsl, "en");
    const parentCall = ev.find((e: any) => e.type === "tool_call" && e.name === "build_plan") as any;
    expect(parentCall).toBeTruthy();
    expect(ev.some((e: any) => e.type === "agent_spawn" && e.agentId === "worker-1")).toBe(true);
    expect(ev.some((e: any) => e.type === "agent_message" && e.role === "task" && e.to === "worker-1")).toBe(true);
    expect(ev.some((e: any) => e.type === "run_start" && e.agentId === "worker-1")).toBe(true);
    expect(ev.some((e: any) => e.type === "agent_message" && e.role === "status" && e.from === "worker-1")).toBe(true);
    expect(ev.some((e: any) => e.type === "agent_message" && e.role === "result" && e.from === "worker-1")).toBe(true);
    const parentResult = ev.filter((e: any) => e.type === "tool_result" && e.callId === parentCall.callId);
    expect(parentResult.length).toBe(1);
  });

  it("child text/think events carry the child agentId", () => {
    const ev = compile(spawnDsl, "en");
    expect(ev.some((e: any) => e.type === "thinking_delta" && e.agentId === "worker-1")).toBe(true);
    expect(ev.some((e: any) => e.type === "text_delta" && e.agentId === "worker-1")).toBe(true);
  });

  it("fanout emits one parent tool_call, N spawns, round-robin child steps, one result", () => {
    const ev = compile(fanoutDsl, "en");
    expect(ev.filter((e: any) => e.type === "tool_call" && e.name === "review").length).toBe(1);
    expect(ev.filter((e: any) => e.type === "agent_spawn").length).toBe(2);
    const spawnIdx = ev.findIndex((e: any) => e.type === "run_start" && e.agentId === "bugs");
    const perfStart = ev.findIndex((e: any) => e.type === "run_start" && e.agentId === "perf");
    const firstBugsThink = ev.findIndex((e: any) => e.type === "thinking_delta" && e.agentId === "bugs");
    // both children start before the first child think (round-robin, not sequential)
    expect(perfStart).toBeGreaterThan(spawnIdx);
    expect(firstBugsThink).toBeGreaterThan(perfStart);
  });

  it("folds through advanceScene to a clean terminal scene", async () => {
    const { advanceScene, initialScene } = await import("../lab/labScene");
    const scene = compile(spawnDsl, "en").reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Full child-step support: subagents may also write/list/run/mcp/tool, with
// the same permission-gate semantics as the main agent.
// ---------------------------------------------------------------------------
const richChild: Dsl = {
  id: "rc", name: "RichChild", prompt: "do it", provider: "ollama",
  steps: [
    { spawn: "w1", label: "develop", task: "implement it", steps: [
      { think: "plan the edit" },
      { write: "src/App.tsx", result: "ok, wrote 1 file" },
      { run: "npm test", gate: "allow", result: "12 passed" },
      { run: "rm -rf /", gate: "deny" },
      { mcp: "notes__search_notes", input: { query: "q" }, gate: "allow" },
      { say: "done" },
    ] },
    { say: "child finished" },
  ],
};

describe("compile full child steps", () => {
  const ev = compile(richChild, "en");

  it("child write/run/mcp events carry the child agentId", () => {
    expect(ev.some((e) => e.type === "tool_call" && e.name === "write_file" && e.agentId === "w1")).toBe(true);
    expect(ev.some((e) => e.type === "tool_call" && e.name === "run_command" && e.agentId === "w1")).toBe(true);
    expect(ev.some((e) => e.type === "tool_call" && e.name === "mcp__notes__search_notes" && e.agentId === "w1")).toBe(true);
  });

  it("child gates emit permission pairs owned by the child", () => {
    const req = ev.filter((e) => e.type === "permission_request" && e.agentId === "w1");
    expect(req.length).toBe(3); // 2x run + 1x mcp
    const denied = ev.find((e) => e.type === "tool_call" && e.agentId === "w1" && (e.input as { command?: string }).command === "rm -rf /");
    expect(denied).toBeTruthy();
    const callId = (denied as { callId: string }).callId;
    expect(ev.some((e) => e.type === "permission_decision" && e.callId === callId && !e.allowed)).toBe(true);
    expect(ev.some((e) => e.type === "tool_result" && e.callId === callId && e.isError)).toBe(true);
  });

  it("mid-run the denied child gate reddens ONLY the child loop", async () => {
    const { advanceScene, initialScene } = await import("../lab/labScene");
    const denied = ev.find((e) => e.type === "tool_call" && e.agentId === "w1" && (e.input as { command?: string }).command === "rm -rf /") as { callId: string };
    const decIdx = ev.findIndex((e) => e.type === "permission_decision" && e.callId === denied.callId);
    const scene = ev.slice(0, decIdx + 1).reduce(advanceScene, initialScene());
    expect(scene.subagents[0].gate).toBe("denied");
    expect(scene.subagents[0].isError).toBe(true);
    expect(scene.isError).toBe(false);
  });

  it("still folds to a clean terminal scene", async () => {
    const { advanceScene, initialScene } = await import("../lab/labScene");
    const scene = ev.reduce(advanceScene, initialScene());
    expect(scene.focus).toBe("user");
    expect(scene.subagents.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Compaction: a `compact` step emits the compaction event and re-seeds
// context_info with the SHRUNKEN conversation.
// ---------------------------------------------------------------------------
describe("compile compact step", () => {
  const dsl: Dsl = {
    id: "cp", name: "Compact", prompt: "long run", provider: "ollama",
    steps: [
      { think: "a".repeat(4000) },
      { compact: { removedTurns: 6, summaryChars: 800 } },
      { say: "continuing after compaction" },
    ],
  };
  const ev = compile(dsl, "en");

  it("emits a compaction event with the DSL numbers", () => {
    expect(ev.some((e) => e.type === "compaction" && e.removedTurns === 6 && e.summaryChars === 800)).toBe(true);
  });

  it("re-seeds context_info smaller after the compaction", () => {
    const infos = ev.filter((e) => e.type === "context_info");
    expect(infos.length).toBeGreaterThanOrEqual(2);
    const before = infos[0];
    const after = infos[infos.length - 1];
    const compIdx = ev.findIndex((e) => e.type === "compaction");
    expect(ev.indexOf(after)).toBeGreaterThan(compIdx);
    const convo = (i: typeof before) => i.parts.find((p) => p.label === "conversation")!.chars;
    expect(convo(after)).toBe(800);
    expect(convo(after)).toBeLessThan(convo(before) + 4000);
  });
});
