// Card 504, hub and spoke review round 2: the cut every head of a text at a cap
// goes through in state/ and the two trace views (state/pairSafeCut.drift.test.ts).
// The web twin of PeerNotices.cut on the server.

/**
 * The first `end` UTF-16 units of `text`, one fewer when the last kept unit
 * would be the high half of a surrogate pair. A text no longer than `end`
 * comes back whole.
 *
 * @param text the text to cut
 * @param end the most units to keep
 * @returns the cut text, never ending in half a pair
 */
export function pairSafeCut(text: string, end: number): string {
  if (end >= text.length) return text;
  if (end <= 0) return "";
  const last = text.charCodeAt(end - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end);
}
