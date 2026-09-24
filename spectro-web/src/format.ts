// Small pure formatting helpers shared by the components. No state, no React.

import { t, type Lang } from "./i18n/i18n";
// Type only, so format.ts keeps its one runtime dependency and there is no
// import edge from a pure formatter into a React store.
import type { AnswerLineMode } from "./state/answerLine";

/** 950 -> "950", 12400 -> "12.4k", 231000 -> "231k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`;
}

/** Local wall clock HH:MM:SS — the answer footer's start/end stamps (card 87). */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** One half of an answer's input-side cache traffic: what rode in from the
 *  cache ("read" — the hit) and what was written into it ("write"). */
export type CacheSegment = { kind: "read" | "write"; tokens: number };

/**
 * The cache split of one answer, in reading order (the hit first, because it
 * is the question anyone asks). Empty when the provider reported no cache —
 * and a reported zero counts as "none": it is the provider saying nothing was
 * cached, not a number worth a segment.
 *
 * Deliberately no verdict on the cache TTL. The wire records neither the TTL
 * nor whether an entry expired, and a write following an earlier write is the
 * NORMAL incremental case (read the cached prefix, write the new increment) —
 * real sessions do it seconds apart. Anything phrased as expiry would be a
 * diagnosis the data cannot support.
 */
export function cacheSplit(usage: {
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): CacheSegment[] {
  const segments: CacheSegment[] = [];
  const read = usage.cacheReadTokens ?? 0;
  const write = usage.cacheCreationTokens ?? 0;
  if (read > 0) segments.push({ kind: "read", tokens: read });
  if (write > 0) segments.push({ kind: "write", tokens: write });
  return segments;
}

/**
 * Output tokens per second of one answer (card 245) — the output count over
 * the measured generation window (first delta to the usage stamp). Null
 * whenever the data cannot honestly carry a rate: no measured duration, a
 * zero-length window, or nothing generated. Below ten the tenth digit is the
 * story (the local-model tier); from ten up whole tokens suffice — decided on
 * the ROUNDED value, so no answer ever reads "10.0 tok/s".
 */
export function tokensPerSecond(outputTokens: number, durationMs: number | undefined): string | null {
  if (durationMs === undefined || durationMs <= 0 || outputTokens <= 0) return null;
  const rate = outputTokens / (durationMs / 1000);
  const tenth = Math.round(rate * 10) / 10;
  return `${tenth >= 10 ? String(Math.round(rate)) : tenth.toFixed(1)} tok/s`;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 412 -> "0.4 s", 12300 -> "12 s", 96000 -> "1 m 36 s", 72612000 -> "20 h 10 m". */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 10000) return `${(clamped / 1000).toFixed(1)} s`;
  // Round into the smallest unit a tier displays FIRST, then pick the tier from
  // the rounded value and split it. Rounding after the split is what produces
  // impossible readings like "59 m 60 s": the seconds overflow their base with
  // no way to carry. Here the carry happens before anything is rendered, so
  // every sub-unit is structurally below 60.
  const totalSeconds = Math.round(clamped / 1000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)} m ${totalSeconds % 60} s`;
  const totalMinutes = Math.round(clamped / 60000);
  return `${Math.floor(totalMinutes / 60)} h ${totalMinutes % 60} m`;
}

/**
 * Offset from run start: 0 -> "t+0.00s", 2310 -> "t+2.31s", 96000 -> "t+1m36s",
 * 72612000 -> "t+20h10m12s". Truncated, never rounded: this labels the moment an
 * event happened, and an event at t+1m36.9s did happen after t+1m36s. Seconds
 * survive into the hour tier because the graph labels every node with this —
 * dropping them would make everything in a long run read alike.
 */
export function formatRelMs(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60000) return `t+${(clamped / 1000).toFixed(2)}s`;
  const totalSeconds = Math.floor(clamped / 1000);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = pad2(totalSeconds % 60);
  if (totalMinutes < 60) return `t+${totalMinutes}m${seconds}s`;
  return `t+${Math.floor(totalMinutes / 60)}h${pad2(totalMinutes % 60)}m${seconds}s`;
}

/** "just now", "5 min ago", "2 h ago", "3 d ago". */
export function relativeTime(ts: number, now: number = Date.now(), lang: Lang = "en"): string {
  const minutes = Math.floor(Math.max(0, now - ts) / 60000);
  if (minutes < 1) return t(lang, "time.now");
  if (minutes < 60) return t(lang, "time.min", { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(lang, "time.h", { n: hours });
  return t(lang, "time.d", { n: Math.floor(hours / 24) });
}

/** Pastel accent per agent id — decoration only (border/badge, never text). */
export function agentAccent(agentId: string): string {
  if (agentId === "main") return "var(--agent-root)";
  if (agentId.startsWith("explore")) return "var(--agent-explore)";
  if (agentId.startsWith("worker")) return "var(--agent-worker)";
  return "var(--agent-extra)";
}

/** One-line JSON for header previews. */
export function compactJson(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
}

/** Pretty JSON for expanded input blocks and the permission modal. */
export function prettyJson(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

/** Middle-ellipsis WITHOUT the basename split — for glob patterns and other
 *  non-path strings the disk pill shows, where the directories are the point. */
export function clipMiddle(s: string, max = 22): string {
  if (s.length <= max) return s;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/** Last path segment, then Apple-style middle ellipsis so start AND end stay readable. */
export function fileLabel(path: string, max = 22): string {
  const segs = path.split(/[/\\]+/).filter(Boolean);
  const name = segs.length > 0 ? segs[segs.length - 1] : path;
  return clipMiddle(name, max);
}

/** What one segment of the answer line is. `value` is the number or string as
 *  it reads, `label` is the word beside it and is empty where the value speaks
 *  for itself, `title` carries the untruncated string where the value was
 *  shortened. */
export type AnswerSegmentKind =
  "in" | "cacheRead" | "cacheWrite" | "out" | "context" | "rate" | "duration" | "window" | "model";

export interface AnswerSegment {
  kind: AnswerSegmentKind;
  value: string;
  label: string;
  title?: string;
}

/** The part of an assistant turn this line reads. Structural on purpose: the
 *  reducer's Turn is assignable to it and format.ts keeps its one import. */
export interface AnswerLineTurn {
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  durationMs?: number;
  endTs?: number;
  model?: string;
}

/**
 * The segments of one answer's line, in reading order (card 374). Empty when
 * nothing was measured: no usage event, no line, which is the behaviour the
 * flat row had at Chat.tsx:736 and the one criterion 10 pins.
 *
 * normal is the everyday reading the owner asked for: what went in, what came
 * out, how long it took. extended adds what the event carries beyond that, the
 * cache halves where the provider reported them, the true context size, the
 * rate, the wall clock window and the model.
 *
 * The context total is the sum Agent.contextTokens computes at Agent.java:1353,
 * the uncached remainder plus both cache halves. It is drawn ONLY where a cache
 * half was reported: with no cache the sum IS the remainder, and two labels
 * over one number read as two measurements. On the owner's backends, which
 * build the two argument PUsage (OpenAiCompatProvider.java:967,
 * OllamaProvider.java:593), that means the total is always absent.
 *
 * The cache rule itself is not restated here. It is read out of cacheSplit,
 * which already says a reported zero counts as none and is pinned six ways in
 * format.test.ts.
 */
export function answerLineSegments(
  mode: AnswerLineMode,
  turn: AnswerLineTurn,
  lang: Lang = "en",
): AnswerSegment[] {
  const usage = turn.usage;
  if (usage === undefined) return [];
  const extended = mode === "extended";
  const split = cacheSplit(usage);
  const cached = split.reduce((n, c) => n + c.tokens, 0);

  const segments: AnswerSegment[] = [{ kind: "in", value: String(usage.inputTokens), label: "in" }];
  if (extended) {
    for (const c of split) {
      segments.push({
        kind: c.kind === "read" ? "cacheRead" : "cacheWrite",
        value: String(c.tokens),
        label: t(lang, c.kind === "read" ? "chat.cacheRead" : "chat.cacheWrite"),
      });
    }
  }
  segments.push({ kind: "out", value: String(usage.outputTokens), label: "out" });
  if (extended && cached > 0) {
    segments.push({
      kind: "context",
      value: String(usage.inputTokens + cached),
      label: t(lang, "aline.context"),
    });
  }
  if (extended) {
    const rate = tokensPerSecond(usage.outputTokens, turn.durationMs);
    if (rate !== null) segments.push({ kind: "rate", value: rate, label: "" });
  }
  if (turn.durationMs !== undefined) {
    segments.push({ kind: "duration", value: formatDuration(turn.durationMs), label: "" });
  }
  if (extended && turn.endTs !== undefined && turn.durationMs !== undefined) {
    segments.push({
      kind: "window",
      value: `${clockTime(turn.endTs - turn.durationMs)} → ${clockTime(turn.endTs)}`,
      label: "",
    });
  }
  if (extended && turn.model !== undefined) {
    segments.push({ kind: "model", value: fileLabel(turn.model), label: "", title: turn.model });
  }
  return segments;
}
