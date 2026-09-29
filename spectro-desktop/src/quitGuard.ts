// Card 459, owner call 4: several sessions can run at once, and quitting the
// app stops every one of them (the server goes down with the shell). So a quit
// while sessions are working asks first. Their history stays either way: each
// run appends to its session file as it goes.
//
// Pure, so node:test holds the rule; main.ts does the asking.

/** How many sessions of the server's live set (GET /api/sessions/live) have a run in flight. */
export function runningCount(body: unknown): number {
  if (!Array.isArray(body)) return 0;
  return body.filter(
    (row) => typeof row === "object" && row !== null && (row as { running?: unknown }).running === true,
  ).length;
}

/** The question a quit asks, or null when nothing runs. Button 0 quits. */
export function quitQuestion(
  running: number,
): { message: string; detail: string; buttons: string[]; defaultId: number; cancelId: number } | null {
  if (running <= 0) return null;
  const sessions = running === 1 ? "1 session is" : `${running} sessions are`;
  return {
    message: `${sessions} still working. Quit anyway?`,
    detail: "Quitting stops the running work. What each session did so far stays in its history.",
    buttons: ["Quit", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  };
}
