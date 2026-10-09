// Card 472: GET /api/jobs/state carries two kinds of entry. Cron jobs keep
// their own ids; code graph builds (graphify run from the app) are listed as
// "codegraph:<folder>". This module tells them apart for the notification
// poller and the tray, so a build is never announced or counted as a cron job;
// a build raises no notice at all, the header chip says when it is ready.

/** The id prefix the server gives a code graph build in the jobs state. */
export const CODE_GRAPH_PREFIX = "codegraph:";

/** Whether a jobs-state id is a code graph build rather than a cron job. */
export function isCodeGraphJob(id: string): boolean {
  return id.startsWith(CODE_GRAPH_PREFIX);
}

/** The cron jobs alone, for the tray's label, tooltip and status dialog. */
export function cronJobs(jobs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(jobs).filter(([id]) => !isCodeGraphJob(id)));
}

/**
 * The native notification for one changed jobs-state entry.
 *
 * @param id    the jobs-state id
 * @param state the entry: its status and, for a session job, the session
 * @returns the title and body, or null when the change raises nothing
 */
export function jobNotice(
  id: string,
  state: { status?: string; sessionId?: string },
): { title: string; body: string } | null {
  const status = state.status ?? "unknown";
  // Owner decision 2026-10-09: a code graph build raises no desktop notice,
  // neither when it starts nor when it ends. The header's chip is the signal.
  if (isCodeGraphJob(id)) return null;
  return {
    title: `Cron job "${id}" ${status}`,
    body: state.sessionId ? "Click to open the session." : status,
  };
}
