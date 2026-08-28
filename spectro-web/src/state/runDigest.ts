// The run digest (card 294): RunEvent[] -> the compact text an OPT-IN analysis
// sends to the configured provider. Pure module, no React, no store, no fetch —
// building a digest moves nothing off this machine; only the consent click
// does, and that click lives in runAnalysis.ts.
//
// Two rules carry the file:
//   1. DETERMINISTIC. The consent dialog says "this digest is what leaves" —
//      that sentence is only honest when the same events always produce the
//      same bytes. No Date.now, no locale, no Math.random, no map iteration
//      whose order the input does not fix.
//   2. CAPPED, AND THE CAP IS STATED. Every free-text field is cut with a
//      visible mark, the agent list is bounded, the whole text is bounded, and
//      each bound writes its own sentence INTO the digest so neither the reader
//      nor the model mistakes the digest for the full transcript.

import type { RunEvent } from "../events";
import { foldWork, type WorkItem } from "./work";

/** The whole digest never exceeds this — well under the server's 60k bound. */
export const DIGEST_CAP_CHARS = 24_000;
/** How many agent blocks the digest carries at most. */
export const MAX_DIGEST_AGENTS = 40;

/** One free-text field (a task, a status, a result line). */
const FIELD_CAP_CHARS = 280;
/** The run's opening prompt gets a little more room. */
const PROMPT_CAP_CHARS = 400;
/** The tail of the main agent's final text. */
const ANSWER_TAIL_CHARS = 500;

export interface RunDigest {
  /** The text that would be sent — capped, derivation stated in line one. */
  text: string;
  /** Agents the recording holds (main not counted). */
  agents: number;
  /** Agents the digest kept. */
  shown: number;
  /** True when any bound cut something. */
  truncated: boolean;
}

/** Collapse a free text onto one line and cap it with a visible mark. */
function capped(text: string, cap: number): { text: string; cut: boolean } {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= cap) return { text: oneLine, cut: false };
  return { text: `${oneLine.slice(0, cap - 1)}…`, cut: true };
}

/** Milliseconds -> a stable, unit-honest span label ("5s", "3m20s", "2h5m"). */
function spanLabel(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 === 0 ? "" : `${s % 60}s`}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 === 0 ? "" : `${m % 60}m`}`;
}

/** Depth-first flatten, children after their parent — the fold's own order. */
function flatten(items: readonly WorkItem[]): WorkItem[] {
  const out: WorkItem[] = [];
  const walk = (list: readonly WorkItem[]): void => {
    for (const item of list) {
      out.push(item);
      walk(item.children);
    }
  };
  walk(items);
  return out;
}

/**
 * Build the digest of one recorded run.
 *
 * @param events the run's merged stream (children included, cards 291-293)
 * @return the digest text plus what was counted and what was cut
 */
export function buildRunDigest(events: readonly RunEvent[]): RunDigest {
  let truncated = false;
  const note = (cut: boolean): void => {
    truncated = truncated || cut;
  };

  // ---- the run frame ------------------------------------------------------
  const rootStart = events.find(
    (e): e is Extract<RunEvent, { type: "run_start" }> =>
      e.type === "run_start" && (e.parentId === undefined || e.parentId === null),
  );
  const rootEnd =
    rootStart === undefined
      ? undefined
      : [...events]
          .reverse()
          .find(
            (e): e is Extract<RunEvent, { type: "run_end" }> =>
              e.type === "run_end" && e.runId === rootStart.runId,
          );

  // The main agent's totals and final text, read directly off the stream —
  // foldWork deliberately keeps the main agent out of its items.
  let mainIn = 0;
  let mainOut = 0;
  let mainText = "";
  if (rootStart !== undefined) {
    for (const e of events) {
      if (e.type === "usage" && e.agentId === rootStart.agentId) {
        mainIn += e.inputTokens;
        mainOut += e.outputTokens;
      } else if (e.type === "text_delta" && e.agentId === rootStart.agentId) {
        mainText += e.text;
        // Only the tail is kept, so an hour-long run cannot grow this string
        // without bound while we fold.
        if (mainText.length > ANSWER_TAIL_CHARS * 4) mainText = mainText.slice(-ANSWER_TAIL_CHARS * 2);
      }
    }
  }

  // The last agent_message a child sent as its RESULT — the text foldWork
  // drops (it only flips the state) and the reading most worth carrying.
  const resultText = new Map<string, string>();
  for (const e of events) {
    if (e.type === "agent_message" && e.role === "result" && e.text.trim() !== "") {
      resultText.set(e.from, e.text);
    }
  }

  const lines: string[] = [];
  lines.push(
    "run digest (built by spectroscope from the recorded event stream; every field is capped, … marks a cut)",
  );
  if (rootStart === undefined) {
    lines.push("no run frame recorded");
  } else {
    const prompt = capped(rootStart.prompt, PROMPT_CAP_CHARS);
    note(prompt.cut);
    lines.push(`prompt: ${prompt.text}`);
    const frame: string[] = [];
    if (rootStart.provider !== undefined) frame.push(`provider: ${rootStart.provider}`);
    if (rootStart.model !== undefined) frame.push(`model: ${rootStart.model}`);
    frame.push(`started: ${new Date(rootStart.ts).toISOString()}`);
    if (rootEnd !== undefined) {
      frame.push(`duration: ${spanLabel(rootEnd.ts - rootStart.ts)}`);
      frame.push(`stop: ${rootEnd.stopReason}`);
    }
    lines.push(frame.join(" · "));
    lines.push(`main agent ${rootStart.agentId}: tokens in=${mainIn} out=${mainOut}`);
    if (mainText.trim() !== "") {
      const tail = mainText.replace(/\s+/g, " ").trim();
      const cutTail = tail.length > ANSWER_TAIL_CHARS;
      note(cutTail);
      lines.push(`answer tail: ${cutTail ? `…${tail.slice(-ANSWER_TAIL_CHARS)}` : tail}`);
    }
  }

  // ---- the agents ---------------------------------------------------------
  const all = flatten(foldWork(events));
  const kept = all.slice(0, MAX_DIGEST_AGENTS);
  note(kept.length < all.length);
  lines.push(
    all.length === 0
      ? "agents: none recorded beside the main agent"
      : `agents: ${all.length} recorded, ${kept.length} in this digest`,
  );

  for (const item of kept) {
    const head: string[] = [`- agent ${item.id}`];
    if (item.name !== "" && item.name !== item.id) head.push(item.name);
    head.push(`kind=${item.kind}`);
    if (item.model !== null) head.push(`model=${item.model}`);
    head.push(`state=${item.state}`);
    if (item.firstTs !== null && item.lastTs !== null)
      head.push(`span=${spanLabel(item.lastTs - item.firstTs)}`);
    head.push(`tokens in=${item.inTokens} out=${item.outTokens}`);
    head.push(`tools=${item.toolCalls}`);
    if (item.gatesAsked > 0) head.push(`gates asked=${item.gatesAsked} denied=${item.gatesDenied}`);
    lines.push(head.join(" · "));
    if (item.intent !== "") {
      const intent = capped(item.intent, FIELD_CAP_CHARS);
      note(intent.cut);
      lines.push(`  task: ${intent.text}`);
    }
    const last = resultText.get(item.id) ?? item.lastStatus;
    if (last !== null && last !== undefined && last.trim() !== "") {
      const line = capped(last, FIELD_CAP_CHARS);
      note(line.cut);
      lines.push(`  last: ${line.text}`);
    }
  }

  // ---- the hard cap -------------------------------------------------------
  let text = lines.join("\n");
  if (text.length > DIGEST_CAP_CHARS) {
    const marker = `\n[digest cut at ${DIGEST_CAP_CHARS} chars]`;
    text = text.slice(0, DIGEST_CAP_CHARS - marker.length) + marker;
    truncated = true;
  }

  return { text, agents: all.length, shown: kept.length, truncated };
}

/**
 * Whether a provider address is this machine — the consent dialog's
 * "the digest stays on this machine" line hangs on it, so the match is exact
 * (host part against the loopback names), never a substring: a substring test
 * would flatter "localhost.evil.example".
 *
 * @param address the address the server reported ("localhost:11434", "api.anthropic.com")
 * @return true only for loopback shapes
 */
export function isLoopbackAddress(address: string): boolean {
  const host = address.startsWith("[")
    ? address.replace(/^\[([^\]]*)\].*$/, "$1")
    : address.replace(/:\d+$/, "");
  return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}
