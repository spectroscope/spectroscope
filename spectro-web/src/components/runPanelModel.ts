// Card 586: the texts and marks of the run panel, pure. RunPanel.tsx draws
// them; the words come from the dictionary in English and German.

import { t, type Lang } from "../i18n/i18n";
import type { NodeStatus, RunEntry, RunFile, RunOutcome } from "../state/runView";

const MARK: Record<NodeStatus, string> = {
  done: "x",
  running: ">",
  waiting: "?",
  failed: "!",
  stopped: "-",
  pending: " ",
  skipped: "~",
};

/**
 * The mark of a status: "[x]" done, "[>]" running, "[?]" waiting, "[!]"
 * failed, "[-]" stopped, "[ ]" pending, "[~]" skipped.
 *
 * @param s        the status
 * @param decision true for a decision, drawn as a diamond: "<x>"
 */
export function statusMark(s: NodeStatus, decision = false): string {
  return decision ? `<${MARK[s]}>` : `[${MARK[s]}]`;
}

/** The word for a status, or for how a run ended. */
export function statusWord(lang: Lang, s: NodeStatus | RunOutcome): string {
  switch (s) {
    case "done":
      return t(lang, "run.panel.status.done");
    case "running":
      return t(lang, "run.panel.status.running");
    case "waiting":
      return t(lang, "run.panel.status.waiting");
    case "failed":
      return t(lang, "run.panel.status.failed");
    case "stopped":
      return t(lang, "run.panel.status.stopped");
    case "pending":
      return t(lang, "run.panel.status.pending");
    case "skipped":
      return t(lang, "run.panel.skipped");
  }
}

/**
 * A duration as "0:04", "2:14" or "1:02:03"; seconds are cut, not rounded.
 *
 * @param ms the duration; null gives "", a negative one "0:00"
 */
export function durationText(ms: number | null): string {
  if (ms === null) return "";
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/** How long an ended entry took: its own duration, else its end less its start; null while it is open. */
export function entryDuration(e: RunEntry): number | null {
  if (e.durationMs !== null) return e.durationMs;
  return e.endedTs === null ? null : e.endedTs - e.startedTs;
}

/**
 * Who works on an entry, with its model: "Chat · qwen2.5:7b" or
 * "worker-1 (worker) · glm-5.3 · picked". A fan-out names its children.
 * Empty when nothing is known.
 */
export function whoText(lang: Lang, e: RunEntry): string {
  const parts: string[] = [];
  if (e.performer === "chat") {
    parts.push(t(lang, "run.panel.chat"));
  } else {
    const names = e.kind === "fanout" && e.children.length > 0 ? e.children.join(", ") : (e.agents[0] ?? "");
    if (names !== "" && e.role !== null) parts.push(`${names} (${e.role})`);
    else if (names !== "") parts.push(names);
    else if (e.role !== null) parts.push(e.role);
  }
  // "picked" qualifies the model; without a model it says nothing.
  if (e.model !== null) {
    parts.push(e.model);
    if (e.picked) parts.push(t(lang, "run.panel.picked"));
  }
  return parts.join(" · ");
}

/**
 * A decision's line: "Review, round 2 of 5: changes needed". An exhausted
 * decision reads "Review, limit of 2 rounds reached", never "round 3 of 2".
 *
 * @returns the line, or null for an entry that is not a decision
 */
export function decisionText(lang: Lang, e: RunEntry): string | null {
  if (e.kind !== "decision") return null;
  let round: string | null = null;
  if (e.label === "exhausted") {
    round =
      e.maxRounds !== null
        ? t(lang, "run.panel.limit", { max: e.maxRounds })
        : t(lang, "run.panel.limitReached");
  } else if (e.round !== null && e.maxRounds !== null) {
    round = t(lang, "run.panel.round", { round: e.round, max: e.maxRounds });
  } else if (e.round !== null) {
    round = t(lang, "run.panel.roundOnly", { round: e.round });
  }
  const outcome = e.label !== null && e.label !== "exhausted" ? `: ${e.label}` : "";
  return `${e.name}${round !== null ? `, ${round}` : ""}${outcome}`;
}

/** The word for what a step did to a document or a file; null when it did not say "created" or "changed". */
export function changeWord(lang: Lang, change: RunFile["change"] | undefined): string | null {
  if (change === "created") return t(lang, "run.panel.created");
  if (change === "changed") return t(lang, "run.panel.changed");
  return null;
}
