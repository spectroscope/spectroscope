// The desktop shell's one-time cache clear on upgrade (card 130).
//
// The server now serves index.html with no-cache and the hashed assets as
// immutable, which keeps every FUTURE shell honest. But a cache poisoned
// before that fix shipped keeps its heuristic freshness window, and an
// upgrade is exactly the moment the asset hashes change — the stale shell
// then loads a blank window off 404s. The shell's recovery is a one-time
// session.defaultSession.clearCache() whenever the running app version
// differs from the one persisted at last run.
//
// The decision is a pure function in spectro-desktop, which has no test rig
// of its own (tsc only) — so, like aboutSignal.test.ts one file over, the
// desktop half is tested from here. The pure module imports nothing from
// electron, which is what makes the direct import possible.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  lastRunVersionPayload,
  readLastRunVersion,
  shouldClearCache,
} from "../../../spectro-desktop/src/cacheRecovery";

describe("the should-we-clear decision", () => {
  it("clears when the version changed — the poisoned-cache moment", () => {
    expect(shouldClearCache("0.4.0", "0.4.1")).toBe(true);
  });

  it("does not clear on an ordinary restart", () => {
    expect(shouldClearCache("0.4.1", "0.4.1")).toBe(false);
  });

  it("clears when no marker exists — an upgrade from a build that predates it", () => {
    // A fresh install also lands here; clearing an empty cache is a no-op,
    // so the missing-marker case can afford to be unconditional.
    expect(shouldClearCache(null, "0.4.1")).toBe(true);
  });
});

describe("the marker file round-trip", () => {
  it("reads back the version it wrote", () => {
    const raw = lastRunVersionPayload("0.5.0");
    expect(readLastRunVersion(raw)).toBe("0.5.0");
  });

  it("treats a corrupt marker as absent rather than throwing", () => {
    expect(readLastRunVersion("not json {")).toBeNull();
    expect(readLastRunVersion(JSON.stringify({ version: 42 }))).toBeNull();
    expect(readLastRunVersion(null)).toBeNull();
  });
});

describe("the shell's half of the wire", () => {
  // Same rationale as the About wire: the two halves live in different
  // projects with different build systems and nothing else connects them.
  // A pure function nobody calls would pass every case above and clear
  // nothing.
  const shell = readFileSync(
    fileURLToPath(new URL("../../../spectro-desktop/src/main.ts", import.meta.url)),
    "utf8",
  );

  it("actually clears the Electron HTTP cache on the decision", () => {
    expect(shell).toContain("shouldClearCache");
    expect(shell).toContain("clearCache()");
  });

  it("persists the marker under userData keyed by app.getVersion()", () => {
    expect(shell).toContain('app.getPath("userData")');
    expect(shell).toContain("app.getVersion()");
  });
});
