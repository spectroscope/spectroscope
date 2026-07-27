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
  message?: {
    role?: string;
    content?: unknown;
    /** Assistant records name the model that produced them; it can change
     *  mid-file (a /model switch, or a subagent on another model). */
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      /** Anthropic prompt caching. Additive on our wire too: absent means the
       *  provider reported none, which is not the same as zero. */
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
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

/** Records without a timestamp get synthetic ones this far apart. */
const SYNTHETIC_TS_STEP_MS = 1000;

/**
 * One stamp per record, in file order and never decreasing.
 *
 * Timestamps are per record, not per file: a transcript can date some records
 * and leave others bare. Every date the file DOES carry is the truth about
 * when the session ran — the synthetic ladder is a relative filler that hangs
 * off the nearest one, so the stream keeps the file's own span instead of a
 * calendar of its own. A file with no date at all rides the ladder from `base`.
 */
function stampRecords(recs: CCRecord[], base: number): number[] {
  const dated = recs.map((r) => {
    const t = r.timestamp !== undefined ? Date.parse(r.timestamp) : Number.NaN;
    return Number.isFinite(t) ? t : null;
  });
  const first = dated.findIndex((t) => t !== null);
  if (first < 0) return recs.map((_, i) => base + i * SYNTHETIC_TS_STEP_MS);

  const stamps: number[] = [];
  // Records ahead of the first dated one have nothing to continue from: hang
  // them one rung apart IN FRONT of it, which keeps their order without
  // claiming a wall-clock time the file never recorded.
  const origin = dated[first] as number;
  for (let i = 0; i < first; i++) stamps.push(origin - (first - i) * SYNTHETIC_TS_STEP_MS);
  let latest = origin;
  for (let i = first; i < recs.length; i++) {
    const t = dated[i];
    if (t !== null) {
      stamps.push(t);
      latest = Math.max(latest, t); // a stray early date must not pull the ladder back
    } else {
      latest += SYNTHETIC_TS_STEP_MS;
      stamps.push(latest);
    }
  }
  return stamps;
}

// "Task" is the classic subagent tool; newer Claude Code versions call it "Agent".
const isSpawnTool = (name: unknown): boolean => name === "Task" || name === "Agent";

const asText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((b: CCBlock | string) => (typeof b === "string" ? b : (b.text ?? ""))).join("");
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
      for (const b of content as CCBlock[])
        if (b?.type === "tool_use" && isSpawnTool(b.name) && typeof b.id === "string") taskIds.add(b.id);
    }
  }
  const byUuid = new Map(
    recs.filter((r) => typeof r.uuid === "string").map((r) => [r.uuid as string, r] as const),
  );
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
  // Who spawned a Task, and what for — a Task nested inside a sidechain belongs
  // under its spawner, not under main.
  const spawnedBy = new Map<string, string>();
  const taskOf = new Map<string, string>();

  // Turns are per agent: the main run and every subagent count their own.
  const turns = new Map<string, number>();
  const nextTurn = (agentId: string): number => {
    const n = (turns.get(agentId) ?? 0) + 1;
    turns.set(agentId, n);
    return n;
  };

  const stamps = stampRecords(recs, base);
  const modelOf = (r: CCRecord): string | undefined =>
    typeof r.message?.model === "string" && r.message.model !== "" ? r.message.model : undefined;
  const firstModel = recs.map(modelOf).find((m) => m !== undefined);

  // provider_info is the socket-only announcement of the active backend, and
  // the reducer takes the latest one. A transcript names its model per message,
  // so the file itself says when it changed: announce it once up front and
  // again at each switch. Two fields stay OUT: the API host, which a transcript
  // never records, and the provider — a Claude model id says which model spoke,
  // not whether it came from the Anthropic API, Bedrock or Vertex, and the
  // trace turns a claimed "anthropic" into a claimed endpoint. Absent reads as
  // unknown; a guess would read as fact.
  let announced: string | undefined;
  const announce = (model: string | undefined, ts: number): void => {
    if (model === undefined || model === announced) return;
    announced = model;
    out.push({ type: "provider_info", model, ts } as unknown as RunEvent);
  };

  /** One content block under `agentId`, whoever owns it. */
  const emitBlock = (agentId: string, b: CCBlock, ts: number): void => {
    // Signature-only thinking / empty text blocks would render as empty
    // activities and empty stream slices — skip them.
    if (b?.type === "thinking" && (b.thinking ?? "") !== "") {
      out.push({ type: "thinking_delta", agentId, text: b.thinking ?? "", ts });
    } else if (b?.type === "text" && (b.text ?? "") !== "") {
      out.push({ type: "text_delta", agentId, text: b.text ?? "", ts });
    } else if (b?.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
      if (isSpawnTool(b.name)) {
        const task = typeof b.input?.description === "string" ? b.input.description : "subtask";
        // The agent type ("Explore", "code-reviewer") is the only readable name
        // a subagent has — its id is the raw tool-use id. It travels on the task
        // message, which is what the roster and the spectrum lane read.
        const label = typeof b.input?.subagent_type === "string" ? b.input.subagent_type : "task";
        spawnedBy.set(b.id, agentId);
        taskOf.set(b.id, task);
        out.push({ type: "agent_spawn", agentId: b.id, parentId: agentId, task, ts });
        out.push({
          type: "agent_message",
          from: agentId,
          to: b.id,
          role: "task",
          state: "submitted",
          text: task,
          label,
          ts,
        });
      } else {
        out.push({ type: "tool_call", agentId, callId: b.id, name: b.name, input: b.input, ts });
      }
    } else if (b?.type === "tool_result" && typeof b.tool_use_id === "string") {
      if (taskIds.has(b.tool_use_id)) {
        // A Task's result: close the child before the parent resumes.
        if (childStarted.has(b.tool_use_id)) {
          out.push({ type: "run_end", runId: `cc-${b.tool_use_id}`, stopReason: "end_turn", ts });
        }
        out.push({
          type: "agent_message",
          from: b.tool_use_id,
          to: agentId,
          role: "result",
          state: b.is_error ? "failed" : "completed",
          text: asText(b.content),
          ts,
        });
      }
      out.push({
        type: "tool_result",
        agentId,
        callId: b.tool_use_id,
        output: asText(b.content),
        isError: !!b.is_error,
        durationMs: 0,
        ts,
      });
    }
  };

  announce(firstModel, stamps[0] ?? base);

  recs.forEach((r, i) => {
    const ts = stamps[i];
    const content = r.message?.content;
    const blocks = Array.isArray(content) ? (content as CCBlock[]) : [];
    if (r.isSidechain) {
      const owner = ownerOf(r);
      if (!owner) return; // orphaned sidechain: skip, never crash
      if (!childStarted.has(owner)) {
        out.push({
          type: "run_start",
          runId: `cc-${owner}`,
          agentId: owner,
          parentId: spawnedBy.get(owner) ?? "main",
          prompt: taskOf.get(owner) ?? "subtask",
          ts,
        });
        childStarted.add(owner);
      }
      if (r.type === "assistant") {
        announce(modelOf(r), ts);
        out.push({ type: "turn_start", agentId: owner, turn: nextTurn(owner), ts });
      }
      for (const b of blocks) emitBlock(owner, b, ts);
      return;
    }
    if (r.type === "user") {
      if (!started) {
        out.push({
          type: "run_start",
          runId,
          agentId: "main",
          prompt: asText(content),
          ...(firstModel !== undefined ? { model: firstModel } : {}),
          ts,
        });
        started = true;
      } else {
        for (const b of blocks) emitBlock("main", b, ts);
      }
    } else if (r.type === "assistant") {
      // One assistant message is one turn. A long session is hundreds of them,
      // and the graph draws a node per turn_start.
      announce(modelOf(r), ts);
      out.push({ type: "turn_start", agentId: "main", turn: nextTurn("main"), ts });
      for (const b of blocks) emitBlock("main", b, ts);
      const u = r.message?.usage;
      if (u)
        out.push({
          type: "usage",
          agentId: "main",
          inputTokens: u.input_tokens ?? 0,
          outputTokens: u.output_tokens ?? 0,
          ...(u.cache_read_input_tokens !== undefined ? { cacheReadTokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens !== undefined
            ? { cacheCreationTokens: u.cache_creation_input_tokens }
            : {}),
          ts,
        });
    }
  });

  if (started) {
    // The closing stamp is the last moment the file recorded, so the run_end
    // can never predate the events it closes and the session's span stays the
    // session's own.
    const last = stamps.reduce((m, t) => (t > m ? t : m), stamps[0] ?? base);
    out.push({ type: "run_end", runId, stopReason: "end_turn", ts: last });
  }
  return out;
}

export function parseTranscript(text: string): RunEvent[] {
  const records = text
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
  return claudeCodeToRunEvents(records);
}
