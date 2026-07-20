// The text-only feed (the "Text" tab): the whole session as ONE readable
// stream — every piece of text the protocol carries, in wire order, with the
// protocol made visible as literal markers: <think> / </think> around each
// reasoning run (the tags Ollama really streams inline; Anthropic's thinking
// blocks render to the same markers), [tool_call …] / [tool_result …]
// indicators with the full input and output, run boundaries, the permission
// gate, errors. A pure fold over RunEvent[] — no React, fully unit-tested.

import type { RunEvent } from "../events";

/** One block of the feed. `kind` drives the styling only — `text` is complete. */
export interface FeedSegment {
  kind: "prompt" | "marker" | "thinking" | "answer" | "output" | "error";
  /** The emitting agent — the view prefixes non-main blocks with it. */
  agentId: string;
  text: string;
}

/** What a delta stream is currently writing, per agent. */
type Mode = "thinking" | "answer" | null;

/** Compact one-line JSON for tool inputs — never string-matched, only shown. */
function compact(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/**
 * Folds the event stream into the feed. Contiguous deltas of the same agent
 * and kind accumulate into one segment; a mode CHANGE closes the reasoning
 * run with its `</think>` marker — exactly the boundary the wire has.
 */
export function buildTextFeed(events: readonly RunEvent[]): FeedSegment[] {
  const segments: FeedSegment[] = [];
  const mode = new Map<string, Mode>();
  const toolNames = new Map<string, string>();

  const push = (kind: FeedSegment["kind"], agentId: string, text: string): void => {
    segments.push({ kind, agentId, text });
  };
  const append = (kind: "thinking" | "answer", agentId: string, text: string): void => {
    const last = segments[segments.length - 1];
    if (last !== undefined && last.kind === kind && last.agentId === agentId) {
      last.text += text;
      return;
    }
    push(kind, agentId, text);
  };
  /** Closes an open reasoning run of this agent (the </think> boundary). */
  const closeThinking = (agentId: string): void => {
    if (mode.get(agentId) === "thinking") {
      push("marker", agentId, "</think>");
    }
  };

  for (const e of events) {
    switch (e.type) {
      case "run_start":
        // Only the root prompt is user text; a child's run_start repeats the
        // task the agent_spawn marker already carries.
        if (e.parentId === undefined) {
          push("marker", e.agentId, `[run_start${e.provider !== undefined ? " " + e.provider : ""}]`);
          push("prompt", e.agentId, e.prompt);
        }
        mode.set(e.agentId, null);
        break;
      case "thinking_delta":
        if (mode.get(e.agentId) !== "thinking") {
          push("marker", e.agentId, "<think>");
          mode.set(e.agentId, "thinking");
        }
        append("thinking", e.agentId, e.text);
        break;
      case "text_delta":
        closeThinking(e.agentId);
        if (mode.get(e.agentId) !== "answer") {
          mode.set(e.agentId, "answer");
        }
        append("answer", e.agentId, e.text);
        break;
      case "tool_call":
        closeThinking(e.agentId);
        mode.set(e.agentId, null);
        toolNames.set(e.callId, e.name);
        push("marker", e.agentId, `[tool_call ${e.name} ${compact(e.input)}]`);
        break;
      case "tool_result": {
        const name = toolNames.get(e.callId) ?? e.callId;
        push("marker", e.agentId,
            `[tool_result ${name}${e.isError ? " ERROR" : ""} · ${e.durationMs}ms]`);
        if (e.output !== "") {
          push("output", e.agentId, e.output);
        }
        break;
      }
      case "permission_request":
        push("marker", e.agentId, `[permission_request ${e.name} ${compact(e.input)}]`);
        break;
      case "permission_decision":
        push("marker", "main", `[permission ${e.allowed ? "granted" : "denied"}]`);
        break;
      case "agent_spawn":
        push("marker", e.agentId, `[agent_spawn ${e.agentId} ← ${e.task}]`);
        break;
      case "agent_message":
        push("marker", e.from, `[agent_message ${e.from}→${e.to} ${e.role}/${e.state}] ${e.text}`);
        break;
      case "compaction":
        push("marker", e.agentId, `[compaction −${e.removedTurns} turns]`);
        break;
      case "image_generated":
        push("marker", e.agentId, `[image_generated ${e.provider} ${e.model}] ${e.prompt}`);
        break;
      case "error":
        closeThinking(e.agentId ?? "main");
        mode.set(e.agentId ?? "main", null);
        push("error", e.agentId ?? "main", `[error] ${e.message}`);
        break;
      case "run_end":
        // Close every open reasoning run — a child may still be mid-thought
        // only in theory; the merged stream ends them before run_end.
        for (const [agentId] of mode) {
          closeThinking(agentId);
          mode.set(agentId, null);
        }
        push("marker", "main", `[run_end ${e.stopReason}]`);
        break;
      default:
        // turn_start, usage, context_info, socket-only frames: no text.
        break;
    }
  }
  return segments;
}

/** The feed as ONE plain-text string — what the copy button hands out. */
export function feedToPlainText(segments: readonly FeedSegment[]): string {
  return segments
      .map((s) => (s.agentId !== "main" && s.agentId !== "" ? `[${s.agentId}] ` : "") + s.text)
      .join("\n");
}

/** The wire types that are SOCKET-ONLY UI frames — never in the JSONL file. */
const SOCKET_ONLY_TYPES = new Set(["workspace_info", "provider_info", "permission_mode_info"]);

/**
 * The session as JSONL lines — one compact JSON object per wire event,
 * exactly the shape the session file stores. Socket-only UI frames are
 * filtered out: they never enter the file, and this view IS the file.
 */
export function eventsToJsonl(events: readonly RunEvent[]): string[] {
  return events
      .filter((e) => !SOCKET_ONLY_TYPES.has((e as { type: string }).type))
      .map((e) => JSON.stringify(e));
}
