// Card 473, round three: which recorded exchange an answer in the chat opens.
//
// An answer has no exchange id of its own. It has its agent and the moment its
// usage line closed it (`endTs`), and the exchange that produced it closes at
// that moment too: the usage line is written when the provider's stream ends.
// So an answer opens the chat exchange of the same agent that closed nearest
// to it, within a window, among the exchanges that had started by the time the
// answer closed: an exchange that started later belongs to a later answer,
// however near its close is. Compaction, image and speech exchanges answer no
// chat message and are never picked.

import { fetchLlmWireIndex, type LlmExchangeMeta } from "./llmWire";

/** How far apart an answer's close and its exchange's close may be. Measured
 *  in the same process they are milliseconds apart; the window allows for a
 *  slow writer without reaching the next turn of a normal run. */
export const ANSWER_EXCHANGE_WINDOW_MS = 10_000;

/** What an answer knows about itself. */
export interface AnswerAt {
  agentId: string;
  /** When the answer's usage line closed it; absent on an answer never billed. */
  endTs?: number;
}

/**
 * The exchange an answer opens, or null when none is near enough.
 *
 * @param index  the session's recorded exchanges
 * @param answer the answer's agent and closing moment
 */
export function exchangeForAnswer(
  index: readonly LlmExchangeMeta[],
  answer: AnswerAt,
): LlmExchangeMeta | null {
  if (answer.endTs === undefined) return null;
  const endTs = answer.endTs;
  let best: LlmExchangeMeta | null = null;
  for (const x of index) {
    if (x.agentId !== answer.agentId || x.kind !== "chat") continue;
    if (x.ts - x.durationMs > endTs) continue; // started after the answer closed
    const gap = Math.abs(x.ts - endTs);
    if (gap > ANSWER_EXCHANGE_WINDOW_MS) continue;
    if (best === null || gap < Math.abs(best.ts - endTs)) best = x;
  }
  return best;
}

/**
 * Reads the session's exchange index (the held wire of an import, or the
 * server's sidecar of a stored or live session) and picks the answer's
 * exchange.
 *
 * @param sessionId the session the exchange fetch asks under
 * @param answer    the answer's agent and closing moment
 */
export async function findAnswerExchange(
  sessionId: string,
  answer: AnswerAt,
): Promise<LlmExchangeMeta | null> {
  if (answer.endTs === undefined) return null;
  return exchangeForAnswer(await fetchLlmWireIndex(sessionId), answer);
}
