// Card 473: the session an expanded llm_exchange row reads its bodies from.
//
// The stored session on screen reads the server's sidecar, the live session
// reads its own once the server has named it, an entered fleet reads nothing.
// An import reads its held wire when it holds one (wire/heldWire.ts), and
// nothing otherwise; the pane then says the session carries no wire record.

import { heldLlmWire } from "../wire/heldWire";

/**
 * @param at.inFleet       whether a fleet is entered
 * @param at.replayId      the stored or imported session on screen, or null for live
 * @param at.canResume     whether that session is a stored one
 * @param at.liveSessionId the live session's id, once the server named it
 * @return the id the exchange fetch asks under, or null for no fetch
 */
export function llmWireSessionOf(at: {
  inFleet: boolean;
  replayId: string | null;
  canResume: boolean;
  liveSessionId: string | null;
}): string | null {
  if (at.inFleet) return null;
  if (at.replayId === null) return at.liveSessionId;
  if (at.canResume) return at.replayId;
  return heldLlmWire(at.replayId) !== null ? at.replayId : null;
}
