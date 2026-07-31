// The browser half of the log pane.
//
// The server log is the only log this product has, and it is blind to
// everything that never leaves the tab: the session import path is pure
// client work and does no fetch at all, so when it fails, nothing anywhere
// records it. This ring closes that gap WITHOUT a POST /api/client-log, which
// was designed and rejected for three independent reasons:
//
//   1. logback's pattern ends in %msg%n and substitutes verbatim — a newline
//      inside a client string forges a whole fake log line, timestamp and
//      severity included. That file is the evidence trail the product sells.
//   2. It is dead in its own failure mode: the browser errors that matter most
//      are "the server is down", so the POST goes nowhere.
//   3. The file appender rolls at 5 MB over 3 files and deletes the oldest — a
//      render loop throwing every frame would erase the server's own history.
//
// So the entries live here, in the tab, bounded, and the pane merges them into
// the view by time. Nothing is written, nothing is sent.
//
// Store shape follows the house pattern (disclosure.ts): a module-level value,
// a listener set, useSyncExternalStore over an immutable snapshot.

import { useSyncExternalStore } from "react";

export type BrowserLogLevel = "info" | "warn" | "error";

/** One recorded moment. Plain data — whatever is here is shown to the user. */
export interface BrowserLogEntry {
  /** Identity for keys; survives the dedupe collapse that rewrites an entry. */
  readonly seq: number;
  /** Wall clock in ms, forced non-decreasing so the merge order can trust it. */
  readonly at: number;
  readonly level: BrowserLogLevel;
  /** Short token naming the origin, e.g. "window", "promise", "import". */
  readonly source: string;
  readonly message: string;
  /** Redacted stack frames, when there were any. Absent means we had none. */
  readonly detail?: string;
  /** How often this entry repeated back to back. 1 for a single occurrence. */
  readonly count: number;
}

/**
 * Ring size. Three hundred entries is roughly 40 KB retained, which covers a
 * failed import plus everything that led to it, and stays cheap enough that
 * the pane can re-merge the whole ring on every 1.2 s tail poll.
 */
export const BROWSER_LOG_CAPACITY = 300;

/**
 * Hard ceiling on distinct entries per page load. The ring alone bounds
 * memory but not work: a loop throwing a NEW message every frame would churn
 * the ring, and each churn re-renders the pane. Past this many the module goes
 * quiet until the page reloads, which is also the only honest signal that
 * something is looping.
 */
export const BROWSER_LOG_MAX_ENTRIES = 1_000;

const MAX_MESSAGE_CHARS = 300;
const MAX_STACK_FRAMES = 6;
const MAX_DETAIL_CHARS = 1_200;

/** Anything that can carry the two global listeners; window in production. */
export interface BrowserLogTarget {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

let entries: readonly BrowserLogEntry[] = [];
let listeners = new Set<() => void>();
let seq = 0;
let accepted = 0;
let capped = false;
let lastAt = 0;
let busy = false;
let now: () => number = () => Date.now();

function publish(): void {
  for (const l of listeners) l();
}

/**
 * A clock that never steps backwards. Date.now() can jump (NTP, sleep), and a
 * ring whose timestamps go back in time would scramble the merge with the
 * server lines; the sequence matters more than the millisecond.
 */
function stamp(): number {
  const t = Math.max(now(), lastAt);
  lastAt = t;
  return t;
}

function push(entry: BrowserLogEntry): void {
  const next = [...entries, entry];
  entries = next.length > BROWSER_LOG_CAPACITY ? next.slice(next.length - BROWSER_LOG_CAPACITY) : next;
  publish();
}

function append(level: BrowserLogLevel, source: string, message: string, detail?: string): void {
  if (capped) return;

  const at = stamp();
  const tail = entries[entries.length - 1];
  // Back-to-back repeats collapse into a counter — the syslog "last message
  // repeated N times". A render loop must cost one entry, not the whole ring.
  if (
    tail !== undefined &&
    tail.level === level &&
    tail.source === source &&
    tail.message === message &&
    tail.detail === detail
  ) {
    entries = [...entries.slice(0, -1), { ...tail, at, count: tail.count + 1 }];
    publish();
    return;
  }

  seq += 1;
  push({ seq, at, level, source, message, count: 1, ...(detail !== undefined ? { detail } : {}) });

  accepted += 1;
  if (accepted >= BROWSER_LOG_MAX_ENTRIES) {
    capped = true;
    seq += 1;
    push({
      seq,
      at,
      level: "warn",
      source: "log",
      message: `browser log capped at ${BROWSER_LOG_MAX_ENTRIES} entries — reload to record more`,
      count: 1,
    });
  }
}

/**
 * Runs one entry-producing pass with re-entrancy and failure both contained.
 *
 * Everything here can be reached from inside a global error handler, reading
 * objects the page controls. Two rules follow: a nested report is dropped
 * rather than recursed into (a getter that throws while being logged would
 * otherwise loop forever), and a throw inside never escapes — a logger that
 * raises its own error event is a loop with extra steps.
 */
function guarded(run: () => void): void {
  if (busy) return;
  busy = true;
  try {
    run();
  } catch {
    /* the reporter must never become the thing that needs reporting */
  } finally {
    busy = false;
  }
}

/** Rewrites a home directory prefix to "~", on all three platforms' shapes. */
function redactHome(text: string): string {
  return text.replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)[^/\\\s:"')]+/g, "~");
}

function cap(text: string): string {
  const clean = redactHome(text);
  return clean.length > MAX_MESSAGE_CHARS ? `${clean.slice(0, MAX_MESSAGE_CHARS)}…` : clean;
}

function stackFrames(err: Error): string | undefined {
  const raw = err.stack;
  if (typeof raw !== "string" || raw === "") return undefined;
  const frames = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") || l.includes("@"));
  if (frames.length === 0) return undefined;
  return redactHome(frames.slice(0, MAX_STACK_FRAMES).join("\n")).slice(0, MAX_DETAIL_CHARS);
}

/**
 * Reduces an unknown thrown value to the two things worth showing: what kind
 * of error it was, and where it came from. Never the object itself — an error
 * from a fetch or a parser routinely carries the request, the body, a key.
 * When there is no readable message we say so rather than inventing one.
 */
function describeError(value: unknown): { message: string; detail?: string } {
  if (value instanceof Error) {
    const name = typeof value.name === "string" && value.name !== "" ? value.name : "Error";
    const message = typeof value.message === "string" ? value.message : "";
    const frames = stackFrames(value);
    return {
      message: cap(message === "" ? name : `${name}: ${message}`),
      ...(frames !== undefined ? { detail: frames } : {}),
    };
  }
  if (typeof value === "string") return { message: cap(value) };
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  return { message: `non-Error ${kind} thrown (no readable message)` };
}

/** Records a line the app knows about — the deliberate, already-safe path. */
export function logBrowser(level: BrowserLogLevel, source: string, message: string, detail?: string): void {
  guarded(() => append(level, source, cap(message), detail === undefined ? undefined : cap(detail)));
}

/** Records a caught throwable, reduced to name, capped message and frames. */
export function reportBrowserError(source: string, value: unknown): void {
  guarded(() => {
    const d = describeError(value);
    append("error", source, d.message, d.detail);
  });
}

function onErrorEvent(event: unknown): void {
  guarded(() => {
    const e = event as { error?: unknown; message?: unknown };
    if (e.error !== undefined && e.error !== null) {
      const d = describeError(e.error);
      append("error", "window", d.message, d.detail);
      return;
    }
    // filename/lineno/colno are deliberately dropped: the pane is meant to be
    // pasted into an issue, and on the desktop build those are local paths.
    const message = typeof e.message === "string" ? cap(e.message) : "uncaught error (no message)";
    append("error", "window", message);
  });
}

function onRejectionEvent(event: unknown): void {
  guarded(() => {
    const d = describeError((event as { reason?: unknown }).reason);
    append("error", "promise", d.message, d.detail);
  });
}

let teardown: (() => void) | null = null;

/**
 * Attaches the global handlers and returns the detach. Installing twice hands
 * back the first teardown instead of stacking listeners, so a remount cannot
 * double-record.
 *
 * @param target where to listen; defaults to window, absent in tests
 */
export function installBrowserLog(target?: BrowserLogTarget | null): () => void {
  if (teardown !== null) return teardown;
  const on = target ?? (typeof window === "undefined" ? null : (window as unknown as BrowserLogTarget));
  if (on === null) {
    const noop = (): void => {};
    teardown = noop;
    return noop;
  }
  on.addEventListener("error", onErrorEvent);
  on.addEventListener("unhandledrejection", onRejectionEvent);
  const off = (): void => {
    on.removeEventListener("error", onErrorEvent);
    on.removeEventListener("unhandledrejection", onRejectionEvent);
    if (teardown === off) teardown = null;
  };
  teardown = off;
  return off;
}

/** The current snapshot; a new array identity per accepted entry. */
export function browserLogEntries(): readonly BrowserLogEntry[] {
  return entries;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useBrowserLog(): readonly BrowserLogEntry[] {
  return useSyncExternalStore(subscribe, browserLogEntries, browserLogEntries);
}

/** Visible for tests: swap the clock. Pass null to restore the real one. */
export function __setTestHooks(hooks: { now?: () => number } | null): void {
  now = hooks?.now ?? (() => Date.now());
}

/** Visible for tests: empty the ring, release the cap, detach the handlers. */
export function __resetForTests(): void {
  teardown?.();
  teardown = null;
  entries = [];
  listeners = new Set();
  seq = 0;
  accepted = 0;
  capped = false;
  lastAt = 0;
  busy = false;
}
