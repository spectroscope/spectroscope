// Card 605: where a session's content went (design section 4, proposal R5).
// Pure work on the event list: every llm_exchange grouped by provider, model
// and host, or the providers of the top-level run_start events when the
// session recorded no exchange.

import { TITLE_AGENT_ID, type RunEvent } from "../events";

export type Where = "this-machine" | "local-cloud" | "network" | "cloud" | "unknown";

export interface Destination {
  /** `provider|model|host`, an absent part as the empty string. */
  key: string;
  provider: string | null;
  model: string | null;
  /** The URL's host name, an IPv6 address in brackets; null when not recorded. */
  host: string | null;
  where: Where;
  /** Recorded exchanges; 0 on a run_start row, which records none. */
  requests: number;
  /** The largest request body in bytes: a sum would count the same context many times. */
  largestRequest: number | null;
  /** False on a run_start row: the address was not recorded. */
  recorded: boolean;
}

// The test stayLocal in FilesConsent.tsx makes, copied: that file is a React component.
const CLOUD_MODEL = /[:-]cloud$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// Where a run_start provider runs when no exchange names a host. A Map, so a
// provider named like an Object.prototype member reads as unknown.
const PROVIDER_WHERE = new Map<string, Where>([
  ["spectro-local", "this-machine"],
  ["scripted", "this-machine"],
  ["anthropic", "cloud"],
  ["openai", "cloud"],
  ["gemini", "cloud"],
  ["copilot", "cloud"],
  ["openrouter", "cloud"],
]);

/**
 * The class of a host a model was called on. Loopback is this machine, or a
 * local cloud when the model ends in `:cloud` or `-cloud` (a local server
 * that forwards to its provider's cloud). The private ranges 10/8, 172.16/12,
 * 192.168/16, 100.64/10 (Tailscale), `*.local` and `*.ts.net` are the
 * network; everything else is cloud.
 */
export function hostWhere(host: string, model: string): Where {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "") return "unknown";
  const ip = ipv4(h);
  if (h === "localhost" || h === "::1" || h === "0.0.0.0" || (ip !== null && ip[0] === 127)) {
    return CLOUD_MODEL.test(model.trim()) ? "local-cloud" : "this-machine";
  }
  if (ip !== null) return privateIpv4(ip) ? "network" : "cloud";
  return h.endsWith(".local") || h.endsWith(".ts.net") ? "network" : "cloud";
}

/**
 * Every place the session's content was sent, in the order of first
 * appearance. Never empty: a session without exchanges and without a
 * run_start provider gets one row that says nothing was recorded.
 */
export function destinations(events: readonly RunEvent[]): Destination[] {
  const rows = new Map<string, Destination>();
  for (const event of events) {
    const e = event as unknown as Record<string, unknown>;
    if (e.type !== "llm_exchange") continue;
    const { key, provider, model, host } = exchangePlace(e);
    let row = rows.get(key);
    if (row === undefined) {
      const where = host === null ? "unknown" : hostWhere(host, model ?? "");
      row = { key, provider, model, host, where, requests: 0, largestRequest: null, recorded: true };
      rows.set(key, row);
    }
    row.requests++;
    const bytes = e.requestBytes;
    if (typeof bytes === "number" && Number.isFinite(bytes)) {
      row.largestRequest = row.largestRequest === null ? bytes : Math.max(row.largestRequest, bytes);
    }
  }
  return rows.size > 0 ? [...rows.values()] : fromRunStart(events);
}

/**
 * The keys of the destinations the agent's chat and compaction exchanges
 * after `fromIndex` went to, in the order of the rows. When the agent called
 * no model after that point, every key of `all`: the recording cannot say
 * which one the content reached.
 */
export function reachedBy(
  events: readonly RunEvent[],
  agentId: string,
  fromIndex: number,
  all: readonly Destination[],
): string[] {
  const reach = reachOf(events);
  const lastAt = reach.lastAt.get(agentId);
  const keys: string[] = [];
  if (lastAt !== undefined) {
    for (const [key, at] of lastAt) if (at > fromIndex) keys.push(key);
  }
  if (keys.length === 0) return all.map((d) => d.key);
  return keys.sort((a, b) => (reach.rank.get(a) ?? 0) - (reach.rank.get(b) ?? 0));
}

interface Reach {
  length: number;
  /** Key to the position of its first exchange of any kind, the row order of `destinations`. */
  rank: Map<string, number>;
  /** Agent to key to the index of its last chat or compaction exchange. */
  lastAt: Map<string, Map<string, number>>;
}

// One pass per event list, so a report that asks once per finding stays linear.
// The length check reads a list again after it grew in place.
const REACH = new WeakMap<readonly RunEvent[], Reach>();

function reachOf(events: readonly RunEvent[]): Reach {
  const cached = REACH.get(events);
  if (cached !== undefined && cached.length === events.length) return cached;
  const reach: Reach = { length: events.length, rank: new Map(), lastAt: new Map() };
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as unknown as Record<string, unknown>;
    if (e.type !== "llm_exchange") continue;
    const { key } = exchangePlace(e);
    if (!reach.rank.has(key)) reach.rank.set(key, reach.rank.size);
    if (e.kind !== "chat" && e.kind !== "compaction") continue;
    const agent = typeof e.agentId === "string" ? e.agentId : "";
    let byKey = reach.lastAt.get(agent);
    if (byKey === undefined) {
      byKey = new Map();
      reach.lastAt.set(agent, byKey);
    }
    byKey.set(key, i);
  }
  REACH.set(events, reach);
  return reach;
}

function fromRunStart(events: readonly RunEvent[]): Destination[] {
  const rows = new Map<string, Destination>();
  const add = (provider: string | null, model: string | null): void => {
    const key = keyOf(provider, model, null);
    if (rows.has(key)) return;
    const where = provider === null ? "unknown" : (PROVIDER_WHERE.get(provider) ?? "unknown");
    rows.set(key, {
      key,
      provider,
      model,
      host: null,
      where,
      requests: 0,
      largestRequest: null,
      recorded: false,
    });
  };
  for (const event of events) {
    const e = event as unknown as Record<string, unknown>;
    // The fold's rule: a child run or the title agent is not the session's own run.
    if (e.type !== "run_start" || e.parentId || e.agentId === TITLE_AGENT_ID) continue;
    add(text(e.provider), text(e.model));
  }
  if (rows.size === 0) add(null, null);
  return [...rows.values()];
}

function exchangePlace(e: Record<string, unknown>): {
  key: string;
  provider: string | null;
  model: string | null;
  host: string | null;
} {
  const provider = text(e.provider);
  const model = text(e.model);
  const host = hostOf(e.url);
  return { key: keyOf(provider, model, host), provider, model, host };
}

/** The host of a URL; null when it does not parse or names none (`copilot-runtime`, `localhost:11434`). */
function hostOf(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const host = new URL(url).hostname;
    return host === "" ? null : host;
  } catch {
    return null;
  }
}

function keyOf(provider: string | null, model: string | null, host: string | null): string {
  return `${provider ?? ""}|${model ?? ""}|${host ?? ""}`;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function ipv4(host: string): number[] | null {
  const m = IPV4.exec(host);
  if (m === null) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function privateIpv4([a, b]: number[]): boolean {
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}
