// Format auto-detection for the session importer. Raw spectroscope JSONL (one RunEvent
// per line — the canonical wire format) replays verbatim; a Claude Code
// transcript (message records with content blocks) and a VS Code agent-mode
// export (dotted types, payload under `data`) run through their adapters.
// Ported from the LLM_Simulator; keep the two in sync.

import type { RunEvent } from "../events";
import { claudeCodeWithOrigin } from "./claudeCode";
import { vscodeAgentWithOrigin } from "./vscodeAgent";

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

/** The complete type vocabulary of a VS Code / GitHub Copilot agent-mode
 *  export. Matching a name from this list AND a `data` object keeps the
 *  recognizer off the other two formats and off any tool that merely happens to
 *  log dotted type names: spectroscope types are never dotted, and a Claude Code
 *  record carries `message`, not `data`. */
const VSCODE_AGENT_TYPES = new Set([
  "assistant.turn_start",
  "assistant.turn_end",
  "assistant.message",
  "tool.execution_start",
  "tool.execution_complete",
  "user.message",
]);

const hasDataObject = (r: { data?: unknown }): boolean =>
  !!r.data && typeof r.data === "object" && !Array.isArray(r.data);

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

/**
 * The file's own lines, and which of them produced each frame.
 *
 * Carried whole and verbatim, every format, every field: a pane that shows a
 * FILTERED line and calls it the source is the defect this exists to remove.
 * The lines are one shared array per import, so the file is held once however
 * many frames point into it.
 */
export interface ImportSource {
  /** The file's non-blank lines, byte for byte as they arrived. */
  lines: string[];
  /** Parallel to the events: an index into `lines`, or -1 for a frame the
   *  importer built rather than read. */
  origin: Int32Array;
}

export function detectAndLoad(text: string): {
  events: RunEvent[];
  kind: "spectroscope" | "claude-code" | "vscode-agent";
  source: ImportSource;
} {
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
    const r = rec as { type?: unknown; message?: unknown; data?: unknown } | null;
    if (!r || typeof r.type !== "string") continue;
    if (SPECTRO_TYPES.has(r.type)) {
      // Replayed verbatim, so line and frame are the same thing. Carrying it
      // anyway is what makes the byte identity checkable rather than asserted:
      // a hand-edited or foreign-written file is not what our writer produced.
      const identity = new Int32Array(records.length);
      for (let i = 0; i < records.length; i++) identity[i] = i;
      return { events: records as RunEvent[], kind: "spectroscope", source: { lines, origin: identity } };
    }
    if (VSCODE_AGENT_TYPES.has(r.type) && hasDataObject(r)) {
      const { events, origin } = vscodeAgentWithOrigin(records);
      return { events, kind: "vscode-agent", source: { lines, origin } };
    }
    if (r.message !== undefined) {
      const { events, origin } = claudeCodeWithOrigin(records);
      return { events, kind: "claude-code", source: { lines, origin } };
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
    `This is not a spectroscope session, a Claude Code transcript or a VS Code agent export. ${found} ` +
      `spectroscope sessions live in ~/.spectro/sessions; Claude Code transcripts in ~/.claude/projects.`,
  );
}
