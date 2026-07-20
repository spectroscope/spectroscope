// spectro-desktop/src/main.ts — the third face: an Electron shell that supervises the
// spectro-server JVM. The core never runs in Electron (there is no JVM here); the main
// process spawns "java -jar spectro-server.jar" as a child, health-checks it, and points a
// BrowserWindow at it. Transport stays WebSocket — the renderer (the stage-8 UI) opens it.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import * as path from "node:path";

const HEALTH_BUDGET_MS = 30_000; // total time we wait for the server to report healthy
const HEALTH_INTERVAL_MS = 500;  // gap between health polls
const JOBS_POLL_MS = 30_000;     // notification poller cadence
const KILL_GRACE_MS = 5_000;     // SIGTERM -> wait -> SIGKILL

// 16x16 diamond (Ebony #12120F) as an embedded PNG — no icon asset needed.
const TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQ0lEQVR42mNgoCUQEuL/D8IUaSbLEHTNJBmCSzNRhhDSjNcQYjVjNYRUzRiGUGwAxV6gSiBSJRqpkpCokpSpkpmIBQBoEYXhBCZorAAAAABJRU5ErkJggg==";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;         // hold the reference, otherwise the GC sweeps the icon away
let child: ChildProcess | null = null; // the managed JVM
let serverPort = 0;                    // the free port the OS handed us
let jobsPoller: NodeJS.Timeout | null = null;
let previousJobStates: Record<string, string> = {}; // last /api/jobs/state, for change detection

// (a) Free port: listen on port 0, read what the OS assigned, close the probe. There is a
// small race between closing the probe and Spring Boot binding the port — acceptable:
// the health probe below absorbs a lost race; know it exists, do not solve it.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(port));
    });
    probe.on("error", reject);
  });
}

// (b) Resolve the jar: packaged, it sits in the app resources (extraResources, package.json);
// in dev it comes straight from the Gradle build (`./gradlew :spectro-server:bootJar`). Keep
// the version in sync with the `version` in spectro-server/build.gradle.kts.
function resolveJarPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "spectro-server.jar")
    : path.join(__dirname, "..", "..", "spectro-server", "build", "libs", "spectro-server-0.0.1.jar");
}

// (b) Spawn the JVM. A missing java binary surfaces as ENOENT on the spawn — that must become
// a sentence, not a stack trace. Every startup failure kills the child before it can linger.
function spawnServer(port: number): ChildProcess {
  const jarPath = resolveJarPath();
  const jvm = spawn("java", ["-jar", jarPath, "--server.port=" + port]);

  jvm.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") {
      dialog.showErrorBox(
        "Java 21 is required",
        "spectroscope could not find a java executable on the PATH. Install a JRE 21 and start again.",
      );
    } else {
      dialog.showErrorBox("Could not start spectro-server", err.message);
    }
    app.quit();
  });

  // Surface the server log to the shell's console — useful when the jar is missing or crashes.
  jvm.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  jvm.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  return jvm;
}

// (c) Health poll: Spring Boot needs a moment. Poll GET /api/health until it answers 200,
// with a total budget of HEALTH_BUDGET_MS, then a clear error dialog. fetch is built into
// modern Node — no dependency needed.
async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return; // 200 -> the server is up
    } catch {
      // connection refused while the JVM is still starting — try again
    }
    await new Promise((r) => setTimeout(r, HEALTH_INTERVAL_MS));
  }
  throw new Error(`spectro-server did not become healthy within ${HEALTH_BUDGET_MS / 1000} s.`);
}

function createWindow(port: number): BrowserWindow {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    // The renderer is the stage-8 UI, served by Spring Boot. It is an ordinary web page and
    // talks to the server over WebSocket — the shell exposes no Node API to it.
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  void w.loadURL(`http://127.0.0.1:${port}`); // the stage-8 UI, WebSocket as always
  w.on("closed", () => { win = null; });
  return w;
}

// The tray keeps the app alive when the window is closed — so cron jobs keep running.
function focusOrCreateWindow(): void {
  if (!win || win.isDestroyed()) win = createWindow(serverPort);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// (d) Notification poller: every JOBS_POLL_MS, GET /api/jobs/state, diff against the previous
// poll, and raise a native Notification for every job whose status changed. Without change
// detection the shell would re-notify on every poll (the classic poller pitfall).
async function pollJobs(port: number): Promise<void> {
  let current: Record<string, { status?: string; sessionId?: string }>;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/state`);
    if (!response.ok) return;
    current = await response.json();
  } catch {
    return; // server not reachable this tick — try again next interval
  }
  for (const [id, state] of Object.entries(current)) {
    const status = state.status ?? "unknown";
    if (previousJobStates[id] !== status) {
      const n = new Notification({
        title: `Cron job "${id}" ${status}`,
        body: state.sessionId ? "Click to open the session." : status,
      });
      n.on("click", () => focusOrCreateWindow()); // clicking focuses the window
      n.show();
    }
  }
  previousJobStates = Object.fromEntries(
    Object.entries(current).map(([id, s]) => [id, s.status ?? "unknown"]),
  );
}

function jobsStatusText(): string {
  const entries = Object.entries(previousJobStates);
  if (entries.length === 0) return "No cron runs yet.";
  return entries.map(([id, status]) => `${id}: ${status}`).join("\n");
}

function createTray(): Tray {
  const t = new Tray(nativeImage.createFromDataURL(TRAY_ICON));
  t.setToolTip("spectroscope");
  t.setContextMenu(Menu.buildFromTemplate([
    { label: "New chat", click: () => { focusOrCreateWindow(); win?.webContents.reload(); } },
    { label: "Cron status", click: () => { void dialog.showMessageBox({ title: "Cron status", message: jobsStatusText() }); } },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]));
  return t;
}

function createAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
    { label: "File", submenu: [
      { label: "New chat", accelerator: "CmdOrCtrl+N", click: () => { focusOrCreateWindow(); win?.webContents.reload(); } },
      { role: "quit" },
    ] },
    { role: "editMenu" },
    { role: "viewMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// (e) Single-instance lock: a second launch focuses the first instance instead of starting a
// second JVM with a second scheduler on a second port.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit(); // a first instance already owns the lock — hand off to it below and exit
} else {
  app.on("second-instance", () => focusOrCreateWindow());

  void app.whenReady().then(startup);

  // Closing the window does NOT quit the app: the tray keeps shell and server alive so cron
  // jobs keep running. The handler stays deliberately empty (all platforms).
  app.on("window-all-closed", () => {});

  // (f) Clean shutdown: SIGTERM first — Spring Boot shuts down gracefully, closing sockets and
  // finishing the current JSONL line — then a SIGKILL escalation after KILL_GRACE_MS if the
  // process is still alive. On Windows there are no POSIX signals: kill terminates hard. Fine
  // here (platform difference).
  app.on("before-quit", shutdown);
}

async function startup(): Promise<void> {
  app.setAppUserModelId("dev.spectro.desktop"); // otherwise no notifications on Windows
  createAppMenu();
  tray = createTray();

  serverPort = await findFreePort();
  child = spawnServer(serverPort);
  try {
    await waitForHealth(serverPort); // block until 200, or throw on timeout
  } catch (err) {
    shutdown();                       // never leave a headless JVM behind on a startup failure
    dialog.showErrorBox("spectro-server did not start", (err as Error).message);
    app.quit();
    return;
  }

  win = createWindow(serverPort);
  jobsPoller = setInterval(() => void pollJobs(serverPort), JOBS_POLL_MS);

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) focusOrCreateWindow(); });
}

function shutdown(): void {
  if (jobsPoller) { clearInterval(jobsPoller); jobsPoller = null; }
  const jvm = child;
  child = null;
  if (!jvm || jvm.exitCode !== null) return; // already gone
  jvm.kill("SIGTERM"); // graceful; Spring Boot catches it
  setTimeout(() => {
    if (jvm.exitCode === null) jvm.kill("SIGKILL"); // still alive after the grace period
  }, KILL_GRACE_MS).unref();
}
