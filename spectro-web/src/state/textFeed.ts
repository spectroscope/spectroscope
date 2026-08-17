// The text-only feed (the "Text" tab): the whole session as ONE readable
// stream — every piece of text the protocol carries, in wire order, with the
// protocol made visible as literal markers: <think> / </think> around each
// reasoning run (the tags Ollama really streams inline; Anthropic's thinking
// blocks render to the same markers), [tool_call …] / [tool_result …]
// indicators with the full input and output, run boundaries, the permission
// gate, errors. A pure fold over RunEvent[] — no React, fully unit-tested.

import type { RunEvent } from "../events";
import { isWireEvent } from "../wire/nonWire";

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
 *
 * @param events   the stream to fold
 * @param extended when true, EVERY frame shows — including the ones the
 *   reading feed leaves out: the assembled request (`context_info`, with the
 *   system prompt and tool schemas the model actually received), the token
 *   truth (`usage`), turn boundaries, the plan, and the client frames the UI
 *   itself sent. The reading feed stays exactly as it was; extended only adds
 *   (owner 2026-07-26: "wollen wir nicht auch ehrlich sein").
 */
export function buildTextFeed(events: readonly RunEvent[], extended = false): FeedSegment[] {
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
    // Read before the switch, which is sealed to the RunEvent union: an
    // imported transcript's later prompts arrive as user_message, because
    // run_start carries exactly one prompt and a session has many. It is a
    // prompt in the reading feed, not behind `extended` — the feed's job is
    // every piece of text the protocol carried, and this is the text that
    // explains why the next answer changes subject. Every open reasoning run
    // closes first, exactly as run_end does it: the frame names no agent, and
    // a prompt landing inside a <think> block would leave the tags unbalanced
    // and turn the whole rest of the feed into reasoning.
    if ((e as { type: string }).type === "user_message") {
      const text = (e as unknown as { text?: unknown }).text;
      if (typeof text === "string" && text !== "") {
        for (const [agentId] of mode) {
          closeThinking(agentId);
          mode.set(agentId, null);
        }
        push("prompt", "main", text);
      }
      continue;
    }
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
        push("marker", e.agentId, `[tool_result ${name}${e.isError ? " ERROR" : ""} · ${e.durationMs}ms]`);
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
      // Card 252. This feed is what people COPY out of a session, and a reader
      // who pastes a transcript where a model shrugged at a screenshot has to be
      // able to see that the screenshot never left the machine.
      case "images_withheld":
        push("marker", e.agentId, `[images_withheld ${e.images} · ${e.reason}]`);
        break;
      // Card 265. A pasted transcript where the agent changed course has to say
      // that a person told it to — and, when nobody did, that it decided alone.
      case "question_asked":
        push("marker", e.agentId, `[question] ${e.questions.map((q) => q.question).join(" · ")}`);
        break;
      case "question_answered":
        push("marker", "main", e.cancelled ? "[question unanswered]" : `[answer] ${e.answers.join(", ")}`);
        break;
      case "error":
        closeThinking(e.agentId ?? "main");
        mode.set(e.agentId ?? "main", null);
        push("error", e.agentId ?? "main", `[error] ${e.message}`);
        break;
      case "turn_start":
        if (extended) push("marker", e.agentId, `[turn_start ${e.turn}]`);
        break;
      case "usage":
        if (extended) {
          const cache = (e.cacheReadTokens ?? 0) + (e.cacheCreationTokens ?? 0);
          push(
            "marker",
            e.agentId,
            `[usage ${e.inputTokens} in · ${e.outputTokens} out` +
              (cache > 0 ? ` · cache ${cache}` : "") +
              "]",
          );
        }
        break;
      case "context_info":
        // The whole assembled request — what the model was actually handed.
        if (extended) {
          push(
            "marker",
            e.agentId,
            `[context_info turn ${e.turn} · ${e.messages} messages · est ${e.estimatedTokens} of ${e.threshold} tokens]`,
          );
          for (const part of e.parts) {
            push(
              "marker",
              e.agentId,
              `--- ${part.label} (${part.chars} chars, ~${part.estTokens} tokens) ---`,
            );
            if (part.text !== undefined && part.text !== "") {
              push("output", e.agentId, part.text);
            }
          }
        }
        break;
      case "plan":
        if (extended) {
          push("marker", e.agentId, "[plan]");
          push("output", e.agentId, e.steps.map((s) => `${s.status.padEnd(12)} ${s.text}`).join("\n"));
        }
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

/**
 * The session as JSONL lines — one compact JSON object per wire event,
 * exactly the shape the session file stores. Frames that are not wire events
 * are filtered out: they never enter the file, and this view IS the file.
 *
 * The list used to live here, and only here, which is how the download came to
 * write lines this view did not show. It lives in wire/nonWire.ts now so the
 * view and every writer read the same one.
 */
export function eventsToJsonl(events: readonly RunEvent[]): string[] {
  return events.filter(isWireEvent).map((e) => JSON.stringify(e));
}
