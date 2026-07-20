// Pure helper for the session-resume feature: size up the stored history so
// the UI can say, honestly and BEFORE the next request, how much old context
// is about to ride back up to the LLM. The numbers mirror what
// SessionStore.loadSession reconstructs into provider messages (prompts,
// assistant text, tool calls and tool outputs); thinking deltas never re-enter
// the provider history, so they are deliberately NOT counted.

import type { RunEvent } from "../events";

export interface ResumeSummary {
  /** Every stored JSONL line that will be re-folded into the UI. */
  events: number;
  /** User prompts in the history (main run_starts). */
  prompts: number;
  /** Characters of provider-visible history (prompts + answers + tool i/o). */
  approxChars: number;
  /** The usual chars/4 estimate of the re-upload size. */
  estTokens: number;
}

export function summarizeHistory(events: RunEvent[]): ResumeSummary {
  // Mirror SessionStore.loadSession: only the MAIN agent's events re-enter the
  // provider history. The main agent is found STRUCTURALLY — the first
  // run_start without a parentId — and a subagent's deltas/tool i/o stay with
  // the child (its results reach the parent as tool_result output, which IS
  // counted on the main side).
  let mainId: string | null = null;
  for (const e of events) {
    if (e.type === "run_start" && e.parentId == null) {
      mainId = e.agentId;
      break;
    }
  }
  let prompts = 0;
  let chars = 0;
  for (const e of events) {
    const owner = (e as { agentId?: string }).agentId;
    if (owner !== undefined && mainId !== null && owner !== mainId) continue;
    switch (e.type) {
      case "run_start":
        if (e.parentId == null) {
          prompts += 1;
          chars += e.prompt.length;
        }
        break;
      case "text_delta":
        chars += e.text.length;
        break;
      case "tool_call":
        chars += e.name.length + JSON.stringify(e.input ?? null).length;
        break;
      case "tool_result":
        chars += e.output.length;
        break;
      default:
        break; // thinking_delta, usage, permission_*, ... never re-enter the provider history
    }
  }
  return {
    events: events.length,
    prompts,
    approxChars: chars,
    estTokens: Math.round(chars / 4),
  };
}
