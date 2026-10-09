// Card 472: the one place that asks the server about the code graph. It reads
// the status of the session's folder when the session changes (so a folder
// that already has a graph shows its chip on session open, a stored session
// opened read-only included), after a
// start, and every POLL_MS while a build runs; and it draws whichever sheet is
// open. The header, the ⋮ menu and the folder chip only read the store.

import { useEffect } from "react";
import { fetchCodeGraphStatus, pollDelay } from "./codeGraphModel";
import { closeCodeGraphSheet, setCodeGraphStatus, useCodeGraph } from "./codeGraphStore";
import { CodeGraphSheet } from "./CodeGraphSheet";

export function CodeGraphHost(props: { sessionId: string | null }) {
  const sessionId = props.sessionId;
  const { status, sheet, refresh } = useCodeGraph();

  useEffect(() => {
    let live = true;
    void fetchCodeGraphStatus(sessionId).then((next) => {
      if (live) setCodeGraphStatus(sessionId, next);
    });
    return () => {
      live = false;
    };
  }, [sessionId, refresh]);

  const delay = pollDelay(status);
  useEffect(() => {
    if (delay === null) return;
    let live = true;
    const timer = window.setTimeout(() => {
      void fetchCodeGraphStatus(sessionId).then((next) => {
        if (live) setCodeGraphStatus(sessionId, next);
      });
    }, delay);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [delay, status, sessionId]);

  if (sheet === null) return null;
  return <CodeGraphSheet status={status} sessionId={sessionId} view={sheet} onClose={closeCodeGraphSheet} />;
}
