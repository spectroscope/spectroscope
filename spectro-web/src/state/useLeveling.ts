// The one place the ladder's state lives in the client.
//
// State comes from the server and only from the server. Every mutation posts
// and takes the server's answer as the new truth, so a mode flipped in another
// tab or a criterion marked by a run cannot leave a stale lock on screen. That
// is deliberate: deriving lock state from anything cached is the same bug class
// as the enteredFleet bleed, and a lock that should not be there is the most
// annoying possible failure of this feature.
//
// There is no polling and no new socket frame. The server's own mutations
// (a finished run marking first light) are picked up by an explicit refresh
// the app triggers on run_end, the same way the Files tab refreshes itself.
import { useCallback, useEffect, useRef, useState } from "react";
import type { LevelingSnapshot } from "./leveling";

/** What a component needs to render the ladder and act on it. */
export interface Leveling {
  /** The server's snapshot, or null while it is unknown or unavailable. */
  snapshot: LevelingSnapshot | null;
  /** Re-read the state; call it when the server may have marked something. */
  refresh: () => void;
  /** Report that a surface was shown. */
  visit: (surface: string, sessionId?: string | null, agentsShown?: number) => void;
  /** Switch mode; resolves once the server has answered. */
  setMode: (mode: LevelingSnapshot["mode"]) => Promise<void>;
  /** Mark a criterion by hand. */
  tick: (criterion: string) => Promise<void>;
  /** Restart the ladder from the dark frame. */
  reset: () => Promise<void>;
}

async function post(path: string, body: unknown): Promise<LevelingSnapshot | null> {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) return null;
    return (await res.json()) as LevelingSnapshot;
  } catch {
    return null;
  }
}

/**
 * Reads the ladder once on mount and keeps it in step with the server.
 *
 * A server that does not answer leaves the snapshot null, and everything
 * downstream treats null as "nothing is locked" — an older server, or one
 * booted without leveling, must never hide surfaces.
 */
export function useLeveling(): Leveling {
  const [snapshot, setSnapshot] = useState<LevelingSnapshot | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    fetch("/api/leveling")
      .then((r) => (r.ok ? r.json() : null))
      .then((state) => {
        if (alive.current && state && typeof state === "object") {
          setSnapshot(state as LevelingSnapshot);
        }
      })
      .catch(() => {
        /* an unreachable server locks nothing; the snapshot simply stays null */
      });
  }, []);

  useEffect(refresh, [refresh]);

  const apply = useCallback((state: LevelingSnapshot | null) => {
    if (alive.current && state) setSnapshot(state);
  }, []);

  const visit = useCallback(
    (surface: string, sessionId?: string | null, agentsShown?: number) => {
      void post("/api/leveling/visit", {
        surface,
        sessionId: sessionId ?? null,
        // What the face itself counted. Some criteria cannot be settled from the
        // server's stream at all — a scenario never reaches it — and the face is
        // the honest witness for what it actually rendered.
        agentsShown: agentsShown ?? null,
      }).then(apply);
    },
    [apply],
  );

  const setMode = useCallback(
    async (mode: LevelingSnapshot["mode"]) => {
      apply(await post("/api/leveling/mode", { mode }));
    },
    [apply],
  );

  const tick = useCallback(
    async (criterion: string) => {
      apply(await post("/api/leveling/tick", { criterion }));
    },
    [apply],
  );

  const reset = useCallback(async () => {
    apply(await post("/api/leveling/reset", {}));
  }, [apply]);

  return { snapshot, refresh, visit, setMode, tick, reset };
}
