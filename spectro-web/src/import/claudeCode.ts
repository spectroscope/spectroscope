// The Claude Code transcript adapter. A Claude Code session file is JSONL of
// user/assistant records whose `message.content` holds blocks (text, thinking,
// tool_use, tool_result). This maps them onto spectroscope's RunEvent stream:
//   tool_use            -> tool_call        (name = Task/Agent -> agent_spawn)
//   tool_result block   -> tool_result
//   text / thinking     -> text_delta / thinking_delta
//   message.usage       -> usage
// so a real recorded session replays through the same reducers as a spectroscope run.
// Unrecognized records are skipped, never fatal — real transcripts vary.
// Ported from the LLM_Simulator; keep the two in sync.

import type { RunEvent } from "../events";

interface CCRecord {
  type?: string;
  message?: { role?: string; content?: unknown; usage?: { input_tokens?: number; output_tokens?: number } };
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  timestamp?: string;
}

interface CCBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

/** Records without timestamps get synthetic ones this far apart — the
 *  closing run_end derives from the same step, keeping ts monotonic. */
const SYNTHETIC_TS_STEP_MS = 1000;
const tsOf = (r: CCRecord, i: number, base: number) => (r.timestamp ? Date.parse(r.timestamp) : base + i * SYNTHETIC_TS_STEP_MS);

// "Task" is the classic subagent tool; newer Claude Code versions call it "Agent".
const isSpawnTool = (name: unknown): boolean => name === "Task" || name === "Agent";

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b: CCBlock | string) => (typeof b === "string" ? b : b.text ?? "")).join("");
  return "";
};

export function claudeCodeToRunEvents(records: unknown[], base = 1_783_500_000_000): RunEvent[] {
  const recs = records.filter((r): r is CCRecord => !!r && typeof r === "object");
  const out: RunEvent[] = [];
  const runId = "cc-import";
  let started = false;

  // Task tool_use ids double as the child agentIds. A sidechain record finds
  // its owning Task by walking parentUuid up: the chain roots either directly
  // at the Task id or at another sidechain record whose chain does.
  const taskIds = new Set<string>();
  for (const r of recs) {
    const content = r.type === "assistant" ? r.message?.content : null;
    if (Array.isArray(content)) {
      for (const b of content as CCBlock[]) if (b?.type === "tool_use" && isSpawnTool(b.name) && typeof b.id === "string") taskIds.add(b.id);
    }
  }
  const byUuid = new Map(recs.filter((r) => typeof r.uuid === "string").map((r) => [r.uuid as string, r] as const));
  const ownerOf = (r: CCRecord): string | null => {
    let cur: CCRecord | undefined = r;
    const seen = new Set<string>();
    while (cur?.parentUuid && !seen.has(cur.parentUuid)) {
      if (taskIds.has(cur.parentUuid)) return cur.parentUuid;
      seen.add(cur.parentUuid);
      cur = byUuid.get(cur.parentUuid);
    }
    return null;
  };
  const childStarted = new Set<string>();

  recs.forEach((r, i) => {
    const ts = tsOf(r, i, base);
    if (r.isSidechain) {
      const owner = ownerOf(r);
      if (!owner) return; // orphaned sidechain: skip, never crash
      if (!childStarted.has(owner)) {
        out.push({ type: "run_start", runId: `cc-${owner}`, agentId: owner, parentId: "main", prompt: "subtask", ts });
        out.push({ type: "turn_start", agentId: owner, turn: 1, ts });
        childStarted.add(owner);
      }
      const content = r.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as CCBlock[]) {
          // Signature-only thinking / empty text blocks would render as empty
          // activities and empty stream slices — skip them.
          if (b?.type === "thinking" && (b.thinking ?? "") !== "") out.push({ type: "thinking_delta", agentId: owner, text: b.thinking ?? "", ts });
          else if (b?.type === "text" && (b.text ?? "") !== "") out.push({ type: "text_delta", agentId: owner, text: b.text ?? "", ts });
          else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            out.push({ type: "tool_call", agentId: owner, callId: b.id, name: b.name, input: b.input, ts });
          } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            out.push({ type: "tool_result", agentId: owner, callId: b.tool_use_id, output: asText(b.content), isError: !!b.is_error, durationMs: 0, ts });
          }
        }
      }
      return;
    }
    if (r.type === "user") {
      const content = r.message?.content;
      if (!started) {
        out.push({ type: "run_start", runId, agentId: "main", prompt: asText(content), ts });
        out.push({ type: "turn_start", agentId: "main", turn: 1, ts });
        started = true;
      } else if (Array.isArray(content)) {
        for (const b of content as CCBlock[]) {
          if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
            if (taskIds.has(b.tool_use_id)) {
              // A Task's result: close the child before the parent resumes.
              if (childStarted.has(b.tool_use_id)) {
                out.push({ type: "run_end", runId: `cc-${b.tool_use_id}`, stopReason: "end_turn", ts });
              }
              out.push({ type: "agent_message", from: b.tool_use_id, to: "main", role: "result", state: b.is_error ? "failed" : "completed", text: asText(b.content), ts });
            }
            out.push({ type: "tool_result", agentId: "main", callId: b.tool_use_id, output: asText(b.content), isError: !!b.is_error, durationMs: 0, ts });
          }
        }
      }
    } else if (r.type === "assistant") {
      const content = r.message?.content;
      if (Array.isArray(content)) {
        for (const b of content as CCBlock[]) {
          if (b?.type === "thinking" && (b.thinking ?? "") !== "") out.push({ type: "thinking_delta", agentId: "main", text: b.thinking ?? "", ts });
          else if (b?.type === "text" && (b.text ?? "") !== "") out.push({ type: "text_delta", agentId: "main", text: b.text ?? "", ts });
          else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
            if (isSpawnTool(b.name)) {
              const task = typeof b.input?.description === "string" ? b.input.description : "subtask";
              const label = typeof b.input?.subagent_type === "string" ? b.input.subagent_type : "task";
              out.push({ type: "agent_spawn", agentId: b.id, parentId: "main", task, ts });
              out.push({ type: "agent_message", from: "main", to: b.id, role: "task", state: "submitted", text: task, label, ts });
            } else {
              out.push({ type: "tool_call", agentId: "main", callId: b.id, name: b.name, input: b.input, ts });
            }
          }
        }
      }
      const u = r.message?.usage;
      if (u) out.push({ type: "usage", agentId: "main", inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, ts });
    }
  });

  if (started) out.push({ type: "run_end", runId, stopReason: "end_turn", ts: base + recs.length * SYNTHETIC_TS_STEP_MS });
  return out;
}

export function parseTranscript(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return claudeCodeToRunEvents(records);
}
