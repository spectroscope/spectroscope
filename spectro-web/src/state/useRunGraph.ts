// Card 586: the graph file of the run the wide view shows.
//
// A playbook run writes a graph file the server serves per session and run
// (fetchRunGraph). The wide view asks for it once, and again every second
// while the run has no end in a live session, so the graph lights up as the
// run goes. A workflow run has no graph file and asks nothing. This is the
// polling the Playbook segment's run view had (card 482, removed by card 586),
// keyed by session and run id instead of the sidecar's latest run.

import { useEffect, useState } from "react";
import { fetchRunGraph } from "./playbookRuns";
import type { RunTrack } from "./runView";

/** How often the graph is asked again while the run goes, in milliseconds. */
const POLL_MS = 1000;

/** What to ask for a run's graph, or null when there is nothing to ask. */
export interface RunGraphAsk {
  sessionId: string;
  runId: string;
  /** Ask again every second, not only once. */
  poll: boolean;
}

/**
 * What the wide view asks for: a playbook run's graph in its session, polled
 * while the run has no end and the session is live.
 *
 * @param sessionId the session the run belongs to, null when it has no id the run routes accept
 * @param run       the shown run, or null
 * @param live      whether the session is live
 * @returns the ask; null for a workflow run, without a run or without a session
 */
export function runGraphAsk(
  sessionId: string | null,
  run: RunTrack | null,
  live: boolean,
): RunGraphAsk | null {
  if (sessionId === null || run === null || run.kind !== "playbook") return null;
  return { sessionId, runId: run.runId, poll: run.endedTs === null && live && run.cut !== true };
}

/**
 * Asks at once, then every second while `poll` is true.
 *
 * @param load   one ask; resolves to the graph text
 * @param poll   ask again every second
 * @param onText receives each answer that arrives before the stop
 * @param everyMs the interval, 1000 ms unless a caller says otherwise
 * @returns the stop: no ask after it, and no answer delivered after it
 */
export function pollRunGraph(
  load: () => Promise<string>,
  poll: boolean,
  onText: (text: string) => void,
  everyMs: number = POLL_MS,
): () => void {
  let alive = true;
  const ask = (): void => {
    void load().then((text) => {
      if (alive) onText(text);
    });
  };
  ask();
  const timer = poll ? setInterval(ask, everyMs) : null;
  return () => {
    alive = false;
    if (timer !== null) clearInterval(timer);
  };
}

/**
 * The graph file of a run as NDJSON text.
 *
 * @param sessionId the session the run belongs to
 * @param run       the shown run
 * @param live      whether the session is live
 * @returns the graph text; "" for a workflow run, and until the first answer
 */
export function useRunGraph(sessionId: string | null, run: RunTrack | null, live: boolean): string {
  const ask = runGraphAsk(sessionId, run, live);
  const key = ask === null ? "" : `${ask.sessionId}\n${ask.runId}`;
  const poll = ask?.poll ?? false;
  const [got, setGot] = useState<{ key: string; text: string }>({ key: "", text: "" });
  useEffect(() => {
    if (key === "") return;
    const [sid, runId] = key.split("\n");
    return pollRunGraph(
      () => fetchRunGraph(sid, runId),
      poll,
      (text) => setGot((was) => (was.key === key && was.text === text ? was : { key, text })),
    );
  }, [key, poll]);
  return key !== "" && got.key === key ? got.text : "";
}
