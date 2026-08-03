// spectro-desktop/src/cacheRecovery.ts — the one-time cache clear on upgrade (card 130).
//
// The server serves index.html with Cache-Control: no-cache and the hashed
// assets as immutable, which keeps every future load honest. This module is
// for the cache that is already wrong: Electron persists its HTTP cache in
// userData across app updates, and a shell cached before the header fix
// shipped can keep serving an index.html whose hashed assets the new jar no
// longer carries — a blank window, measured 2026-07-30. The recovery is one
// session.defaultSession.clearCache() whenever the running app version
// differs from the one persisted at last run.
//
// Deliberately dependency-free and electron-free: the shell has no test rig
// (tsc only), so the decision lives here as pure functions and is unit-tested
// from spectro-web's vitest suite (src/state/cacheRecovery.test.ts), the way
// aboutSignal.test.ts already covers the menu wire.

/** The marker filename under userData that remembers which version last ran. */
export const LAST_RUN_VERSION_FILE = "last-run-version.json";

/**
 * The decision: clear Electron's HTTP cache once when the app version changed.
 * A missing marker (null) means a fresh install — where clearing an empty
 * cache is a no-op — or an upgrade from a build that predates this file,
 * which is exactly the poisoned-cache case. Both clear.
 */
export function shouldClearCache(lastRunVersion: string | null, currentVersion: string): boolean {
  return lastRunVersion !== currentVersion;
}

/** Parse the marker file's contents; anything unreadable counts as absent. */
export function readLastRunVersion(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null; // a corrupt marker reads as absent — clear once, rewrite
  }
}

/** The marker file's contents for the version that is running now. */
export function lastRunVersionPayload(version: string): string {
  return JSON.stringify({ version }) + "\n";
}
