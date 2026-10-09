// Card 472 (owner, 2026-10-09): "Build code graph" runs graphify in the
// background of the harness, against the working folder of the live session.
// This module is the pure half: the wire to /api/codegraph, what the header
// shows for each state, and what the sheet offers first. The server owns the
// folder (it builds the one it resolved for the session) and every argument;
// the page only names a session, a mode and a choice from the server's list.

import type { Lang } from "../i18n/i18n";
import { t } from "../i18n/i18n";

/** One build, as the server reports it. */
export interface CodeGraphJob {
  folder: string;
  sessionId: string;
  mode: "full" | "update";
  state: "running" | "ok" | "failed";
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastLine: string | null;
  /** Up to the last twenty lines of output, oldest first. */
  tail: string[];
}

/** One provider the sheet offers for community names. */
export interface CodeGraphBackend {
  provider: string;
  backend: string;
  ready: boolean;
  reason: string | null;
}

/** GET /api/codegraph/status. Folder, graph and job are null without a session. */
export interface CodeGraphStatus {
  installed: boolean;
  binary: string | null;
  searched: string[];
  install: string;
  folder: string | null;
  graph: { exists: boolean; modifiedAt: string | null } | null;
  job: CodeGraphJob | null;
  backends: CodeGraphBackend[];
}

/** What the header draws beside the folder chip. */
export type HeaderView =
  | { kind: "none" }
  | { kind: "running"; since: string; lastLine: string | null }
  | { kind: "ready"; at: string | null }
  /** A failed build, and the graph an earlier build left, which stays reachable. */
  | { kind: "failed"; graph: { at: string | null } | null };

/** How often the header asks again while a build runs. */
export const POLL_MS = 2000;

/** How many lines the failure sheet shows; the server keeps the same number. */
export const FAILURE_LINES = 20;

/**
 * The header's state: a running build first, then a failed one (it says more
 * than an older graph does, and carries that graph so it stays reachable),
 * then a graph on disk, which is also what a session opened on a folder with
 * a graph shows.
 */
export function headerView(status: CodeGraphStatus | null): HeaderView {
  if (status === null) return { kind: "none" };
  const job = status.job;
  if (job !== null && job.state === "running") {
    return { kind: "running", since: job.startedAt, lastLine: job.lastLine };
  }
  const graph = status.graph !== null && status.graph.exists ? { at: status.graph.modifiedAt } : null;
  if (job !== null && job.state === "failed") return { kind: "failed", graph };
  if (graph !== null) return { kind: "ready", at: graph.at };
  if (job !== null && job.state === "ok") return { kind: "ready", at: job.endedAt };
  return { kind: "none" };
}

/** The sheet offers an update for a folder that has a graph, a full build otherwise. */
export function defaultMode(status: CodeGraphStatus | null): "full" | "update" {
  return status !== null && status.graph !== null && status.graph.exists ? "update" : "full";
}

/** The lines the failure sheet shows: the last twenty of the build's output. */
export function failureLines(status: CodeGraphStatus | null): string[] {
  const tail = status?.job?.tail ?? [];
  return tail.slice(-FAILURE_LINES);
}

/** The next poll's delay while a build runs, or null when there is nothing to wait for. */
export function pollDelay(status: CodeGraphStatus | null): number | null {
  return status?.job?.state === "running" ? POLL_MS : null;
}

/**
 * Asks the server for the code graph status.
 *
 * @param sessionId the live session, or null for the installation alone (doctor)
 * @returns the status, or null when the server cannot say
 */
export async function fetchCodeGraphStatus(
  sessionId: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<CodeGraphStatus | null> {
  const url =
    sessionId === null
      ? "/api/codegraph/status"
      : `/api/codegraph/status?sessionId=${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetchFn(url);
    if (!res.ok) return null;
    return (await res.json()) as CodeGraphStatus;
  } catch {
    return null;
  }
}

/** The body of POST /api/codegraph/start. */
export interface StartBody {
  sessionId: string;
  mode: "full" | "update";
  provider: string | null;
  model: string | null;
}

/** "No labels" travels as no provider and no model. */
export function startBody(
  sessionId: string,
  mode: "full" | "update",
  provider: string | null,
  model: string | null,
): StartBody {
  return provider === null
    ? { sessionId, mode, provider: null, model: null }
    : { sessionId, mode, provider, model };
}

/**
 * Starts a build.
 *
 * @returns the status code, 0 when the server is unreachable, and the server's
 *   own sentence when it refused
 */
export async function postCodeGraphStart(
  body: StartBody,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: number; message?: string }> {
  try {
    const res = await fetchFn("/api/codegraph/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 202) return { status: 202 };
    let message: string | undefined;
    try {
      const said = (await res.json()) as { message?: unknown };
      if (typeof said.message === "string") message = said.message;
    } catch {
      // A refusal without a body says only its status.
    }
    return message === undefined ? { status: res.status } : { status: res.status, message };
  } catch {
    return { status: 0 };
  }
}

/**
 * The session the code graph status is asked about: the live session, or a
 * stored session opened read-only from the list (AC5; the server reads its
 * folder from the session's own record). A scenario and an import have no
 * folder on this machine.
 *
 * @param viewingLive whether the live session is on screen
 * @param liveSessionId the live session's id, once it has one
 * @param replayId the id of the record on screen, when it is not live
 */
export function codeGraphSessionOf(
  viewingLive: boolean,
  liveSessionId: string | null,
  replayId: string | null,
): string | null {
  if (viewingLive) return liveSessionId;
  if (replayId === null || replayId.startsWith("scenario:") || replayId.startsWith("import:")) return null;
  return replayId;
}

/**
 * A short time for the header: the clock for today, the day and the clock for
 * an older file.
 *
 * @param timeZone left out in the app (the browser's zone); tests pin it
 */
export function shortTime(iso: string, lang: Lang, now: Date = new Date(), timeZone?: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const locale = lang === "de" ? "de-DE" : "en-GB";
  const day = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  const sameDay = day.format(at) === day.format(now);
  return new Intl.DateTimeFormat(locale, {
    ...(sameDay ? {} : { day: "numeric", month: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(at);
}

/** The doctor panel's code graph row: where graphify is, or the line that installs it. */
export function codeGraphDoctorRow(
  status: CodeGraphStatus | null,
  lang: Lang,
): { verdict: "ok" | "warn"; value: string } {
  if (status === null) return { verdict: "warn", value: t(lang, "doc.unreachable") };
  if (status.installed) return { verdict: "ok", value: `graphify · ${status.binary ?? "?"}` };
  return { verdict: "warn", value: `${t(lang, "cg.notInstalledShort")} · ${status.install}` };
}
