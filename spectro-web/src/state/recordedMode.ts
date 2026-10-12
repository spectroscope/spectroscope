// Card 504, last fix round: the permission mode of a stored session. The
// mode the page knows comes from permission_mode_info, a socket-only frame,
// and a stored session has no socket, so its gear used to mark the "ask" an
// empty fold defaults to. When the session is continued the server reads the
// mode from that session's workspace settings (SessionConnection, the
// session-moment config), so that is the mode the gear marks: the
// session-moment settings view, or the process-moment view when the session
// has no workspace (the session view answers 404 then).

import { useCallback, useEffect, useState } from "react";
import { fetchSettings, type SettingsView } from "./serverSettings";

function modeOf(view: SettingsView): string | null {
  const mode = view.effective?.permissionMode;
  return typeof mode === "string" && mode !== "" ? mode : null;
}

/**
 * @param sessionId a stored session's id
 * @return the permission mode it runs with when continued, or null when no view answers
 */
export async function recordedPermissionMode(sessionId: string): Promise<string | null> {
  try {
    return modeOf(await fetchSettings(sessionId));
  } catch {
    try {
      return modeOf(await fetchSettings());
    } catch {
      return null;
    }
  }
}

/** What the hook knows: the mode for one session, and whether the gear chose it. */
export interface Recorded {
  id: string;
  mode: string | null;
  chosen: boolean;
}

/** A fetch answered for `id`; a choice already made on that session stands. */
export function recordedFound(prev: Recorded | null, id: string, mode: string | null): Recorded {
  return prev !== null && prev.id === id && prev.chosen ? prev : { id, mode, chosen: false };
}

/** The gear's choice on `id` was taken: it shows at once. */
export function recordedChosen(id: string, mode: string): Recorded {
  return { id, mode, chosen: true };
}

/** The mode to show for `sessionId`, or null for a live session or an answer about another one. */
export function shownRecorded(state: Recorded | null, sessionId: string | null): string | null {
  return sessionId !== null && state?.id === sessionId ? state.mode : null;
}

/**
 * The recorded mode of the stored session `sessionId`, or null for none, while
 * loading, or for a live session (pass null), and the function the gear calls
 * when a mode it chose was taken.
 */
export function useRecordedMode(sessionId: string | null): [string | null, (mode: string) => void] {
  const [state, setState] = useState<Recorded | null>(null);
  useEffect(() => {
    if (sessionId === null) return;
    let alive = true;
    void recordedPermissionMode(sessionId).then((found) => {
      if (alive) setState((prev) => recordedFound(prev, sessionId, found));
    });
    return () => {
      alive = false;
    };
  }, [sessionId]);
  const choose = useCallback(
    (mode: string): void => {
      if (sessionId !== null) setState(recordedChosen(sessionId, mode));
    },
    [sessionId],
  );
  return [shownRecorded(state, sessionId), choose];
}
