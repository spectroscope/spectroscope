// spectro-desktop/src/portMemory.ts — the port the shell remembers (card 168).
//
// localStorage is origin-bound. The shell used to ask the OS for a fresh port
// on every launch, so every desktop start ran the web app on a new
// localhost:<random> origin with an empty localStorage — every spectroscope:*
// preference (design, language, disclosure level, the built-in-model notice's
// dismissal) silently reset each boot. The cure is a stable origin: remember
// the port that served last launch and try it first; only when that bind
// fails does the shell fall back to a fresh OS-assigned port — one origin
// change, then stable again.
//
// Deliberately dependency-free and electron-free: the shell has no test rig
// (tsc only), so the decision lives here as pure functions and is unit-tested
// from spectro-web's vitest suite (src/state/portMemory.test.ts), the way
// cacheRecovery.test.ts already covers the cache-clear decision.

/** The marker filename under userData that remembers which port last served. */
export const SERVER_PORT_FILE = "server-port.json";

/**
 * Parse the marker file's contents; anything that is not a bindable TCP port
 * counts as absent. Port 0 is rejected on purpose: handing it to the bind
 * would mean "ask the OS", which is exactly the random-origin amnesia this
 * module exists to end.
 */
export function readRememberedPort(raw: string | null): number | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { port?: unknown };
    const port = parsed.port;
    if (typeof port !== "number" || !Number.isInteger(port)) return null;
    return port >= 1 && port <= 65535 ? port : null;
  } catch {
    return null; // a corrupt marker reads as absent — fresh port once, rewrite
  }
}

/** The marker file's contents for the port that is serving now. */
export function rememberedPortPayload(port: number): string {
  return JSON.stringify({ port }) + "\n";
}

/**
 * Write only when the port actually moved: the first launch (nothing
 * remembered) and the taken-port fallback. On an ordinary restart the marker
 * already holds the chosen port.
 */
export function shouldPersistPort(remembered: number | null, chosen: number): boolean {
  return remembered !== chosen;
}
