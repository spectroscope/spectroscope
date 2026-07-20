// Format auto-detection for the session importer. Raw spectroscope JSONL (one RunEvent
// per line — the canonical wire format) replays verbatim; a Claude Code
// transcript (message records with content blocks) runs through the adapter.
// Ported from the LLM_Simulator; keep the two in sync.

import type { RunEvent } from "../events";
import { claudeCodeToRunEvents } from "./claudeCode";

const SPECTRO_TYPES = new Set([
  "run_start", "turn_start", "text_delta", "thinking_delta", "tool_call",
  "permission_request", "permission_decision", "tool_result", "agent_spawn",
  "compaction", "usage", "run_end", "error", "image_generated", "context_info",
  "agent_message", "voice_input", "plan",
]);

export function detectAndLoad(text: string): { events: RunEvent[]; kind: "spectroscope" | "claude-code" } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length === 0) throw new Error("empty file");

  let records: unknown[];
  try {
    records = lines.map((l) => JSON.parse(l));
  } catch {
    throw new Error("invalid JSONL");
  }

  // Real Claude Code transcripts open with metadata records (queue-operation,
  // attachment, ai-title, …) before the first message — scan for the first
  // line that identifies a format instead of trusting line one.
  for (const rec of records) {
    const r = rec as { type?: unknown; message?: unknown } | null;
    if (!r || typeof r.type !== "string") continue;
    if (SPECTRO_TYPES.has(r.type)) {
      return { events: records as RunEvent[], kind: "spectroscope" };
    }
    if (r.message !== undefined) {
      return { events: claudeCodeToRunEvents(records), kind: "claude-code" };
    }
  }
  throw new Error("unrecognized format");
}
