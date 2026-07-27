// Small pure formatting helpers shared by the components. No state, no React.

import { t, type Lang } from "./i18n/i18n";

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
