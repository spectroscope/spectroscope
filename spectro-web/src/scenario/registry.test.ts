import { describe, it, expect } from "vitest";
import { SCENARIOS } from "./registry";
import { compile } from "./compile";
import { advanceScene, initialScene } from "../lab/labScene";
import type { RunEvent } from "../events";

type ToolCall = Extract<RunEvent, { type: "tool_call" }>;

describe("registry", () => {
  it("has the built-in scenarios", () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual([
      "adversarial",
      "agentsmd",
      "bughunt",
      "buildplan",
      "codereview",
      "coding",
      "context",
      "darkmode",
      "diskshell",
      "fanout",
      "fleetswarm",
      "imagegen",
      "permission",
      "research",
    ]);
  });

  it("the fleet-tagged scenarios are the genuinely multi-agent ones", () => {
    const fleetIds = SCENARIOS.filter((s) => s.fleet)
      .map((s) => s.id)
      .sort();
    expect(fleetIds).toEqual(["codereview", "coding", "fanout", "fleetswarm", "research"]);
    // every fleet scenario compiles to a stream with at least one agent_spawn.
    for (const s of SCENARIOS.filter((x) => x.fleet)) {
      expect(
        compile(s, "en").some((e) => e.type === "agent_spawn"),
        s.id,
      ).toBe(true);
    }
  });

  it("context scenario: the window fills to 'high', then a compaction shrinks it", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "context")!,
      "en",
    );
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

  it("codereview scenario writes a target then fans out three reviewers", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "codereview")!,
      "en",
    );
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3);
    expect(ev.some((e) => e.type === "tool_call" && e.agentId === "main" && e.name === "write_file")).toBe(
      true,
    );
  });

  it("imagegen scenario emits two image_generated events with provider, model and blob path", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "imagegen")!,
      "en",
    );
    const imgs = ev.filter(
      (e): e is Extract<RunEvent, { type: "image_generated" }> => e.type === "image_generated",
    );
    expect(imgs.length).toBe(2);
    expect(imgs[0].provider).toBe("gemini");
    expect(imgs[0].model).toBe("imagen-3.0");
    expect(imgs[0].blobPath).toContain(".spectro/images/");
    expect(imgs[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agentsmd scenario: reads AGENTS.md and honours it — runs the tests through an allowed gate", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "agentsmd")!,
      "en",
    );
    // The agent reads the workspace AGENTS.md.
    expect(ev.some((e) => e.type === "tool_call" && e.name === "read_file")).toBe(true);
    // It edits the source template, never the generated/ file.
    const writes = ev.filter((e): e is ToolCall => e.type === "tool_call" && e.name === "write_file");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.every((w) => !JSON.stringify(w.input ?? {}).includes("generated/"))).toBe(true);
    // It runs the tests through an allowed gate before finishing.
    const test = ev.find((e) => e.type === "tool_call" && e.agentId === "main" && e.name === "run_command");
    expect(test).toBeTruthy();
    expect(
      ev.some(
        (e) =>
          e.type === "permission_decision" && e.callId === (test as { callId: string }).callId && e.allowed,
      ),
    ).toBe(true);
  });

  it("coding scenario: phases with a planner spawn and two parallel implementers that WRITE", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "coding")!,
      "en",
    );
    // ≤3 children total (the map renders at most 3 subagent loops per run)
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3);
    // implement phase: two different children each write a file
    const childWrites = ev.filter(
      (e): e is ToolCall => e.type === "tool_call" && e.name === "write_file" && e.agentId !== "main",
    );
    expect(new Set(childWrites.map((e) => e.agentId)).size).toBe(2);
    // verify phase: main runs the tests through an allowed gate
    const test = ev.find((e) => e.type === "tool_call" && e.agentId === "main" && e.name === "run_command");
    expect(test).toBeTruthy();
    expect(
      ev.some(
        (e) =>
          e.type === "permission_decision" && e.callId === (test as { callId: string }).callId && e.allowed,
      ),
    ).toBe(true);
  });

  it("research scenario: parallel researchers, consolidation, then a critic subagent", () => {
    const ev = compile(
      SCENARIOS.find((s) => s.id === "research")!,
      "en",
    );
    expect(ev.filter((e) => e.type === "agent_spawn").length).toBe(3); // 2 researchers + 1 critic
    // researchers hit MCP sources from inside their child loops
    expect(ev.some((e) => e.type === "tool_call" && e.name.startsWith("mcp__") && e.agentId !== "main")).toBe(
      true,
    );
    // the critic is spawned AFTER both researcher results are in (consolidate-then-review)
    const researcherResults = ev
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "agent_message" && e.role === "result")
      .map(({ i }) => i);
    const spawns = ev
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.type === "agent_spawn")
      .map(({ i }) => i);
    const criticSpawn = spawns[2];
    expect(criticSpawn).toBeGreaterThan(researcherResults[1]);
  });
});
