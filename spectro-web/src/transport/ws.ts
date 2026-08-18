// WebSocket transport: one connection, batched folds, auto-reconnect.
//
// - Batching: text_delta arrives as a flood; events are buffered and handed to
//   the app as ONE batch per fold. The fold trigger lives in flushPump.ts and
//   is deliberately not the animation frame alone — see the reasoning there.
// - Liveness: a socket whose peer vanished without a FIN stays OPEN forever and
//   delivers nothing. liveness.ts decides when to ask and when to give up.
// - Auto-reconnect: exponential backoff (1s .. 15s). The app is told about
//   every status change so it can show the connection banner with a countdown.
// - Same-origin URLs: the Vite dev server proxies /api and /ws to :8080; in
//   production one Spring Boot jar serves UI, REST and socket on one port.
//
// Everything the browser provides is reached through TransportHost, so the two
// clocks and the socket itself can be driven by hand in a test. This suite has
// no jsdom, and a transport that could only be checked by a human watching a
// window would be exactly the defect this file was fixed for.

import type { ClientMessage, RunEvent } from "../events";
import { createFlushPump, type PumpHost } from "./flushPump";
import {
  freshLiveness,
  livenessTick,
  LIVENESS_TICK_MS,
  noteInbound,
  PROBE_ANSWER_TYPE,
  PROBE_FRAME,
  type LivenessState,
} from "./liveness";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Connection {
  /** Returns false when the socket is not open (the frame is dropped). */
  send(msg: ClientMessage): boolean;
  /** Skip the backoff countdown and retry immediately. */
  reconnectNow(): void;
  /** Dispose the connection for good — no further retries. */
  close(): void;
}

/** One socket, in the only shape this file uses. */
export interface TransportSocket {
  /** True while a frame would actually leave — WebSocket.OPEN. */
  isOpen(): boolean;
  send(text: string): void;
  close(): void;
  onopen: (() => void) | null;
  /** Handed the frame's payload, unparsed. */
  onmessage: ((data: unknown) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
}

/** Everything outside this module: two clocks, a wall clock and a socket. */
export interface TransportHost extends PumpHost {
  now(): number;
  openSocket(url: string): TransportSocket;
}

export interface ConnectOptions {
  onEvents: (batch: RunEvent[]) => void;
  onStatus?: (status: ConnectionStatus, retryDelayMs?: number) => void;
  /** Override for tests; defaults to same-origin /ws. */
  url?: string;
  /** Reopen a stored session: the server reloads its JSONL history into the
   *  agent and appends new events to the SAME file (?resume=<id>). Auto-
   *  reconnects keep the parameter, so a dropped socket resumes seamlessly. */
  resume?: string;
  /** Override for tests; defaults to the browser's own clocks and WebSocket. */
  host?: TransportHost;
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
}

/** The browser's own clocks and socket, adapted to the shapes above. */
export function browserHost(): TransportHost {
  return {
    requestFrame: (run) => window.requestAnimationFrame(run),
    cancelFrame: (handle) => window.cancelAnimationFrame(handle),
    setTimer: (run, ms) => window.setTimeout(run, ms),
    clearTimer: (handle) => window.clearTimeout(handle),
    now: () => Date.now(),
    openSocket(url: string): TransportSocket {
      const raw = new WebSocket(url);
      const socket: TransportSocket = {
        isOpen: () => raw.readyState === WebSocket.OPEN,
        send: (text) => raw.send(text),
        close: () => raw.close(),
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
      };
      raw.onopen = () => socket.onopen?.();
      raw.onmessage = (msg: MessageEvent) => socket.onmessage?.(msg.data);
      raw.onclose = () => socket.onclose?.();
      raw.onerror = () => socket.onerror?.();
      return socket;
    },
  };
}

/** Boundary parse: anything that is JSON with a string `type` enters the app
 *  as a RunEvent; unknown types fall through the reducer's default (forward
 *  compatibility). Malformed frames are dropped. */
function parseEvent(data: unknown): RunEvent | null {
  if (typeof data !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as RunEvent;
    }
  } catch {
    // not JSON — drop the frame
  }
  return null;
}

/**
 * The session id a frame names, if it names one.
 *
 * Only `workspace_info` carries it (SessionConnection#sendWorkspaceInfo), and
 * it is sent once per connection as soon as the store is minted — which is the
 * moment there is a record for a reconnect to go back to.
 *
 * @param frame one inbound frame, already parsed
 * @return the session id, or null when the frame does not name one
 */
export function sessionIdOf(frame: unknown): string | null {
  const named = frame as { type?: unknown; sessionId?: unknown };
  if (named.type !== "workspace_info") return null;
  return typeof named.sessionId === "string" && named.sessionId !== "" ? named.sessionId : null;
}

/** True for the refusal that means: stop asking for that session (card 212). */
export function isSessionBusy(frame: unknown): boolean {
  return (frame as { type?: unknown }).type === "session_busy";
}

/**
 * The answer a server built before the probe existed gives it.
 *
 * SpectroSocketHandler's default arm is {@code sendError("Unknown message
 * type.")}, and sendError is a first-class RunEvent there: it goes through
 * send() and is APPENDED to the session's JSONL. So a page carrying this
 * transport, talking to an older dev server or an older desktop jar, would
 * write one error row into the operator's chat AND into his record every
 * fifteen seconds of idling. The client is the new half here, so the client
 * is what has to notice and stop.
 *
 * @param frame one inbound frame, already parsed
 * @return true when this is that refusal
 */
export function isUnknownTypeError(frame: unknown): boolean {
  const named = frame as { type?: unknown; message?: unknown };
  return named.type === "error" && named.message === "Unknown message type.";
}

export function connect(options: ConnectOptions): Connection {
  const host = options.host ?? browserHost();
  const base = options.url ?? defaultUrl();

  // WHICH session a reconnect goes back to. It starts as what the app asked
  // for and is then latched off the wire: a page that opened a FRESH session
  // and lost its socket used to come back as a different session entirely,
  // feeding a second run's frames into the first run's view while the first
  // run's file kept growing on disk. The record is the anchor, so the socket
  // goes back to it.
  let resumeTarget: string | null = options.resume ?? null;
  const currentUrl = (): string =>
    resumeTarget !== null
      ? `${base}${base.includes("?") ? "&" : "?"}resume=${encodeURIComponent(resumeTarget)}`
      : base;

  let socket: TransportSocket | null = null;
  let phase: "connecting" | "open" | "down" = "down";
  let live: LivenessState = freshLiveness(host.now());
  // Per socket: whether the peer on the other end understands being asked.
  // An older server answers the probe with an error it also writes to disk.
  let probesUnderstood = true;
  let tickTimer: number | null = null;
  let disposed = false;
  let attempts = 0;
  let retryTimer: number | null = null;

  // The buffer against the text_delta flood; the pump decides when it folds.
  let buffer: RunEvent[] = [];
  const flush = (): void => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    options.onEvents(batch);
  };
  const pump = createFlushPump(host, flush);

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      host.clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  /**
   * One socket's death, from whichever of the three ways it reached us: the
   * close event, the error event, or the liveness watch giving up. All three
   * land here exactly once per socket — the handlers are detached first, so
   * the close that a browser fires behind an error cannot buy a second retry.
   */
  const retire = (): void => {
    const dying = socket;
    if (dying === null) return;
    dying.onopen = null;
    dying.onmessage = null;
    dying.onclose = null;
    dying.onerror = null;
    socket = null;
    phase = "down";
    pump.cancel();
    flush(); // apply whatever is left in the buffer — the tail is not lost
    dying.close();
    if (disposed) return;
    const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
    attempts += 1;
    // The chip changes BEFORE the retry, never after it: a socket that has
    // stopped delivering may not keep reading "connected" for a whole backoff.
    options.onStatus?.("closed", delay);
    retryTimer = host.setTimer(open, delay);
  };

  const onTick = (): void => {
    tickTimer = null;
    if (disposed) return;
    if (phase === "open" && socket !== null) {
      if (!probesUnderstood) {
        // This peer cannot be asked. The watch is kept fresh rather than run,
        // which leaves the socket exactly as the transport treated it before
        // card 261: it reconnects from onclose and from nothing else. Half a
        // fix beats writing an error into the operator's record every tick.
        live = freshLiveness(host.now());
      } else {
        const step = livenessTick(live, host.now());
        live = step.state;
        if (step.action === "probe") {
          socket.send(PROBE_FRAME);
        } else if (step.action === "drop") {
          retire();
        }
      }
    }
    tickTimer = host.setTimer(onTick, LIVENESS_TICK_MS);
  };

  const open = (): void => {
    if (disposed) return;
    phase = "connecting";
    options.onStatus?.("connecting");
    live = freshLiveness(host.now());
    probesUnderstood = true; // a fresh socket may reach a newer server
    socket = host.openSocket(currentUrl());

    socket.onopen = () => {
      attempts = 0;
      phase = "open";
      live = freshLiveness(host.now());
      options.onStatus?.("open");
    };
    socket.onmessage = (data: unknown) => {
      const asked = live.probeSentAt !== null; // read BEFORE the watch resets
      // ANY frame is proof the socket still delivers — including the probe's
      // own answer, which is why this comes before the parse decides anything.
      live = noteInbound(live, host.now());
      const event = parseEvent(data);
      if (event === null) return;
      // The answer to a probe is transport bookkeeping, not news for the app.
      if ((event as { type: string }).type === PROBE_ANSWER_TYPE) return;
      // …and so is an older server's refusal of the question. Only while a
      // probe is outstanding: the same text with nothing asked is the agent's
      // own error and belongs on the operator's screen. A false positive here
      // costs one socket its watch, never a frame the operator needed.
      if (asked && isUnknownTypeError(event)) {
        probesUnderstood = false;
        return;
      }
      const named = sessionIdOf(event);
      if (named !== null) resumeTarget = named;
      if (isSessionBusy(event)) resumeTarget = null;
      buffer.push(event);
      pump.schedule();
    };
    socket.onclose = retire;
    socket.onerror = retire;
  };

  open();
  tickTimer = host.setTimer(onTick, LIVENESS_TICK_MS);

  return {
    send(msg: ClientMessage): boolean {
      if (socket !== null && socket.isOpen()) {
        socket.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    reconnectNow(): void {
      if (disposed) return;
      if (phase !== "down") {
        return; // already live or on its way
      }
      clearRetry();
      attempts = 0;
      open();
    },
    close(): void {
      disposed = true;
      clearRetry();
      if (tickTimer !== null) {
        host.clearTimer(tickTimer);
        tickTimer = null;
      }
      pump.cancel();
      const dying = socket;
      socket = null;
      phase = "down";
      dying?.close();
    },
  };
}
