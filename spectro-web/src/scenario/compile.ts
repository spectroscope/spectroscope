// compile(dsl, lang) -> RunEvent[], ported from the LLM_Simulator. The
// compiler assigns callIds/runIds/timestamps, expands permission-gate triples
// (run/mcp default "allow", gate: "deny" for the red path), emits auto-growing
// context_info seeds (compact emits a compaction and re-seeds small), and
// unrolls subagent lifecycles (spawn = single child, fanout = N children
// round-robin so they visibly run in parallel). The output rides the SAME
// replay path as a stored session — no new event type, no wire change.

import type { RunEvent } from "../events";
import type { Dsl, Gate, Lang, Step } from "./dsl";
import { loc } from "./dsl";

const TOOL_SCHEMA_CHARS = 4224; // fixed estimate, matches the demo
/** The compaction threshold every scenario's context meter runs against. */
const CONTEXT_THRESHOLD_TOKENS = 100000;
/** Stage-craft: how long a subagent wrapper call appears to have taken. */
const SUBAGENT_RESULT_DURATION_MS = 21400;
/** Synthetic timestamp spacing between consecutive events. */
const EVENT_SPACING_MS = 1200;
const estTok = (chars: number) => Math.round(chars / 4);

// Plain `Omit<RunEvent, "ts">` doesn't work here: `keyof` on a union type
// collapses to only the keys common to every member (just "type" and "ts"),
// so a non-distributive Omit would erase every variant-specific field
// (agentId, runId, ...) and reject them as excess properties. Distributing
// the Omit over each union member first keeps each variant's own fields.
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export function compile(dsl: Dsl, lang: Lang, baseTs = 1_783_000_000_000): RunEvent[] {
  const out: RunEvent[] = [];
  const runId = `${dsl.id}-main`;
  const sys = dsl.system ? loc(dsl.system, lang) : "";
  let convoChars = loc(dsl.prompt, lang).length; // conversation grows as text streams
  let callSeq = 0;
  const nextCall = () => `${dsl.id}-c${++callSeq}`;
  const push = (e: DistributiveOmit<RunEvent, "ts">) => out.push({ ...e, ts: 0 } as RunEvent);

  const seedContext = (turn: number) => {
    push({ type: "context_info", agentId: "main", turn, messages: turn,
      estimatedTokens: estTok(sys.length + TOOL_SCHEMA_CHARS + convoChars), threshold: CONTEXT_THRESHOLD_TOKENS,
      parts: [
        { label: loc({ en: "system prompt", de: "System-Prompt" }, lang), chars: sys.length, estTokens: estTok(sys.length) },
        { label: loc({ en: "tool schemas", de: "Tool-Schemas" }, lang), chars: TOOL_SCHEMA_CHARS, estTokens: estTok(TOOL_SCHEMA_CHARS) },
        { label: loc({ en: "conversation", de: "Konversation" }, lang), chars: convoChars, estTokens: estTok(convoChars) },
      ] });
  };

  push({ type: "run_start", runId, agentId: "main", prompt: loc(dsl.prompt, lang), provider: dsl.provider ?? "ollama" });
  push({ type: "turn_start", agentId: "main", turn: 1 });
  seedContext(1);

  // Tool expansion is agent-agnostic: the SAME helpers serve the main agent and
  // every subagent — a child's gated call raises its own permission pair, which
  // advanceScene routes back to that child's loop via the callId owner map.
  const diskTool = (agentId: string, name: "read_file" | "write_file" | "list_dir", path: string, result: string | undefined, defOut: string) => {
    const callId = nextCall();
    push({ type: "tool_call", agentId, callId, name, input: { path } });
    push({ type: "tool_result", agentId, callId, output: result ?? defOut, isError: false, durationMs: 3 });
  };
  const gatedTool = (agentId: string, name: string, input: Record<string, unknown>, gate: Gate | undefined, result: string | undefined, error: boolean | undefined, needsGate: boolean) => {
    const callId = nextCall();
    push({ type: "tool_call", agentId, callId, name, input });
    let denied = false;
    if (needsGate || gate) {
      const allowed = gate !== "deny";
      denied = !allowed;
      push({ type: "permission_request", agentId, callId, name, input });
      push({ type: "permission_decision", callId, allowed });
    }
    const isError = denied || error === true;
    const output = denied ? "ERROR: the user denied the execution." : (result ?? "ok");
    push({ type: "tool_result", agentId, callId, output, isError, durationMs: denied ? 200 : 40 });
  };

  const childSteps = (childId: string, steps: Step[]) => {
    for (const s of steps) {
      if ("think" in s) push({ type: "thinking_delta", agentId: childId, text: loc(s.think, lang) });
      else if ("say" in s) push({ type: "text_delta", agentId: childId, text: loc(s.say, lang) });
      else if ("status" in s) {
        const callId = nextCall();
        push({ type: "tool_call", agentId: childId, callId, name: "report_status", input: { message: loc(s.status, lang) } });
        push({ type: "agent_message", from: childId, to: "main", role: "status", state: "working", text: loc(s.status, lang) });
        push({ type: "tool_result", agentId: childId, callId, output: "ok", isError: false, durationMs: 0 });
      }
      else if ("read" in s) diskTool(childId, "read_file", s.read, s.result ? loc(s.result, lang) : undefined, "(file)");
      else if ("write" in s) diskTool(childId, "write_file", s.write, s.result ? loc(s.result, lang) : undefined, "ok, wrote 1 file");
      else if ("list" in s) diskTool(childId, "list_dir", s.list, s.result ? loc(s.result, lang) : undefined, "a.ts\nb.ts");
      else if ("run" in s) gatedTool(childId, "run_command", { command: s.run }, s.gate, s.result ? loc(s.result, lang) : undefined, s.error, true);
      else if ("mcp" in s) {
        const [server, tool] = s.mcp.split("__");
        gatedTool(childId, `mcp__${server}__${tool}`, s.input ?? {}, s.gate, s.result ? loc(s.result, lang) : undefined, s.error, true);
      }
      else if ("tool" in s) gatedTool(childId, s.tool, s.input ?? {}, s.gate, s.result ? loc(s.result, lang) : undefined, s.error, false);
      // spawn/fanout stay top-level only: no nested subagents (the scene model
      // and the map render exactly one level of children).
    }
  };

  // One child's full lifecycle: wrapper call, spawn + task pair, its run,
  // then run_end + result message + the wrapper's tool_result.
  const expandSpawn = (step: Extract<Step, { spawn: string }>) => {
    const label = step.label ?? step.spawn;
    const parentCall = nextCall();
    const task = loc(step.task, lang);
    push({ type: "tool_call", agentId: "main", callId: parentCall, name: label, input: { task } });
    push({ type: "agent_spawn", agentId: step.spawn, parentId: "main", task });
    push({ type: "agent_message", from: "main", to: step.spawn, role: "task", state: "submitted", text: task, label });
    push({ type: "run_start", runId: `${dsl.id}-${step.spawn}`, agentId: step.spawn, parentId: "main", prompt: task, provider: dsl.provider ?? "ollama" });
    push({ type: "turn_start", agentId: step.spawn, turn: 1 });
    childSteps(step.spawn, step.steps);
    push({ type: "run_end", runId: `${dsl.id}-${step.spawn}`, stopReason: "end_turn" });
    push({ type: "agent_message", from: step.spawn, to: "main", role: "result", state: "completed", text: `[${step.spawn}] done` });
    push({ type: "tool_result", agentId: "main", callId: parentCall, output: `[${step.spawn}] result`, isError: false, durationMs: SUBAGENT_RESULT_DURATION_MS });
  };

  // N children in parallel: all spawns first, all run_starts second, then the
  // steps ROUND-ROBIN (one step per child per round — the interleaving is the
  // didactic heart of fanout), finally all run_ends + the wrapper result.
  const expandFanout = (step: Extract<Step, { fanout: unknown }>) => {
    const fo = step.fanout;
    const parentCall = nextCall();
    push({ type: "tool_call", agentId: "main", callId: parentCall, name: fo.tool, input: { areas: fo.agents.map((a) => a.id) } });
    for (const a of fo.agents) {
      const task = loc(a.task, lang);
      push({ type: "agent_spawn", agentId: a.id, parentId: "main", task });
      push({ type: "agent_message", from: "main", to: a.id, role: "task", state: "submitted", text: task, label: fo.label ?? fo.tool });
    }
    for (const a of fo.agents) {
      push({ type: "run_start", runId: `${dsl.id}-${a.id}`, agentId: a.id, parentId: "main", prompt: loc(a.task, lang), provider: dsl.provider ?? "ollama" });
      push({ type: "turn_start", agentId: a.id, turn: 1 });
    }
    const maxLen = Math.max(...fo.agents.map((a) => a.steps.length));
    for (let i = 0; i < maxLen; i++) for (const a of fo.agents) if (a.steps[i]) childSteps(a.id, [a.steps[i]]);
    for (const a of fo.agents) {
      push({ type: "run_end", runId: `${dsl.id}-${a.id}`, stopReason: "end_turn" });
      push({ type: "agent_message", from: a.id, to: "main", role: "result", state: "completed", text: `[${a.id}] done` });
    }
    push({ type: "tool_result", agentId: "main", callId: parentCall, output: `${fo.agents.length} reviews back`, isError: false, durationMs: SUBAGENT_RESULT_DURATION_MS });
  };

  let lastWasSay = false;
  for (const step of dsl.steps) {
    lastWasSay = false;
    if ("think" in step) {
      const text = loc(step.think, lang); convoChars += text.length;
      push({ type: "thinking_delta", agentId: "main", text });
    } else if ("say" in step) {
      const text = loc(step.say, lang); convoChars += text.length;
      push({ type: "text_delta", agentId: "main", text });
      lastWasSay = true;
    } else if ("usage" in step) {
      push({ type: "usage", agentId: "main", inputTokens: step.usage.in, outputTokens: step.usage.out });
    } else if ("compact" in step) {
      // The harness squeezes the conversation into a summary: emit the
      // compaction, shrink the tracked conversation, and re-seed the meter.
      push({ type: "compaction", agentId: "main", removedTurns: step.compact.removedTurns, summaryChars: step.compact.summaryChars });
      convoChars = step.compact.summaryChars;
      seedContext(1);
    } else if ("context" in step) {
      push({ type: "context_info", agentId: "main", turn: 1, messages: 1,
        estimatedTokens: step.context.parts.reduce((s, p) => s + p.estTokens, 0), threshold: CONTEXT_THRESHOLD_TOKENS,
        parts: step.context.parts.map((p) => ({ label: loc(p.label, lang), chars: p.chars, estTokens: p.estTokens })) });
    }
    else if ("read" in step) diskTool("main", "read_file", step.read, step.result ? loc(step.result, lang) : undefined, "(file contents)");
    else if ("write" in step) diskTool("main", "write_file", step.write, step.result ? loc(step.result, lang) : undefined, "ok, wrote 1 file");
    else if ("list" in step) diskTool("main", "list_dir", step.list, step.result ? loc(step.result, lang) : undefined, "a.ts\nb.ts");
    else if ("run" in step) gatedTool("main", "run_command", { command: step.run }, step.gate, step.result ? loc(step.result, lang) : undefined, step.error, true);
    else if ("mcp" in step) {
      const [server, tool] = step.mcp.split("__");
      gatedTool("main", `mcp__${server}__${tool}`, step.input ?? {}, step.gate, step.result ? loc(step.result, lang) : undefined, step.error, true);
    }
    else if ("tool" in step) gatedTool("main", step.tool, step.input ?? {}, step.gate, step.result ? loc(step.result, lang) : undefined, step.error, false);
    else if ("spawn" in step) expandSpawn(step);
    else if ("fanout" in step) expandFanout(step);
  }

  if (lastWasSay) push({ type: "usage", agentId: "main", inputTokens: estTok(convoChars), outputTokens: 200 });
  push({ type: "run_end", runId, stopReason: "end_turn" });

  return out.map((e, i) => ({ ...e, ts: baseTs + i * EVENT_SPACING_MS }));
}
