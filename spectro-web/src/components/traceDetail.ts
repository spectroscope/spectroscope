// Pure view-mode logic for the trace detail panel. Every entry has "wire
// lines": an ordinary frame is exactly ONE line (JSON as it crossed the
// socket, no artificial breaks); the synthetic session_resume marker carries
// the whole re-uploaded history, one JSONL line per event. Raw and Compact
// render these lines verbatim - newlines only between real lines, horizontal
// scrolling instead of wrapping.

import type { RunEvent } from "../events";

export type DetailMode = "insight" | "compact" | "raw";

export const DETAIL_MODES: readonly DetailMode[] = ["insight", "compact", "raw"];

export function detailLines(type: string, payload: unknown): string[] {
  if (type === "session_resume" && payload !== null && typeof payload === "object") {
    const history = (payload as { history?: RunEvent[] }).history;
    if (Array.isArray(history)) return history.map((e) => JSON.stringify(e));
  }
  return [JSON.stringify(payload)];
}

/** What the copy button grabs: the pretty tree for Insight, the exact lines
 *  for Compact and Raw (identical text, they differ only in highlighting). */
export function detailText(mode: DetailMode, type: string, payload: unknown): string {
  if (mode === "insight") return JSON.stringify(payload, null, 2);
  return detailLines(type, payload).join("\n");
}
