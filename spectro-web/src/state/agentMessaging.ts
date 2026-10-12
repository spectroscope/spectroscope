// Card 503: what the composer's settings menu needs to draw the agent
// messaging switch. Like rtkFilter, a SERVER setting: read from the settings
// API and written back to it; the local state is only what the row draws
// between the click and the server's answer. The key ships on, and only an
// explicit false switches it off.

import { useEffect, useState } from "react";
import { fetchSettings } from "./serverSettings";

/** What the row draws, plus the two setters it flips and rolls back with. */
export interface AgentMessagingState {
  /** Whether agent messaging is on, as last read or optimistically set. */
  on: boolean;
  /** The last save error, or null. */
  error: string | null;
  /** Flips the drawn state before the server has answered. */
  setOn: (next: boolean) => void;
  /** Records a refused save so the row can say what went wrong. */
  setError: (message: string | null) => void;
}

/**
 * @param on what the row shows
 * @returns what a click saves
 */
export function agentMessagingNext(on: boolean): boolean {
  return !on;
}

/**
 * @param effective the effective settings the API reports
 * @returns false only when the key is false; absent is the shipped on
 */
export function agentMessagingOf(effective: Record<string, unknown>): boolean {
  return effective["agentMessaging"] !== false;
}

/**
 * Reads the switch each time the menu opens, as useRtkFilter does: the
 * settings file is also editable on the settings page and by hand.
 *
 * @param open whether the menu is open
 * @returns what the row draws, and its two setters
 */
export function useAgentMessaging(open: boolean): AgentMessagingState {
  const [on, setOn] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setError(null);
    void (async () => {
      try {
        const view = await fetchSettings();
        if (live) setOn(agentMessagingOf(view.effective));
      } catch {
        /* the row keeps what it had; a settings read is not worth an alarm */
      }
    })();
    return () => {
      live = false;
    };
  }, [open]);
  return { on, error, setOn, setError };
}
