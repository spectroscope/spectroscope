// Addressing a moment in a run: `#/session/{id}@{n}`.
//
// The ladder's receipts need it — a tick is a claim, and a claim gets a link
// you can follow to the frame that earned it. But the useful part is general:
// pasting "the agent went wrong at this exact event" into a bug report is worth
// more than a screenshot, and it costs one hash.
//
// Parsing is deliberately forgiving in one direction and strict in the other.
// A malformed index opens the session unseeked rather than guessing a frame,
// because landing on the wrong event is worse than landing on none.

/** A parsed session route. */
export interface SessionRoute {
  sessionId: string;
  /** The event to seek to, or null to open the session as it is. */
  eventIndex: number | null;
}

const PREFIX = "/session/";

/**
 * Reads a session route out of a location hash.
 *
 * @param hash the hash, with or without its leading `#`
 * @return the route, or null when the hash addresses something else
 */
export function parseRoute(hash: string | null | undefined): SessionRoute | null {
  if (!hash) {
    return null;
  }
  const path = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!path.startsWith(PREFIX)) {
    return null;
  }
  const rest = path.slice(PREFIX.length);
  if (rest === "") {
    return null;
  }
  // The last @ wins: a session id may contain one, an index may not.
  const at = rest.lastIndexOf("@");
  const rawId = at === -1 ? rest : rest.slice(0, at);
  const rawIndex = at === -1 ? "" : rest.slice(at + 1);
  if (rawId === "") {
    return null;
  }
  return { sessionId: safeDecode(rawId), eventIndex: wholeIndex(rawIndex) };
}

/**
 * Builds the hash for a session, optionally at an event.
 *
 * @param sessionId the session
 * @param eventIndex the event to land on, or null for the session as it is
 * @return the hash, including its leading `#`
 */
export function formatSessionRoute(sessionId: string, eventIndex: number | null): string {
  const id = encodeURIComponent(sessionId);
  return eventIndex === null ? `#${PREFIX}${id}` : `#${PREFIX}${id}@${eventIndex}`;
}

/** Only a whole, non-negative number addresses an event; anything else is none. */
function wholeIndex(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** A hand-typed hash may not be valid percent-encoding; take it literally then. */
function safeDecode(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}
