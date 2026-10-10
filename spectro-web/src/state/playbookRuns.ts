// The web half of a playbook run (card 482): the start preview the
// confirmation sheet shows, the runs of a session from the sidecar, and the
// graph file of one run that the run view draws. The server owns all three;
// this file only asks.

/** One step as the confirmation shows it (PlaybookStartPreview.StepPlan). */
export interface StepPlan {
  id: string;
  name: string;
  performer: "chat" | "child";
  role: string | null;
  choice: string;
  provider: string;
  model: string;
  providerKind: string;
  providerState: string;
  privacy: string;
  permission: string;
  nod: boolean;
}

/** What the server answers before a run starts. */
export interface StartPreview {
  dir: string;
  /** `sha256:` and the hex digest; null when the playbook did not load, and then `refusals` says why. */
  hash: string | null;
  findings: { path: string; message: string }[];
  steps: StepPlan[];
  skills: { name: string; source: "playbook" | "installed" | "missing" }[];
  commands: string[];
  refusals: string[];
}

/** One run of a session, read from its sidecar. */
export interface PlaybookRunRow {
  run: string;
  playbook: string;
  startedAt: number;
  /** Null while the run has no end in the sidecar. */
  stopReason: string | null;
  live: boolean;
  graph: string;
}

/**
 * The confirmation of a run: steps, skills, commands, hash and refusals.
 *
 * @param dir the registered playbook folder
 * @param workspace the session's workspace
 */
export async function fetchStartPreview(dir: string, workspace: string): Promise<StartPreview> {
  const q = new URLSearchParams({ dir, workspace });
  const res = await fetch(`/api/playbooks/start-preview?${q.toString()}`);
  if (!res.ok) throw new Error(`start preview ${res.status}`);
  return (await res.json()) as StartPreview;
}

/**
 * The playbook runs of a session in the order they started; empty when the
 * server refuses or knows none.
 *
 * @param sessionId the session id
 */
export async function fetchRuns(sessionId: string): Promise<PlaybookRunRow[]> {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/playbook-runs`);
  return res.ok ? ((await res.json()) as PlaybookRunRow[]) : [];
}

/**
 * The graph artifact of one run as NDJSON text; empty when there is none.
 *
 * @param sessionId the session id
 * @param run the run id
 */
export async function fetchRunGraph(sessionId: string, run: string): Promise<string> {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/playbook-runs/${encodeURIComponent(run)}/graph`,
  );
  return res.ok ? res.text() : "";
}
