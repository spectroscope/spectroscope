// The llm-wire records this browser learns about from its OWN calls, and
// nowhere else (card 184 leg 2b).
//
// A chat turn's exchange arrives as a socket frame because there is a session
// socket to mirror it onto. Voice has none: the spoken bytes flow before any
// session exists, so the record lands in a shared day file and the only party
// that ever hears about it is the caller — this browser, in the answer to its
// own POST /api/transcribe. Without this the bytes and the transcript were
// recorded byte-exactly and appeared in no trace anywhere.
//
// A module store rather than a context, for the reason PR #56 recorded: a
// provider around App's render indented 1,241 JSX lines to carry 40 lines of
// feature. Same house pattern as sendQueue and aboutSignal.

import { useSyncExternalStore } from "react";
import type { LlmExchangeMeta } from "../wire/llmWire";

/** One exchange plus the sidecar it lives in — which for voice is the day file
 *  and not the session, so the row has to carry it rather than inherit it. */
export interface VoiceExchange extends LlmExchangeMeta {
  /** The sidecar id the gated endpoint answers for, e.g. `stt-2026-08-07`. */
  wireSession: string;
}

let exchanges: readonly VoiceExchange[] = [];
const listeners = new Set<() => void>();

/** Read the `wire` object off a transcribe answer, tolerantly. A run that never
 *  got as far as an exchange carries none, and that is the honest shape: an
 *  empty object would read as a record that got lost. */
export function readVoiceWire(value: unknown): VoiceExchange | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  const session = typeof v.session === "string" ? v.session : "";
  if (session === "" || typeof v.xid !== "string" || v.xid === "" || typeof v.ts !== "number") {
    return null;
  }
  const str = (x: unknown): string => (typeof x === "string" ? x : "");
  const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  return {
    wireSession: session,
    xid: v.xid,
    agentId: str(v.agentId) || "composer",
    turn: num(v.turn),
    kind: str(v.kind) || "stt",
    provider: str(v.provider),
    model: str(v.model),
    url: str(v.url),
    status: num(v.status),
    requestBytes: num(v.requestBytes),
    responseBytes: num(v.responseBytes),
    responseLines: num(v.responseLines),
    aborted: v.aborted === true,
    fidelity: str(v.fidelity),
    durationMs: num(v.durationMs),
    ts: v.ts,
  };
}

/** Remember one exchange this browser was told about. Deduped by xid: a retry
 *  that answered twice must not draw the same call twice. */
export function noteVoiceExchange(value: unknown): void {
  const x = readVoiceWire(value);
  if (x === null || exchanges.some((e) => e.xid === x.xid)) return;
  exchanges = [...exchanges, x];
  for (const l of listeners) l();
}

/** Visible for tests. */
export function currentVoiceExchanges(): readonly VoiceExchange[] {
  return exchanges;
}

/** Visible for tests. */
export function clearVoiceExchanges(): void {
  exchanges = [];
  for (const l of listeners) l();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function getSnapshot(): readonly VoiceExchange[] {
  return exchanges;
}

export function useVoiceExchanges(): readonly VoiceExchange[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
