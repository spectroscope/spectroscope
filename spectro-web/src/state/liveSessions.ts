// Which sessions are live on this server — the fact the rail could not read.
//
// The page holds ONE socket. Before card 212 that was also the whole of what it
// could call live, and Sidebar.tsx said so in its own comment: the live row was
// "the only one in the rail that may ever say running, because it is the only
// session this page holds a socket to". Two runs at once meant one of them was
// invisible from whichever tab you were in.
//
// The server now reports the set. This store folds it, from two sources on
// purpose:
//
//   push — the additive `live_sessions` socket frame, sent on connect and on
//          every change. Immediate, and the reason the rail feels live.
//   poll — GET /api/sessions/live every LIVE_POLL_MS. The FLOOR under the push,
//          for a page that has just loaded and for a socket that was down while
//          something started or finished. It is what makes "how stale can this
//          be" a number instead of a hope.
//
// The push always wins. A poll that left before a push and answered after it
// would otherwise resurrect a finished session for one interval, over and over.
//
// External store, the house pattern (useSyncExternalStore), like fleetStore and
// the trace's column and filter stores next to it.

import { useSyncExternalStore } from "react";
import type { RunEvent } from "../events";

/** One live session, exactly as the server's LiveSessions.LiveSession record. */
export interface LiveSessionRow {
  /** The session id — the same id GET /api/sessions lists and a row is keyed by. */
  readonly id: string;
  /** True while a run is in flight on the socket holding this session. */
  readonly running: boolean;
  /** When the holding socket claimed it, epoch millis. */
  readonly since: number;
}

/**
 * How stale the live set can get without a push, in milliseconds.
 *
 * Five seconds is a choice between two costs and it is written down rather
 * than tuned by feel: the request is a snapshot of an in-memory map on
 * loopback, and a rail that is wrong for longer than a glance is worse than
 * the request. The push covers everything faster than this; the number is the
 * worst case for a client that missed one.
 */
export const LIVE_POLL_MS = 5000;

/** The REST path serving the same list the socket frame pushes. */
const LIVE_URL = "/api/sessions/live";

const listeners = new Set<() => void>();
let live: LiveSessionRow[] = [];
/** Bumped on every push; a poll answer older than the current mark is dropped. */
let generation = 0;
let doFetch: typeof fetch = (...args) => fetch(...args);

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** One row, or null when the value is not one. */
function row(value: unknown): LiveSessionRow | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { id?: unknown; running?: unknown; since?: unknown };
  if (typeof candidate.id !== "string" || candidate.id === "") return null;
  return {
    id: candidate.id,
    running: candidate.running === true,
    since: typeof candidate.since === "number" ? candidate.since : 0,
  };
}

/** An array of rows, dropping anything that is not one. */
function rows(value: unknown): LiveSessionRow[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: LiveSessionRow[] = [];
  for (const entry of value) {
    const one = row(entry);
    if (one !== null) parsed.push(one);
  }
  return parsed;
}

/**
 * Reads a `live_sessions` socket frame.
 *
 * @param frame anything off the wire — the socket forwards frames this build
 *              has never seen, so this must survive all of them
 * @return the live set, or null when the frame is not one
 */
export function liveSessionsOfFrame(frame: unknown): LiveSessionRow[] | null {
  if (typeof frame !== "object" || frame === null) return null;
  if ((frame as { type?: unknown }).type !== "live_sessions") return null;
  return rows((frame as { sessions?: unknown }).sessions);
}

/**
 * Reads the REST body, which is the bare array the controller returns.
 *
 * @param body the parsed JSON body of GET /api/sessions/live
 * @return the live set, or null when the body is not an array of rows
 */
export function liveSessionsOfBody(body: unknown): LiveSessionRow[] | null {
  return rows(body);
}

/**
 * Reads a `session_busy` refusal — the server telling this page that the
 * session it asked to resume belongs to another socket.
 *
 * @param frame anything off the wire
 * @return the refused session id, or null when the frame is not a refusal
 */
export function readSessionBusy(frame: unknown): string | null {
  if (typeof frame !== "object" || frame === null) return null;
  if ((frame as { type?: unknown }).type !== "session_busy") return null;
  const id = (frame as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Folds one live socket batch. Latest-wins: the frame carries the WHOLE set, so
 * a batch's last frame is the answer and everything before it is history.
 *
 * @param batch the rAF batch straight off the socket
 */
export function liveSessionsPushLive(batch: RunEvent[]): void {
  let latest: LiveSessionRow[] | null = null;
  for (const frame of batch as unknown[]) {
    const parsed = liveSessionsOfFrame(frame);
    if (parsed !== null) latest = parsed;
  }
  if (latest === null) return;
  live = latest;
  generation += 1;
  emit();
}

/**
 * Reads the live set over REST. Silent on failure: the rail keeps whatever the
 * socket last said rather than blanking, because an unreachable poll is a fact
 * about the poll and not about what is running.
 */
export async function refreshLiveSessions(): Promise<void> {
  const asked = generation;
  try {
    const res = await doFetch(LIVE_URL);
    if (!res.ok) return;
    const parsed = liveSessionsOfBody(await res.json());
    // A push that landed while this request was out is NEWER than this answer.
    if (parsed === null || generation !== asked) return;
    live = parsed;
    emit();
  } catch {
    // Never break the rail over a probe.
  }
}

/**
 * Starts the poll under the push and answers with its stopper.
 *
 * @return a function that stops polling — call it when the page goes away
 */
export function startLiveSessionsPoll(): () => void {
  void refreshLiveSessions();
  const timer = setInterval(() => void refreshLiveSessions(), LIVE_POLL_MS);
  return () => clearInterval(timer);
}

function snapshot(): LiveSessionRow[] {
  return live;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** React binding: every session live on this server right now. */
export function useLiveSessions(): LiveSessionRow[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** The live set, for pure store tests (no React needed). */
export function __getLiveSessions(): LiveSessionRow[] {
  return live;
}

/** Subscribe without React, for pure store tests. */
export function __subscribeForTests(cb: () => void): () => void {
  return subscribe(cb);
}

/** Swap the fetch seam for a test double. */
export function __setTestHooks(hooks: { fetch?: typeof fetch }): void {
  if (hooks.fetch !== undefined) {
    doFetch = hooks.fetch;
  }
}

/** Reset all module state — call in beforeEach so tests never bleed. */
export function __resetForTests(): void {
  live = [];
  generation = 0;
  listeners.clear();
  doFetch = (...args) => fetch(...args);
}
