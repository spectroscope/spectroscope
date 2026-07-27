// Format auto-detection for the session importer. Raw spectroscope JSONL (one RunEvent
// per line — the canonical wire format) replays verbatim; a Claude Code
// transcript (message records with content blocks) runs through the adapter.
// Ported from the LLM_Simulator; keep the two in sync.

import type { RunEvent } from "../events";
import { claudeCodeToRunEvents } from "./claudeCode";

const SPECTRO_TYPES = new Set([
  "run_start",
  "turn_start",
  "text_delta",
  "thinking_delta",
  "tool_call",
  "permission_request",
  "permission_decision",
  "tool_result",
  "agent_spawn",
  "compaction",
  "usage",
  "run_end",
  "error",
  "image_generated",
  "context_info",
  "agent_message",
  "voice_input",
  "plan",
]);

/** How many distinct type names the failure message may name, and how long each
 *  may be. A file we do not understand is a file we do not trust: without these
 *  caps a hostile or merely enormous export could flood the dialog. */
const MAX_REPORTED_TYPES = 5;
const MAX_TYPE_CHARS = 32;

/** The type names come from an unrecognised file and are rendered into the
 *  dialog, so they are data, not markup: collapse every control character
 *  (newlines above all — they would forge extra lines of interface text) and
 *  cap the length. */
function safeTypeName(raw: string): string {
  // C0, DEL, C1 and the two Unicode line separators — everything a renderer
  // could read as "start a new line".
  // eslint-disable-next-line no-control-regex
  const flat = raw.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ").trim();
  return flat.length > MAX_TYPE_CHARS ? `${flat.slice(0, MAX_TYPE_CHARS)}…` : flat;
}

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
  // Nothing matched. Say what arrived and what is accepted — "unrecognized
  // format" sends the reader back to the file with no idea what to look at.
  const seen: string[] = [];
  for (const rec of records) {
    const t = (rec as { type?: unknown } | null)?.type;
    if (typeof t !== "string" || !t.trim()) continue;
    const name = safeTypeName(t);
    if (name && !seen.includes(name)) seen.push(name);
    if (seen.length >= MAX_REPORTED_TYPES) break;
  }
  const found = seen.length > 0 ? `Found ${seen.join(", ")}.` : "No record carried a type field.";
  throw new Error(
    `This is neither a spectroscope session nor a Claude Code transcript. ${found} ` +
      `spectroscope sessions live in ~/.spectro/sessions; Claude Code transcripts in ~/.claude/projects.`,
  );
}
