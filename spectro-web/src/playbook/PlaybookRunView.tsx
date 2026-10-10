// Card 482: the latest playbook run of this session, drawn by the state graph
// view from the graph file the runner writes, and a line that says whether the
// run is going or how it ended. While the run has no end the view asks again
// every second.
//
// The pane mounts this view again after a start (a new key), and the sidecar
// may not hold the new run yet on the first ask. The view therefore keeps
// asking for a few seconds after it mounts even when the latest run it sees
// has ended.
//
// Styles: styles/playbook-run.css, imported by app.css.

import { useEffect, useState } from "react";
import { dict, t, type Lang } from "../i18n/i18n";
import { useLang } from "../state/lang";
import { fetchRunGraph, fetchRuns, type PlaybookRunRow } from "../state/playbookRuns";
import { StateGraphView } from "../stategraph/StateGraphView";
import { DEFAULT_VIEW, type StateGraphViewState } from "../stategraph/viewState";

/** How often the view asks while the run is going, in milliseconds. */
const POLL_MS = 1000;
/** How many asks after mounting go on even when the latest run has ended. */
const GRACE_TICKS = 5;

/** The stop reason in words, or the raw word when the dictionary has none. */
function reasonWords(lang: Lang, reason: string): string {
  const key = `pb.run.stop.${reason}`;
  return dict[key] !== undefined ? t(lang, key) : reason;
}

export function PlaybookRunView({ sessionId }: { sessionId: string }) {
  const lang = useLang();
  const [row, setRow] = useState<PlaybookRunRow | null>(null);
  const [graph, setGraph] = useState("");
  const [view, setView] = useState<StateGraphViewState>(DEFAULT_VIEW);

  useEffect(() => {
    let alive = true;
    let ticks = 0;
    let timer: ReturnType<typeof setInterval> | null = null;
    const stop = (): void => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const tick = async (): Promise<void> => {
      ticks += 1;
      const rows = await fetchRuns(sessionId);
      if (!alive) return;
      const latest = rows.length > 0 ? rows[rows.length - 1] : null;
      setRow(latest);
      if (latest !== null) {
        const text = await fetchRunGraph(sessionId, latest.run);
        if (!alive) return;
        setGraph(text);
      }
      const going = latest !== null && latest.live;
      if (!going && ticks >= GRACE_TICKS) stop();
    };
    void tick();
    timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      stop();
    };
  }, [sessionId]);

  if (row === null) return null;

  const status = row.live
    ? t(lang, "pb.run.live")
    : row.stopReason === null
      ? t(lang, "pb.run.unrecorded")
      : t(lang, "pb.run.stopped", { reason: reasonWords(lang, row.stopReason) });

  return (
    <section className="pb-section pb-run-view" data-run={row.run}>
      <p className={`pb-run-status${row.live ? " is-live" : ""}`} role="status">
        {status}
      </p>
      {graph !== "" && (
        <div className="pb-run-graph">
          <StateGraphView
            graphJsonl={graph}
            stateJsonl={null}
            source={row.run}
            view={view}
            onView={setView}
          />
        </div>
      )}
    </section>
  );
}
