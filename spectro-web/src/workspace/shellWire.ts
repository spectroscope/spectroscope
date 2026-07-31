// The client half of the shell wire (card 93). Binary in both directions; this
// module is the only place that knows the byte layout, so the renderer never
// hand-rolls a frame and the tests can check the bytes without a socket.
//
//   up:   0x00 | utf-8 bytes                keystrokes
//         0x01 | rows u16 BE | cols u16 BE  resize
//   down: binary frame                      raw terminal bytes, handed to the VT
//         text frame                        one JSON status notice
//
// A text frame sent UP closes the socket, so nothing here ever sends a string.

/** Opcode for keystrokes. */
export const SHELL_OP_DATA = 0x00;
/** Opcode for a window change. */
export const SHELL_OP_RESIZE = 0x01;

/** Payload cap per frame; the server rejects a larger one by closing the socket. */
export const SHELL_MAX_DATA = 64 * 1024;
/** Window bounds, mirrored from the server so a resize is never refused. */
export const SHELL_MAX_ROWS = 1000;
export const SHELL_MAX_COLS = 1000;

const encoder = new TextEncoder();

/**
 * Frame keystrokes for the wire. Returns a list because a paste can exceed the
 * server's per-frame cap, and one oversized frame would not be truncated — it
 * would close the shell. Splitting mid-codepoint is safe: the far end is a byte
 * pipe, not a decoder.
 */
export function encodeKeys(text: string): Uint8Array[] {
  return encodeKeyBytes(encoder.encode(text));
}

/**
 * Frame keystrokes that are already bytes — xterm's `onBinary` reports 8-bit
 * values, and re-encoding those as text would widen every byte over 0x7f.
 */
export function encodeKeyBytes(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 0) return [];
  const frames: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += SHELL_MAX_DATA) {
    const slice = bytes.subarray(at, at + SHELL_MAX_DATA);
    const frame = new Uint8Array(slice.length + 1);
    frame[0] = SHELL_OP_DATA;
    frame.set(slice, 1);
    frames.push(frame);
  }
  return frames;
}

/** Clamp a measured dimension into the range the server clamps to. */
function clamp(value: number, max: number): number {
  const whole = Math.round(value);
  if (!Number.isFinite(whole)) return 1;
  return Math.max(1, Math.min(max, whole));
}

/**
 * Frame a window change. Measurements arrive fractional from the DOM, so they
 * are rounded here rather than truncated by the byte writes.
 */
export function encodeResize(rows: number, cols: number): Uint8Array {
  const r = clamp(rows, SHELL_MAX_ROWS);
  const c = clamp(cols, SHELL_MAX_COLS);
  return new Uint8Array([SHELL_OP_RESIZE, r >> 8, r & 0xff, c >> 8, c & 0xff]);
}

/** The three notices the server sends as text frames. */
export type ShellStatus =
  | { type: "shell_ready"; cwd: string; shell: string; rows: number; cols: number; note: string }
  | { type: "shell_exit"; code: number }
  | { type: "shell_error" };

/**
 * Parse one status frame. Anything unrecognised is null rather than an
 * exception: a status frame arrives on a socket callback, where a throw would
 * take down the pane instead of the message.
 */
export function decodeStatus(text: string): ShellStatus | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  switch (body.type) {
    case "shell_ready":
      return {
        type: "shell_ready",
        cwd: str(body.cwd),
        shell: str(body.shell),
        rows: num(body.rows),
        cols: num(body.cols),
        note: str(body.note),
      };
    case "shell_exit":
      return { type: "shell_exit", code: num(body.code) };
    case "shell_error":
      return { type: "shell_error" };
    default:
      return null;
  }
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Just enough of `window.location` to build the URL, so this stays testable. */
export interface UrlOrigin {
  protocol: string;
  host: string;
}

/**
 * The endpoint for one terminal. The initial window rides in the query so the
 * PTY spawns at the right size and the first prompt is never drawn at 80x24 and
 * reflowed; the session id is escaped because it ends up in a query the server
 * splits by hand.
 */
export function shellSocketUrl(
  sessionId: string | undefined,
  rows: number,
  cols: number,
  origin: UrlOrigin,
): string {
  const scheme = origin.protocol === "https:" ? "wss:" : "ws:";
  const params = [
    ...(sessionId === undefined ? [] : [`session=${encodeURIComponent(sessionId)}`]),
    `rows=${clamp(rows, SHELL_MAX_ROWS)}`,
    `cols=${clamp(cols, SHELL_MAX_COLS)}`,
  ];
  return `${scheme}//${origin.host}/ws/shell?${params.join("&")}`;
}
