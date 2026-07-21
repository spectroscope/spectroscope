// A hovered spectrum event -> its exact wire type + a short payload preview.
// Pure: the Spectrum popup renders this; the tick already carries `seq`, so the
// caller hands us events[seq]. Wire types stay untranslated (protocol terms,
// like the legend), the detail is a whitespace-collapsed, bounded snippet.

import type { RunEvent } from "../events";

/** Longest preview the popup shows before an ellipsis. */
const MAX = 200;

export interface EventPreview {
  /** The exact wire type — a protocol term, not translated. */
  type: string;
  /** A short, whitespace-collapsed preview of the payload (may be ""). */
  detail: string;
}

/** Collapse whitespace, trim, and cap at {@link MAX} with an ellipsis. */
function clip(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX ? collapsed.slice(0, MAX - 1) + "…" : collapsed;
}

/** A compact one-line form of an arbitrary tool input. */
function compact(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function eventPreview(event: RunEvent): EventPreview {
  const type = event.type;
  let detail: string;
  switch (event.type) {
    case "run_start": detail = event.prompt; break;
    case "turn_start": detail = `turn ${event.turn}`; break;
    case "text_delta":
    case "thinking_delta": detail = event.text; break;
    case "tool_call": detail = `${event.name} ${compact(event.input)}`; break;
    case "permission_request": detail = event.name; break;
    case "permission_decision": detail = event.allowed ? "allowed" : "denied"; break;
    case "tool_result": detail = `${event.isError ? "error · " : ""}${event.output}`; break;
    case "agent_spawn": detail = event.task; break;
    case "agent_message": detail = `${event.from} → ${event.to} · ${event.role}: ${event.text}`; break;
    case "usage": detail = `${event.inputTokens} in · ${event.outputTokens} out`; break;
    case "run_end": detail = event.stopReason; break;
    case "error": detail = event.message; break;
    case "image_generated": detail = event.prompt; break;
    case "compaction": detail = `removed ${event.removedTurns} turn(s)`; break;
    case "context_info": detail = `~${event.estimatedTokens} tokens · ${event.messages} msgs`; break;
    case "plan": detail = `${event.steps.length} step(s)`; break;
    default: detail = ""; // an unknown/future wire type: the bare type, no preview
  }
  return { type, detail: clip(detail) };
}
