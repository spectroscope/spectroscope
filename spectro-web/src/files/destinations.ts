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
// An IPv4-mapped IPv6 address, dotted (`::ffff:127.0.0.1`) or in the hex form `new URL` writes (`::ffff:7f00:1`).
const MAPPED_IPV4 = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/;
// The first group of an IPv6 address: one to four hex digits before a colon.
const IPV6_FIRST_GROUP = /^([0-9a-f]{1,4}):/;
const LOOPBACK_NAMES = new Set(["localhost", "::1", "0.0.0.0"]);

/**
 * Where a provider runs when no exchange names a host: the run_start fallback
 * and an exchange whose url does not parse. A Map, so a provider named like an
 * Object.prototype member reads as unknown.
 * `ollama`, `lmstudio` and `llamacpp` stay unknown: the renderer prints them as a local server, address not recorded.
 */
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
 * The class of a host a model was called on. Loopback (also IPv4-mapped) is
 * this machine. The private ranges 10/8, 172.16/12, 192.168/16, 100.64/10
 * (Tailscale), fc00::/7, fe80::/10, `*.local` and `*.ts.net` are the network.
 * Behind either, a model ending in `:cloud` or `-cloud` is a local cloud: the
 * server there relays to its provider's cloud. Everything else is cloud. A
 * trailing dot is ignored.
 */
export function hostWhere(host: string, model: string): Where {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "") return "unknown";
  const place = placeOf(h);
  if (place === "cloud") return "cloud";
  return CLOUD_MODEL.test(model.trim()) ? "local-cloud" : place;
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
      const where = host === null ? providerWhere(provider) : hostWhere(host, model ?? "");
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
 * What `reachedBy` reads, built by `reachIndex` from one event list. It holds
 * the list as it was when built: a list that changed needs a new index.
 */
export interface ReachIndex {
  /** Key to the position of its first exchange of any kind, the row order of `destinations`. */
  readonly rank: ReadonlyMap<string, number>;
  /** Agent to key to the index of its last chat or compaction exchange. */
  readonly lastAt: ReadonlyMap<string, ReadonlyMap<string, number>>;
}

/** One pass over the events, so a report that asks once per finding stays linear. */
export function reachIndex(events: readonly RunEvent[]): ReachIndex {
  const rank = new Map<string, number>();
  const lastAt = new Map<string, Map<string, number>>();
  for (let i = 0; i < events.length; i++) {
    const e = events[i] as unknown as Record<string, unknown>;
    if (e.type !== "llm_exchange") continue;
    const { key } = exchangePlace(e);
    if (!rank.has(key)) rank.set(key, rank.size);
    if (e.kind !== "chat" && e.kind !== "compaction") continue;
    const agent = typeof e.agentId === "string" ? e.agentId : "";
    let byKey = lastAt.get(agent);
    if (byKey === undefined) {
      byKey = new Map();
      lastAt.set(agent, byKey);
    }
    byKey.set(key, i);
  }
  return { rank, lastAt };
}

/**
 * The keys of the destinations the agent's chat and compaction exchanges
 * after `fromIndex` went to, in the order of the rows. When the agent called
 * no model after that point, every key of `all`: the recording cannot say
 * which one the content reached.
 */
export function reachedBy(
  index: ReachIndex,
  agentId: string,
  fromIndex: number,
  all: readonly Destination[],
): string[] {
  const lastAt = index.lastAt.get(agentId);
  const keys: string[] = [];
  if (lastAt !== undefined) {
    for (const [key, at] of lastAt) if (at > fromIndex) keys.push(key);
  }
  if (keys.length === 0) return all.map((d) => d.key);
  return keys.sort((a, b) => (index.rank.get(a) ?? 0) - (index.rank.get(b) ?? 0));
}

function fromRunStart(events: readonly RunEvent[]): Destination[] {
  const rows = new Map<string, Destination>();
  const add = (provider: string | null, model: string | null): void => {
    const key = keyOf(provider, model, null);
    if (rows.has(key)) return;
    const where = providerWhere(provider);
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

function providerWhere(provider: string | null): Where {
  return provider === null ? "unknown" : (PROVIDER_WHERE.get(provider) ?? "unknown");
}

function keyOf(provider: string | null, model: string | null, host: string | null): string {
  return `${provider ?? ""}|${model ?? ""}|${host ?? ""}`;
}

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

type Place = "this-machine" | "network" | "cloud";

function placeOf(h: string): Place {
  if (LOOPBACK_NAMES.has(h)) return "this-machine";
  const ip = ipv4(h) ?? mappedIpv4(h);
  if (ip !== null) return ip[0] === 127 ? "this-machine" : privateIpv4(ip) ? "network" : "cloud";
  if (privateIpv6(h)) return "network";
  return h.endsWith(".local") || h.endsWith(".ts.net") ? "network" : "cloud";
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

function mappedIpv4(host: string): number[] | null {
  const m = MAPPED_IPV4.exec(host);
  if (m === null) return null;
  if (m[1] !== undefined) return ipv4(m[1]);
  const high = parseInt(m[2], 16);
  const low = parseInt(m[3], 16);
  return [high >> 8, high & 255, low >> 8, low & 255];
}

/** fc00::/7 (unique local) and fe80::/10 (link local), read from the first group. */
function privateIpv6(host: string): boolean {
  const m = IPV6_FIRST_GROUP.exec(host);
  if (m === null) return false;
  const group = parseInt(m[1], 16);
  return (group & 0xfe00) === 0xfc00 || (group & 0xffc0) === 0xfe80;
}
