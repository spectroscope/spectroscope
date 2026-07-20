// Small pure formatting helpers shared by the components. No state, no React.

import { t, type Lang } from "./i18n/i18n";

/** 950 -> "950", 12400 -> "12.4k", 231000 -> "231k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 100 ? String(Math.round(k)) : k.toFixed(1)}k`;
}

/** 412 -> "0.4 s", 12300 -> "12 s", 96000 -> "1 m 36 s". */
export function formatDuration(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 10000) return `${(clamped / 1000).toFixed(1)} s`;
  if (clamped < 60000) return `${Math.round(clamped / 1000)} s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.round((clamped % 60000) / 1000);
  return `${minutes} m ${seconds} s`;
}

/** Offset from run start: 0 -> "t+0.00s", 2310 -> "t+2.31s", 96000 -> "t+1m36s". */
export function formatRelMs(ms: number): string {
  const clamped = Math.max(0, ms);
  if (clamped < 60000) return `t+${(clamped / 1000).toFixed(2)}s`;
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  return `t+${minutes}m${String(seconds).padStart(2, "0")}s`;
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
