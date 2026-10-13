// Card 600: the tool results cache switch under Local mode in the composer
// gear. It holds the server setting toolResultElision: read from the settings
// API and written back to the user settings, like the agent messaging switch.
// The key ships off, only "on" reads as on, and since fix round 1 the user
// settings are the only scope that may hold it, so the view without a session
// is the value every session runs with. Until a read has answered, the switch
// is disabled rather than drawn as off.

import { useEffect, useState } from "react";
import { fetchSettings, putSettings } from "./serverSettings";

/** What the switch draws, plus the two setters it flips and rolls back with. */
export interface ToolResultCacheState {
  /** Whether the switch is on, as last read or optimistically set. */
  on: boolean;
  /** Whether a read has answered since the gear opened; false disables the switch. */
  known: boolean;
  /** Why the last read failed, or null. */
  readError: string | null;
  /** The last save error, or null. */
  error: string | null;
  /** Flips the drawn state before the server has answered. */
  setOn: (next: boolean) => void;
  /** Records a refused save so the switch can say what went wrong. */
  setError: (message: string | null) => void;
}

/**
 * @param effective the effective settings the API reports
 * @returns true only when the key is "on"; absent is the shipped off
 */
export function toolResultCacheOf(effective: Record<string, unknown>): boolean {
  return effective["toolResultElision"] === "on";
}

/**
 * @param on what the switch is set to
 * @returns the settings value that saves it
 */
export function toolResultCacheValue(on: boolean): "on" | "off" {
  return on ? "on" : "off";
}

/**
 * Sets the switch at once and saves it to the user settings; a refused save
 * puts the switch back and keeps the reason.
 *
 * @param next  the state the switch was set to
 * @param state the switch's state and setters
 */
export function saveToolResultCache(next: boolean, state: ToolResultCacheState): void {
  state.setOn(next);
  state.setError(null);
  void putSettings("user", { toolResultElision: toolResultCacheValue(next) }).catch((e: unknown) => {
    state.setOn(!next);
    state.setError(e instanceof Error ? e.message : String(e));
  });
}

/**
 * Reads the switch each time the gear opens: the settings file is also
 * editable on the settings page and by hand.
 *
 * @param open whether the gear is open
 * @returns what the switch draws, and its two setters
 */
export function useToolResultCache(open: boolean): ToolResultCacheState {
  const [on, setOn] = useState(false);
  const [known, setKnown] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    setReadError(null);
    setKnown(false);
    void (async () => {
      try {
        const view = await fetchSettings();
        if (!live) return;
        setOn(toolResultCacheOf(view.effective));
        setKnown(true);
      } catch (e: unknown) {
        if (live) setReadError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [open]);
  return { on, known, readError, error, setOn, setError };
}
