// WebSocket transport: one connection, rAF batching, auto-reconnect.
//
// - rAF batching: text_delta arrives as a flood; events are buffered and handed
//   to the app as ONE batch per animation frame, so React renders once per
//   frame instead of once per delta.
// - Auto-reconnect: exponential backoff (1s .. 15s). The app is told about
//   every status change so it can show the connection banner with a countdown.
// - Same-origin URLs: the Vite dev server proxies /api and /ws to :8080; in
//   production one Spring Boot jar serves UI, REST and socket on one port.

import type { ClientMessage, RunEvent } from "../events";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface Connection {
  /** Returns false when the socket is not open (the frame is dropped). */
  send(msg: ClientMessage): boolean;
  /** Skip the backoff countdown and retry immediately. */
  reconnectNow(): void;
  /** Dispose the connection for good — no further retries. */
  close(): void;
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
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 15000;

function defaultUrl(): string {
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}/ws`;
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

export function connect(options: ConnectOptions): Connection {
  const base = options.url ?? defaultUrl();
  const url =
    options.resume !== undefined
      ? `${base}${base.includes("?") ? "&" : "?"}resume=${encodeURIComponent(options.resume)}`
      : base;

  let socket: WebSocket | null = null;
  let disposed = false;
  let attempts = 0;
  let retryTimer: number | null = null;

  // rAF buffer against the text_delta flood.
  let buffer: RunEvent[] = [];
  let frame: number | null = null;
  const flush = (): void => {
    frame = null;
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    options.onEvents(batch);
  };

  const clearRetry = (): void => {
    if (retryTimer !== null) {
      window.clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const open = (): void => {
    if (disposed) return;
    options.onStatus?.("connecting");
    socket = new WebSocket(url);

    socket.onopen = () => {
      attempts = 0;
      options.onStatus?.("open");
    };
    socket.onmessage = (msg: MessageEvent) => {
      const event = parseEvent(msg.data);
      if (event === null) return;
      buffer.push(event);
      if (frame === null) frame = window.requestAnimationFrame(flush);
    };
    socket.onclose = () => {
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      flush(); // apply whatever is left in the buffer
      if (disposed) return;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempts, RETRY_MAX_MS);
      attempts += 1;
      options.onStatus?.("closed", delay);
      retryTimer = window.setTimeout(open, delay);
    };
  };

  open();

  return {
    send(msg: ClientMessage): boolean {
      if (socket !== null && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    reconnectNow(): void {
      if (disposed) return;
      if (
        socket !== null &&
        (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
      ) {
        return; // already live or on its way
      }
      clearRetry();
      attempts = 0;
      open();
    },
    close(): void {
      disposed = true;
      clearRetry();
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
        frame = null;
      }
      socket?.close();
    },
  };
}
