// The control channel: the main process opens a WebSocket BACK to the server.
//
// Direction matters and card 200 section 9.3 left it open; this is the answer.
// The alternative — a preload script plus ipcMain — is more conventional and
// weakens a stance the shell already holds: navigationGuard.ts names "no preload
// script at all" as a security property, not an omission. A main-process client
// keeps that property, needs no new surface in the renderer, and leaves the
// server the one that knows when a browser is attached.
//
// No dependency: Electron 43's main process is Node 24 and carries a global
// WebSocket (measured 2026-08-13 — electron 43.3.0, node 24.18.1).
//
// It reconnects. The JVM restarts under the shell (the Restart server menu item
// does exactly that), and a browser that stayed dead after a restart would be a
// feature the operator has to know to re-trigger.

import { runVerb, paneAttached, paneUrl, type PaneSettings } from "./browserPane";

const RECONNECT_MS = 2_000;

let socket: WebSocket | null = null;
let retry: NodeJS.Timeout | null = null;
let wanted = false;

/**
 * One command as the server sends it.
 *
 * `sessionId` arrived with card 218: every browser here belongs to a session, so
 * a command that names none cannot be served. It rides beside `args` rather than
 * inside them because it is not one verb's argument — it is who is asking, and
 * it is the SERVER's answer, never the model's (the tools have no way to name a
 * session, which is why browser_* still refuses tab_id).
 */
interface Command {
  id: string;
  verb: string;
  sessionId?: string | null;
  args?: Record<string, unknown>;
  settings?: PaneSettings;
}

/**
 * Opens (and keeps open) the control channel to the server.
 *
 * @param port the port the JVM is on — the same one the window loads from
 */
export function connectBrowserControl(port: number): void {
  wanted = true;
  open(port);
}

/** Closes the channel and stops reconnecting — used on shutdown. */
export function disconnectBrowserControl(): void {
  wanted = false;
  if (retry) {
    clearTimeout(retry);
    retry = null;
  }
  socket?.close();
  socket = null;
}

function open(port: number): void {
  if (!wanted) return;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws/browser`);
  } catch {
    schedule(port);
    return;
  }
  socket.addEventListener("open", () => {
    // The hello tells the server a browser exists at all, which is what makes
    // BrowserFace.attached() true and every tool stop answering "no pane".
    socket?.send(JSON.stringify({ hello: "spectro-desktop", attached: paneAttached() }));
  });
  socket.addEventListener("message", (event) => {
    void handle(String(event.data));
  });
  socket.addEventListener("close", () => schedule(port));
  socket.addEventListener("error", () => {
    // The close handler schedules the retry; an error alone must not schedule a
    // second one, or a refused connection doubles the retry rate every attempt.
  });
}

function schedule(port: number): void {
  if (!wanted || retry) return;
  retry = setTimeout(() => {
    retry = null;
    open(port);
  }, RECONNECT_MS);
  retry.unref?.();
}

async function handle(raw: string): Promise<void> {
  let command: Command;
  try {
    command = JSON.parse(raw) as Command;
  } catch {
    return; // the server speaks JSON; anything else is not ours to answer
  }
  if (!command.id || !command.verb) return;
  const settings: PaneSettings = command.settings ?? { allowLocalhost: false, adblock: true };
  const sessionId = typeof command.sessionId === "string" && command.sessionId
    ? command.sessionId
    : null;
  let reply;
  try {
    reply = await runVerb(command.verb, command.args ?? {}, settings, sessionId);
  } catch (error) {
    // runVerb already catches; this is the belt for anything that escapes it,
    // because a command with no reply is an agent that waits forever.
    reply = { ok: false, error: (error as Error).message, pageUrl: paneUrl(sessionId) };
  }
  socket?.send(JSON.stringify({ id: command.id, ...reply }));
}
