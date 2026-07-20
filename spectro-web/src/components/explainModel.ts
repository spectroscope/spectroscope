// The explain panel's deterministic skeleton (spectro-explain features 1+3,
// key-free): a run summary and per-gate explanations, both folded straight
// from the recorded stream. No LLM involved — everything here is a fact the
// JSONL already carries; the honest boundary lives in the UI copy.

import type { TraceEntry } from "../state/reducer";

export interface RunSummary {
  prompt: string | null;
  durationMs: number;
  turns: number;
  toolCalls: number;
  toolErrors: number;
  /** Calls per tool name, most used first. */
  toolsByName: { name: string; n: number }[];
  gatesAsked: number;
  gatesAllowed: number;
  gatesDenied: number;
  gatesPending: number;
  errors: number;
  agents: string[];
  inTokens: number;
  outTokens: number;
  cacheTokens: number;
  stopReason: string | null;
}

export interface GateExplanation {
  callId: string;
  agentId: string;
  name: string;
  input: unknown;
  outcome: "pending" | "allowed" | "denied";
  /** The permission mode announced BEFORE the request — null when the stream
   *  never carried a mode frame (stored JSONL: the frame is socket-only). */
  modeAtAsk: string | null;
  /** seq of the permission_request frame — the jump anchor. */
  seq: number;
}

const p = (e: TraceEntry): Record<string, unknown> => (e.payload ?? {}) as Record<string, unknown>;
const num = (v: unknown): number => (typeof v === "number" ? v : 0);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/** Fold the whole stream into the deterministic run summary. */
export function buildRunSummary(entries: TraceEntry[]): RunSummary {
  let prompt: string | null = null;
  let t0: number | null = null;
  let t1: number | null = null;
  let turns = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const toolCount = new Map<string, number>();
  let gatesAsked = 0;
  let gatesAllowed = 0;
  let gatesDenied = 0;
  let errors = 0;
  const agents: string[] = [];
  let inTokens = 0;
  let outTokens = 0;
  let cacheTokens = 0;
  let stopReason: string | null = null;
  const openGates = new Set<string>();

  for (const e of entries) {
    if (e.type === "system_context" || e.type === "session_resume") continue;
    if (e.agentId !== undefined && !agents.includes(e.agentId)) agents.push(e.agentId);
    if (t0 === null && e.ts > 0) t0 = e.ts;
    if (e.ts > 0) t1 = e.ts;
    switch (e.type) {
      case "run_start":
        if (prompt === null && str(p(e)["parentId"]) === undefined) prompt = str(p(e)["prompt"]) ?? null;
        break;
      case "turn_start":
        turns++;
        break;
      case "tool_call": {
        toolCalls++;
        const name = str(p(e)["name"]) ?? "?";
        toolCount.set(name, (toolCount.get(name) ?? 0) + 1);
        break;
      }
      case "tool_result":
        if (p(e)["isError"] === true) toolErrors++;
        break;
      case "permission_request": {
        gatesAsked++;
        const id = str(p(e)["callId"]);
        if (id !== undefined) openGates.add(id);
        break;
      }
      case "permission_decision": {
        const id = str(p(e)["callId"]);
        if (id !== undefined) openGates.delete(id);
        if (p(e)["allowed"] === true) gatesAllowed++;
        else gatesDenied++;
        break;
      }
      case "usage":
        inTokens += num(p(e)["inputTokens"]);
        outTokens += num(p(e)["outputTokens"]);
        cacheTokens += num(p(e)["cacheReadTokens"]) + num(p(e)["cacheCreationTokens"]);
        break;
      case "run_end":
        stopReason = str(p(e)["stopReason"]) ?? stopReason;
        break;
      case "error":
        errors++;
        break;
      default:
        break;
    }
  }

  return {
    prompt,
    durationMs: t0 !== null && t1 !== null ? Math.max(0, t1 - t0) : 0,
    turns,
    toolCalls,
    toolErrors,
    toolsByName: [...toolCount.entries()]
      .map(([name, n]) => ({ name, n }))
      .sort((a, b) => b.n - a.n),
    gatesAsked,
    gatesAllowed,
    gatesDenied,
    gatesPending: openGates.size,
    errors,
    agents,
    inTokens,
    outTokens,
    cacheTokens,
    stopReason,
  };
}

/** One explanation per permission_request, in stream order. The mode at ask
 *  time comes from the latest permission_mode_info frame BEFORE the request;
 *  stored sessions never carry that frame (socket-only), so it stays null
 *  and the UI says so instead of guessing. */
export function gateExplanations(entries: TraceEntry[]): GateExplanation[] {
  const out: GateExplanation[] = [];
  const outcome = new Map<string, "allowed" | "denied">();
  for (const e of entries) {
    if (e.type !== "permission_decision") continue;
    const id = str(p(e)["callId"]);
    if (id !== undefined) outcome.set(id, p(e)["allowed"] === true ? "allowed" : "denied");
  }

  let mode: string | null = null;
  for (const e of entries) {
    if (e.type === "permission_mode_info") {
      mode = str(p(e)["mode"]) ?? mode;
      continue;
    }
    if (e.type !== "permission_request") continue;
    const callId = str(p(e)["callId"]) ?? "";
    out.push({
      callId,
      agentId: e.agentId ?? str(p(e)["agentId"]) ?? "?",
      name: str(p(e)["name"]) ?? "?",
      input: p(e)["input"],
      outcome: outcome.get(callId) ?? "pending",
      modeAtAsk: mode,
      seq: e.seq,
    });
  }
  return out;
}
