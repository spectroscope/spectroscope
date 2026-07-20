import { describe, it, expect } from "vitest";
import { SCENARIOS } from "./registry";
import { compile } from "./compile";
import { advanceScene, initialScene } from "../lab/labScene";
import type { RunEvent } from "../events";

type ToolCall = Extract<RunEvent, { type: "tool_call" }>;

describe("registry", () => {
  it("has the built-in scenarios", () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(["buildplan", "coding", "context", "diskshell", "fanout", "permission", "research"]);
  });

  it("context scenario: the window fills to 'high', then a compaction shrinks it", () => {
    const ev = compile(SCENARIOS.find((s) => s.id === "context")!, "en");
    const compIdx = ev.findIndex((e) => e.type === "compaction");
    expect(compIdx).toBeGreaterThan(0);
    const infos = ev.filter((e) => e.type === "context_info");
    const peak = Math.max(...infos.map((i) => i.estimatedTokens));
    expect(peak / infos[0].threshold).toBeGreaterThan(0.6); // visibly fills the gauge
    const after = infos.filter((i) => ev.indexOf(i) > compIdx);
    expect(after.length).toBeGreaterThan(0);
    expect(after[0].estimatedTokens).toBeLessThan(peak / 3); // compaction visibly shrinks it
  });

  it("every scenario compiles in both languages to a clean terminal scene", () => {
    for (const dsl of SCENARIOS) {
      for (const lang of ["en", "de"] as const) {
        const events = compile(dsl, lang);
        expect(events.length).toBeGreaterThan(3);
        const scene = events.reduce(advanceScene, initialScene());
        expect(scene.focus, `${dsl.id}/${lang}`).toBe("user");
        expect(scene.subagents.length).toBe(0);
      }
    }
  });

  it("en and de compile to identical event counts (structure is language-independent)", () => {
    for (const dsl of SCENARIOS) {
      expect(compile(dsl, "en").length).toBe(compile(dsl, "de").length);
    }
  });

  it("fanout scenario spawns three reviewers", () => {
    const fo = SCENARIOS.find((s) => s.id === "fanout")!;
    const ev = compile(fo, "en");
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3);
  });

  it("coding scenario: phases with a planner spawn and two parallel implementers that WRITE", () => {
    const ev = compile(SCENARIOS.find((s) => s.id === "coding")!, "en");
    // ≤3 children total (the map renders at most 3 subagent loops per run)
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3);
    // implement phase: two different children each write a file
    const childWrites = ev.filter((e): e is ToolCall => e.type === "tool_call" && e.name === "write_file" && e.agentId !== "main");
    expect(new Set(childWrites.map((e) => e.agentId)).size).toBe(2);
    // verify phase: main runs the tests through an allowed gate
    const test = ev.find((e) => e.type === "tool_call" && e.agentId === "main" && e.name === "run_command");
    expect(test).toBeTruthy();
    expect(ev.some((e) => e.type === "permission_decision" && e.callId === (test as { callId: string }).callId && e.allowed)).toBe(true);
  });

  it("research scenario: parallel researchers, consolidation, then a critic subagent", () => {
    const ev = compile(SCENARIOS.find((s) => s.id === "research")!, "en");
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3); // 2 researchers + 1 critic
    // researchers hit MCP sources from inside their child loops
    expect(ev.some((e) => e.type === "tool_call" && e.name.startsWith("mcp__") && e.agentId !== "main")).toBe(true);
    // the critic is spawned AFTER both researcher results are in (consolidate-then-review)
    const researcherResults = ev.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "agent_message" && e.role === "result").map(({ i }) => i);
    const spawns = ev.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "agent_spawn").map(({ i }) => i);
    const criticSpawn = spawns[2];
    expect(criticSpawn).toBeGreaterThan(researcherResults[1]);
  });
});
