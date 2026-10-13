// Card 554: a playbook run in the chat of its session, as the reducer folds it.
//
// Two socket-only frames: playbook_info says which playbook the session
// picked and whether its folder still holds one; playbook_confirm carries the
// start sheet's content for one /run-with-playbook. One session file line,
// playbook_progress, becomes one info line in the chat: the start with the
// playbook and the task, each step with its name and model, the end with the
// outcome (criterion 8f).
//
// Pure: the reducer calls these and keeps no language; the chat translates
// the keys when it draws the lines.

import { dict } from "../i18n/i18n";
import type { StartPreview } from "./playbookRuns";

/** The session's pick, from playbook_info or a recorded playbook_picked line. */
export interface PlaybookPick {
  /** The picked folder; null when nothing is picked. */
  dir: string | null;
  /** The playbook's name when its folder reads; null when it does not or nothing is picked. */
  name: string | null;
  /** False for a picked folder that no longer holds a playbook (and for no pick);
   *  null when only the session file spoke and the server has not checked yet. */
  found: boolean | null;
  /** Integrator decision b: present (true) only when the owner picked "No
   *  playbook"; the folder pinned for the workspace then does not stand in. */
  none?: true;
}

/** The start sheet's content, from playbook_confirm. */
export interface PlaybookConfirm {
  dir: string;
  /** The prompt typed after /run-with-playbook, the run's task. */
  prompt: string;
  preview: StartPreview;
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A playbook_info frame, or null when it cannot be read. */
export function parsePlaybookInfo(frame: unknown): PlaybookPick | null {
  const f = frame as { dir?: unknown; name?: unknown; found?: unknown; none?: unknown };
  if (typeof f.found !== "boolean") return null;
  const dir = text(f.dir);
  return {
    dir,
    name: text(f.name),
    found: f.found,
    ...(f.none === true && dir === null ? { none: true } : {}),
  };
}

/**
 * A playbook_picked line. Whether the folder is still there is the server's
 * to say, so a pick of the same folder keeps what the last frame said.
 */
export function pickOfLine(line: unknown, before: PlaybookPick | null): PlaybookPick {
  const l = line as { dir?: unknown; name?: unknown; none?: unknown };
  const dir = text(l.dir);
  return {
    dir,
    name: text(l.name),
    found: before !== null && before.dir === dir ? before.found : null,
    ...(l.none === true && dir === null ? { none: true } : {}),
  };
}

/** A playbook_confirm frame, or null when it cannot be read. */
export function parsePlaybookConfirm(frame: unknown): PlaybookConfirm | null {
  const f = frame as { dir?: unknown; prompt?: unknown; preview?: unknown };
  const dir = text(f.dir);
  const preview = f.preview as Partial<StartPreview> | undefined;
  if (dir === null || typeof f.prompt !== "string" || typeof preview !== "object" || preview === null)
    return null;
  if (!Array.isArray(preview.steps) || !Array.isArray(preview.refusals)) return null;
  return { dir, prompt: f.prompt, preview: preview as StartPreview };
}

/** One info line of the chat, in the reducer's shape. */
export interface ProgressLine {
  kind: "info";
  text: string;
  tone: "neutral" | "warn";
  infoKey: string;
  infoVars: Record<string, string>;
  infoRefKey?: string;
}

/** The model a step runs on, in one word group: "model (provider)". */
function modelWords(model: string | null, provider: string | null): string {
  if (model !== null && provider !== null) return `${model} (${provider})`;
  return model ?? provider ?? "?";
}

/**
 * The chat line of one playbook_progress line, or null for a phase this page
 * does not know.
 *
 * @param line the session file line
 * @returns the info line; `text` is the English the chat falls back to
 */
export function progressLine(line: unknown): ProgressLine | null {
  const l = line as Record<string, unknown>;
  switch (l.phase) {
    case "start": {
      const playbook = text(l.playbook) ?? "?";
      const task = text(l.task);
      return task === null
        ? {
            kind: "info",
            text: `Playbook ${playbook} started`,
            tone: "neutral",
            infoKey: "chat.pb.startNoTask",
            infoVars: { playbook },
          }
        : {
            kind: "info",
            text: `Playbook ${playbook} started on the task: ${task}`,
            tone: "neutral",
            infoKey: "chat.pb.start",
            infoVars: { playbook, task },
          };
    }
    case "step": {
      const name = text(l.name) ?? text(l.node) ?? "?";
      const model = modelWords(text(l.model), text(l.provider));
      return {
        kind: "info",
        text: `Step ${name} runs on ${model}`,
        tone: "neutral",
        infoKey: "chat.pb.step",
        infoVars: { name, model },
      };
    }
    case "end": {
      const reason = text(l.stopReason) ?? "?";
      const result = text(l.result);
      const detail = text(l.detail);
      const more = detail === null ? "" : ` ${detail}`;
      const refKey = `pb.run.stop.${reason}`;
      const known = dict[refKey] !== undefined;
      const words = known ? dict[refKey].en : reason;
      const vars: Record<string, string> = result === null ? { more } : { result, more };
      return {
        kind: "info",
        text:
          result === null
            ? `The playbook run ended: ${words}.${more}`
            : `The playbook run ended. Result: ${result}. Stop reason: ${words}.${more}`,
        tone: reason === "done" ? "neutral" : "warn",
        infoKey: result === null ? "chat.pb.end" : "chat.pb.endResult",
        infoVars: known ? vars : { ...vars, ref: reason },
        ...(known ? { infoRefKey: refKey } : {}),
      };
    }
    default:
      return null;
  }
}
