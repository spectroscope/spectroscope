// spectro-desktop/src/main.ts — the third face: an Electron shell that supervises the
// spectro-server JVM. The core never runs in Electron (there is no JVM here); the main
// process spawns "java -jar spectro-server.jar" as a child, health-checks it, and points a
// BrowserWindow at it. Transport stays WebSocket — the renderer (the stage-8 UI) opens it.
import { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, session, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { LAST_RUN_VERSION_FILE, lastRunVersionPayload, readLastRunVersion, shouldClearCache } from "./cacheRecovery";
import { appMenuTemplate, openAboutScript } from "./menu";

// Health budget: 30 s by default, overridable for slow environments (the CI
// xvfb smoke and emulated containers boot the JVM far slower than any laptop).
// Unset, the behavior is identical to the old constant.
const HEALTH_BUDGET_MS = Number(process.env.SPECTRO_HEALTH_BUDGET_MS ?? "") || 30_000; // total time we wait for the server to report healthy
const HEALTH_INTERVAL_MS = 500;  // gap between health polls
const JOBS_POLL_MS = 30_000;     // notification poller cadence
const KILL_GRACE_MS = 5_000;     // SIGTERM -> wait -> SIGKILL

// The name in the menu bar. Not app.name, which is the npm package name — see
// the note on appMenuTemplate for why that one is left alone.
const PRODUCT_NAME = "spectroscope";

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
// in dev it comes straight from the Gradle build (`./gradlew :spectro-server:bootJar`). The dev
// path GLOBS the boot jar so a version bump (0.1.0 -> 0.2.0 -> ...) never breaks it — bootJar
// writes spectro-server-<version>.jar (and a -plain.jar we must skip) into build/libs.
function resolveJarPath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, "spectro-server.jar");
  const libs = path.join(__dirname, "..", "..", "spectro-server", "build", "libs");
  // Newest by mtime, not by name: old versions linger in build/libs until a
  // `clean`, and a name sort would mis-rank 0.10 below 0.2. bootJar's freshest
  // output is always the one we want.
  const boot = fs
    .readdirSync(libs)
    .filter((f) => /^spectro-server-.*\.jar$/.test(f) && !f.endsWith("-plain.jar"))
    .map((f) => ({ f, m: fs.statSync(path.join(libs, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (boot.length === 0) {
    throw new Error(`no spectro-server boot jar in ${libs} — run ./gradlew :spectro-server:bootJar`);
  }
  return path.join(libs, boot[0].f);
}

// (b') Resolve the java binary: the packaged app bundles its OWN runtime (extraResources `jre`,
// jlink'd from the JDK), so a fresh machine needs no system Java — a true one-click run kit. In
// dev we fall through to whatever `java` is on the PATH.
function resolveJavaBin(): string {
  if (!app.isPackaged) return "java";
  return path.join(process.resourcesPath, "jre", "bin", "java");
}

// (b'') Resolve the bundled binaries dir: the packaged app carries llama.cpp's `llama-server`
// plus its dylib closure (extraResources `bin`), which is what lets the built-in model run with
// nothing else installed. Handed to the JVM as `spectro.bundle.bin`, the property the server's
// ServerLocalRuntime already reads. In dev there is no bundle and it falls back to the PATH.
function resolveBundledBinDir(): string | null {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, "bin");
  return fs.existsSync(path.join(dir, "llama-server")) ? dir : null;
}

// (b) Spawn the JVM. A missing java binary surfaces as ENOENT on the spawn — that must become
// a sentence, not a stack trace. Every startup failure kills the child before it can linger.
function spawnServer(port: number): ChildProcess {
  const jarPath = resolveJarPath();
  const binDir = resolveBundledBinDir();
  const args = [
    // Heap. This is the ONLY launch path we ship, so it is the one that decides how
    // much room a user's server actually gets. The JVM's own default is 25% of the
    // machine; a third is more room everywhere and still a share, so a 48 GiB
    // workstation gets 15.8 GiB while an 8 GiB laptop gets 2.6 rather than a fixed
    // number neither machine fits. Inside the deb and the AppImage it reads the
    // cgroup limit, not the host. The same number lives in spectro-serve and both
    // build files, and HeapFlagDriftTest holds all four to it.
    "-XX:MaxRAMPercentage=33",
    ...(binDir ? ["-Dspectro.bundle.bin=" + binDir] : []),
    "-jar",
    jarPath,
    "--server.port=" + port,
  ];
  const jvm = spawn(resolveJavaBin(), args);

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

  // Links leave for the real browser. Electron's default would open them in a
  // second BrowserWindow with no address bar and no back button, which is a
  // worse browser than the one the user already has — and the About panel is
  // mostly links: the repository, the two licences, the author.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
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

// Show the app's own About panel: the licence terms in full, in the theme the
// user is running, with the attribution line and its copy button. The native
// macOS panel stays available to nobody — it can only carry a version and a
// copyright line, and the thing worth reading here is the grant.
//
// The window may be closed (the tray keeps the app alive), so this opens one
// and waits for the page before dispatching. A menu item that silently did
// nothing on the first click would be the worst version of this feature.
function showAbout(): void {
  focusOrCreateWindow();
  const page = win?.webContents;
  if (!page) return;
  const dispatch = (): void => {
    void page.executeJavaScript(openAboutScript()).catch(() => {
      // The page is not the app (a load failure, an error page). There is
      // nothing honest to show here, and a native fallback would be a second
      // copy of the licence.
    });
  };
  if (page.isLoading()) page.once("did-finish-load", dispatch);
  else dispatch();
}

function createAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        productName: PRODUCT_NAME,
        isMac: process.platform === "darwin",
        onAbout: showAbout,
        onNewChat: () => {
          focusOrCreateWindow();
          win?.webContents.reload();
        },
      }),
    ),
  );
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

  // (f') Linux only: a terminating signal (kill, session logout, the CI xvfb
  // smoke) does NOT route through before-quit there — Chromium just dies, and
  // the JVM child would orphan with its scheduler still running. Translate the
  // signal into an ordinary quit so shutdown() reaps the server. Guarded to
  // linux so the darwin path is untouched by construction.
  if (process.platform === "linux") {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.on(sig, () => app.quit());
    }
  }
}

// (a') Cache recovery (card 130): Electron's HTTP cache lives in userData and
// survives app updates — which is exactly when the server's content-hashed
// asset names change. A shell cached before the server grew its Cache-Control
// headers can render a stale index.html whose assets 404 on the new jar: a
// blank window. Clear the HTTP cache ONCE per version change, before any
// window loads a URL; every run after that is covered by the headers.
function recoverFromStaleCache(): Promise<void> {
  const marker = path.join(app.getPath("userData"), LAST_RUN_VERSION_FILE);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(marker, "utf8");
  } catch {
    // no marker yet — a fresh install, or an upgrade from a build without one
  }
  if (!shouldClearCache(readLastRunVersion(raw), app.getVersion())) return Promise.resolve();
  return session.defaultSession
    .clearCache() // HTTP cache only — localStorage and the like stay untouched
    .catch(() => {
      // A failed clear leaves us no worse than before this feature existed;
      // the marker below is still written so the next version tries again.
    })
    .then(() => {
      try {
        fs.mkdirSync(app.getPath("userData"), { recursive: true });
        fs.writeFileSync(marker, lastRunVersionPayload(app.getVersion()));
      } catch {
        // best effort — an unwritable userData just re-clears next launch
      }
    });
}

async function startup(): Promise<void> {
  app.setAppUserModelId("dev.spectro.desktop"); // otherwise no notifications on Windows
  await recoverFromStaleCache(); // before any BrowserWindow exists to load a stale shell
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
