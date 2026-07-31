// The client half of the LLM-backed explain (card 62): build a BOUNDED text
// digest of the viewed run from the same feed the Text tab renders, and parse
// the server's NDJSON reply stream ({meta}/{delta}/{done}/{error} lines).
// Both pure — the fetch driver lives in the component, these fold and parse.

import type { RunEvent } from "../events";
import { buildTextFeed, feedToPlainText } from "./textFeed";

/** Default digest bound — roughly a short session; big runs get elided. */
export const DIGEST_CAP_CHARS = 24000;

/**
 * The run as readable text, capped. Over the cap the middle is dropped —
 * head (60%) and tail (40%) survive with an honest elision marker between
 * them, because the start (prompt, plan) and the end (outcome) carry the
 * interpretation weight while the middle is usually tool-output bulk.
 */
export function buildExplainDigest(events: readonly RunEvent[], cap: number = DIGEST_CAP_CHARS): string {
  const text = feedToPlainText(buildTextFeed(events));
  if (text.length <= cap) return text;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${elided} characters elided …]\n${text.slice(text.length - tail)}`;
}

/** One parsed NDJSON message from the explain stream. */
export interface ExplainMessage {
  meta?: { provider: string; model: string };
  delta?: string;
  done?: boolean;
  error?: string;
}

/**
 * Incremental NDJSON splitter: feed it the previous partial tail plus the new
 * chunk, get complete messages and the new tail. A non-JSON line is skipped
 * (never kills the stream) — the wire is ours, but a proxy hiccup should
 * degrade to a lost line, not a dead panel.
 */
export function parseNdjsonChunk(
  pending: string,
  chunk: string,
): { pending: string; messages: ExplainMessage[] } {
  const buf = pending + chunk;
  const lines = buf.split("\n");
  const tail = lines.pop() ?? "";
  const messages: ExplainMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as ExplainMessage);
    } catch {
      // skip the garbage line, keep the stream alive
    }
  }
  return { pending: tail, messages };
}
