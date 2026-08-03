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
  /** The file's lines, byte for byte as they arrived, blank ones INCLUDED and
   *  in place. A blank line produces no frame, but dropping it would shift
   *  every line after it: the pane reports `origin + 1` as "the number a
   *  reader counts to when opening the file", and there is only one such
   *  number. Holding one array in one numbering is what keeps it true. */
  lines: string[];
  /** Parallel to the events: an index into `lines` (which is the file's own
   *  line, counted from zero), or -1 for a frame the importer built rather
   *  than read. */
  origin: Int32Array;
}

/** The file, cut into lines, and which of them carry a record.
 *
 *  A file that ends with a newline has one empty piece after its last record.
 *  An editor does not count that piece as a line and neither does this, so a
 *  file with no blank lines in it reports exactly the line count its writer
 *  wrote. */
function cut(text: string): { lines: string[]; at: number[] } {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const at: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].trim()) at.push(i);
  return { lines, at };
}

export function detectAndLoad(text: string): {
  events: RunEvent[];
  kind: "spectroscope" | "claude-code" | "vscode-agent";
  source: ImportSource;
} {
  const { lines, at } = cut(text);
  if (at.length === 0) throw new Error("empty file");

  let records: unknown[];
  try {
    records = at.map((i) => JSON.parse(lines[i]));
  } catch {
    throw new Error("invalid JSONL");
  }

  /** The adapters count in records; the file counts in lines. This is the one
   *  place the two meet, and it is a translation rather than a second
   *  numbering: a frame that named record 2 names the line record 2 was on. */
  const inFile = (recordOrigin: Int32Array): Int32Array => {
    const out = new Int32Array(recordOrigin.length);
    for (let i = 0; i < recordOrigin.length; i++) {
      const r = recordOrigin[i];
      out[i] = r < 0 || r >= at.length ? -1 : at[r];
    }
    return out;
  };

  // Real Claude Code transcripts open with metadata records (queue-operation,
  // attachment, ai-title, …) before the first message — scan for the first
  // line that identifies a format instead of trusting line one.
  for (const rec of records) {
    const r = rec as { type?: unknown; message?: unknown; data?: unknown } | null;
    if (!r || typeof r.type !== "string") continue;
    if (SPECTRO_TYPES.has(r.type)) {
      // Replayed verbatim, so record and frame are the same thing. Carrying the
      // line anyway is what makes the byte identity checkable rather than
      // asserted: a hand-edited or foreign-written file is not what our writer
      // produced, and a blank line in it moves every number after it.
      const identity = new Int32Array(records.length);
      for (let i = 0; i < records.length; i++) identity[i] = at[i];
      return { events: records as RunEvent[], kind: "spectroscope", source: { lines, origin: identity } };
    }
    if (VSCODE_AGENT_TYPES.has(r.type) && hasDataObject(r)) {
      const { events, origin } = vscodeAgentWithOrigin(records);
      return { events, kind: "vscode-agent", source: { lines, origin: inFile(origin) } };
    }
    if (r.message !== undefined) {
      const { events, origin } = claudeCodeWithOrigin(records);
      return { events, kind: "claude-code", source: { lines, origin: inFile(origin) } };
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
