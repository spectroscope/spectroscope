// The web half of a playbook run (card 482): the start preview the
// confirmation sheet shows and the graph file of one run that the wide run
// view draws (card 586). The server owns both; this file only asks.

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

/** Card 584: whether a node that runs on a model has one that serves (PlaybookStartPreview.ModelCheck). */
export interface ModelCheck {
  node: string;
  name: string;
  kind: "step" | "review";
  choice: string;
  privacy: string;
  /** The playbook's primary model. */
  provider: string;
  model: string;
  serves: boolean;
  /** A fallback that serves in place of the primary, else null. */
  viaProvider: string | null;
  viaModel: string | null;
  /** Null when it serves; else one word for why the primary does not. */
  reason: string | null;
  httpStatus: number | null;
  /** For a rejected key only: where the key came from, never the key. */
  keySource: "environment" | "saved" | null;
}

/** Card 584: a provider whose model list answered in the sheet's check (PlaybookStartPreview.ModelOffer). */
export interface ModelOffer {
  provider: string;
  kind: string;
  models: string[];
}

/** What the server answers before a run starts. */
export interface StartPreview {
  dir: string;
  /** `sha256:` and the hex digest; null when the playbook did not load, and then `refusals` says why. */
  hash: string | null;
  findings: { path: string; message: string }[];
  steps: StepPlan[];
  /** Card 558: a run reads a step's skills from the playbook folder in place. */
  skills: { name: string; source: "playbook" | "missing" }[];
  commands: string[];
  refusals: string[];
  /** Card 584: one row per node that runs on a model; absent on a server before the card. */
  models?: ModelCheck[];
  /** Card 584: the models of every provider whose list answered; absent on a server before the card. */
  offers?: ModelOffer[];
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

/** The ids the run routes accept (PlaybookRunsController.SESSION_ID). */
const STORED_ID = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The session whose playbook runs the pane shows: the stored session opened
 * from the list when there is one, the live session otherwise. An import or a
 * scenario has no sidecar on this server, so it shows none, and never the live
 * session's runs under its name.
 *
 * @param liveSessionId the live session's id, null before it has one
 * @param replayId the id of the session opened from the list, null in the live view
 */
export function playbookSessionId(liveSessionId: string | null, replayId: string | null): string | null {
  if (replayId !== null) return STORED_ID.test(replayId) ? replayId : null;
  return liveSessionId;
}
