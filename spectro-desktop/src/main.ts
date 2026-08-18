// spectro-desktop/src/main.ts — the third face: an Electron shell that supervises the
// spectro-server JVM. The core never runs in Electron (there is no JVM here); the main
// process spawns "java -jar spectro-server.jar" as a child, health-checks it, and points a
// BrowserWindow at it. Transport stays WebSocket — the renderer (the stage-8 UI) opens it.
import { app, BrowserWindow, Menu, Notification, Tray, clipboard, dialog, nativeImage, session, shell } from "electron";
import { allowsNavigation } from "./navigationGuard";
import { attachPaneTo, forgetPane, relayoutPane, wirePaneLifecycle } from "./browserPane";
import { connectBrowserControl, disconnectBrowserControl } from "./browserControl";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { LAST_RUN_VERSION_FILE, lastRunVersionPayload, readLastRunVersion, shouldClearCache } from "./cacheRecovery";
import { SERVER_PORT_FILE, readRememberedPort, rememberedPortPayload, shouldPersistPort } from "./portMemory";
import { appMenuTemplate, openAboutScript, toTemplate, type Handlers } from "./menu";
import { trayMenuModel, traySummary, trayTooltip, type ShellAction, type TrayStatus } from "./menuModel";
import { shellCommandScript, type ShellCommandId } from "./shellCommands";

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

/** The marker this shell puts on its own window's user agent (card 201).
 *  Mirrored in spectro-web/src/browser/viewport.ts. */
const DESKTOP_MARKER = "spectroscope-desktop/";

// Isolated-profile seam: dev `electron .` and the packaged app resolve the SAME
// userData ("spectro-desktop" — electron-builder's productName lives in its
// build config, not in the runtime app.name), so a dev launch beside the
// installed app hands off to it through the Chromium singleton and silently
// quits. Pointing this at a scratch directory gives a hermetic profile — own
// singleton, own localStorage, own port marker. Packaged builds never set it.
// Must run before the single-instance lock below, which binds to userData.
const userDataOverride = process.env.SPECTRO_DESKTOP_USERDATA;
if (userDataOverride) app.setPath("userData", userDataOverride);

// 16x16 diamond (Ebony #12120F) as an embedded PNG — no icon asset needed.
const TRAY_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAQ0lEQVR42mNgoCUQEuL/D8IUaSbLEHTNJBmCSzNRhhDSjNcQYjVjNYRUzRiGUGwAxV6gSiBSJRqpkpCokpSpkpmIBQBoEYXhBCZorAAAAABJRU5ErkJggg==";

let win: BrowserWindow | null = null;
let tray: Tray | null = null;         // hold the reference, otherwise the GC sweeps the icon away
let child: ChildProcess | null = null; // the managed JVM
let serverPort = 0;                    // the port the server is on (remembered across launches, card 168)
let jobsPoller: NodeJS.Timeout | null = null;
let previousJobStates: Record<string, string> = {}; // last /api/jobs/state, for change detection
// Whether the last pollJobs fetch RESOLVED — free, because the poller already
// runs every 30 s and already catches connection failure. It is the only thing
// this shell honestly knows about the server's liveness between health checks.
let serverUp = true;
let lastTraySummary = "";      // rebuild guard: mutating a MenuItem label shows nothing
let restarting = false;        // single-flight, so a second click cannot double-spawn a JVM

// (a) The server port, with memory (card 168): localStorage is origin-bound, so a fresh
// OS-assigned port on every launch ran the web app on a new localhost origin with an
// EMPTY localStorage — every spectroscope:* preference (design, language, disclosure
// level, the built-in-model notice's dismissal) silently reset on each desktop start.
// Try the port that served last launch first; only when that bind fails (another
// process took it) fall back to a fresh free port — one origin change, then stable
// again. The small race between closing the probe and Spring Boot binding the port is
// unchanged: the health probe below absorbs a lost race; know it exists, do not solve it.
function probePort(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject); // EADDRINUSE lands here — the caller decides the fallback
    probe.listen(port, "127.0.0.1", () => {
      const assigned = (probe.address() as net.AddressInfo).port;
      probe.close(() => resolve(assigned));
    });
  });
}

async function resolveServerPort(): Promise<number> {
  const marker = path.join(app.getPath("userData"), SERVER_PORT_FILE);
  let raw: string | null = null;
  try {
    raw = fs.readFileSync(marker, "utf8");
  } catch {
    // no marker yet — the first launch with port memory, or a wiped userData
  }
  const remembered = readRememberedPort(raw);
  let port: number;
  if (remembered === null) {
    port = await probePort(0);
  } else {
    try {
      port = await probePort(remembered);
    } catch {
      port = await probePort(0); // remembered port taken — fresh origin once, then stable
    }
  }
  if (shouldPersistPort(remembered, port)) {
    try {
      fs.mkdirSync(app.getPath("userData"), { recursive: true });
      fs.writeFileSync(marker, rememberedPortPayload(port));
    } catch {
      // best effort — an unwritable userData just means a fresh port next launch
    }
  }
  return port;
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

function createWindow(port: number, hash?: string): BrowserWindow {
  const w = new BrowserWindow({
    width: 1200,
    height: 800,
    // The renderer is the stage-8 UI, served by Spring Boot. It is an ordinary web page and
    // talks to the server over WebSocket — the shell exposes no Node API to it.
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Card 261. The transport folds its event buffer on an animation frame
      // OR a 250 ms timer, whichever comes first, so a window nobody is looking
      // at still gets its batches. Chromium's default throttling would clamp
      // that timer to a second in a hidden window and to about a minute after
      // five minutes hidden — which turns the floor into a ceiling on exactly
      // the machine this was fixed for. browserPane.ts turns it off for the
      // session pane for the same reason; this is the window with the live run
      // in it. The cost is battery on a minimised window; the alternative is
      // the operator coming back to a view that is minutes behind his own
      // session file.
      backgroundThrottling: false,
    },
  });

  // Card 201: stamp this window so the page can tell it apart from any OTHER
  // browser pointed at the same server. The browser segment is a hole with a
  // native pane laid over it, and only THIS window has the pane — a second
  // reader must neither be shown a green dot over an empty frame nor be allowed
  // to drag the overlay to match their own window. Reading "Electron/" is not
  // enough: the browser this was verified in is itself an Electron app.
  // Mirrored in spectro-web/src/browser/viewport.ts; a drift test holds them equal.
  w.webContents.setUserAgent(`${w.webContents.getUserAgent()} ${DESKTOP_MARKER}${app.getVersion()}`);

  // Links leave for the real browser. Electron's default would open them in a
  // second BrowserWindow with no address bar and no back button, which is a
  // worse browser than the one the user already has — and the About panel is
  // mostly links: the repository, the two licences, the author.
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // The seatbelt setWindowOpenHandler does not wear (card 150). That handler
  // covers window.open and target=_blank; a same-window navigation walks past
  // it. Nothing in this app can reach one today, which is exactly when a guard
  // is cheap to add — and this window has no address bar to notice a wrong page
  // by. The decision is pure and lives in navigationGuard.ts so it can be
  // tested without Electron.
  const home = `http://127.0.0.1:${port}`;
  w.webContents.on("will-navigate", (event, url) => {
    if (!allowsNavigation(home, url)) {
      event.preventDefault();
      // Anything http(s) still reaches the user, just in the browser they
      // already have — the same destination setWindowOpenHandler gives it.
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    }
  });
  // A redirect is a navigation the page did not spell out, so it gets the same
  // answer. Electron fires this one separately.
  w.webContents.on("will-redirect", (event, url) => {
    if (!allowsNavigation(home, url)) event.preventDefault();
  });

  // A hash the menu asked for goes on the URL the window is BORN with. The
  // same `home` string the guard above was configured with, so this is the
  // allow case navigationGuard.test.ts already pins, not a new origin.
  // The browser pane (card 201) is an overlay in this window's own content
  // coordinates, so it has to follow the window rather than be told to.
  w.on("resize", relayoutPane);
  w.on("enter-full-screen", relayoutPane);
  w.on("leave-full-screen", relayoutPane);
  // Card 241: a real navigation of the app page (a reload is one) hides every
  // pane — the fresh page mounts no reporter, so nothing else could ever send
  // the visible:false that takes a stranded native page off the window.
  wirePaneLifecycle(w.webContents);

  void w.loadURL(home + (hash ?? "")); // the stage-8 UI, WebSocket as always
  w.on("closed", () => { win = null; forgetPane(); });
  return w;
}

// The tray keeps the app alive when the window is closed — so cron jobs keep running.
function focusOrCreateWindow(hash?: string): void {
  if (!win || win.isDestroyed()) win = createWindow(serverPort, hash);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

/**
 * Run a script in the page, opening the window first if it is closed.
 *
 * The generalisation of what showAbout() has done since v0.4: the window may
 * be gone (the tray keeps the app alive), so this creates one and waits for
 * the load before dispatching. A menu item that silently did nothing on the
 * first click would be the worst version of this feature.
 */
function runInPage(script: string): void {
  focusOrCreateWindow();
  const page = win?.webContents;
  if (!page) return;
  const dispatch = (): void => {
    void page.executeJavaScript(script).catch(() => {
      // The page is not the app (a load failure, an error page). There is
      // nothing honest to do here.
    });
  };
  if (page.isLoading()) page.once("did-finish-load", dispatch);
  else dispatch();
}

/**
 * Send a command from a menu item into the page.
 *
 * The page holds commands that arrive before React mounts (the module-scope
 * buffer in spectro-web's shellCommands.ts), so a freshly created window gets
 * the command it was created for rather than dropping it.
 */
function sendCommand(id: ShellCommandId, arg?: string): void {
  runInPage(shellCommandScript(id, arg));
}

/**
 * Move the window to an address.
 *
 * Branching matters: assigning `location.hash` on a page that has not yet
 * attached its hashchange listener is a silent no-op, and did-finish-load
 * fires before React mounts. So a window that does not exist is created with
 * the hash already on its URL, and only a living one is assigned to.
 */
function gotoHash(hash: string): void {
  if (!win || win.isDestroyed()) {
    focusOrCreateWindow(hash);
    return;
  }
  focusOrCreateWindow();
  // A same-document hash change does not fire will-navigate at all, so the
  // seatbelt is not involved and does not need to be.
  runInPage(`location.hash = ${JSON.stringify(hash)}`);
}

// (d) Notification poller: every JOBS_POLL_MS, GET /api/jobs/state, diff against the previous
// poll, and raise a native Notification for every job whose status changed. Without change
// detection the shell would re-notify on every poll (the classic poller pitfall).
async function pollJobs(port: number): Promise<void> {
  let current: Record<string, { status?: string; sessionId?: string }>;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/state`);
    // It answered at all, so the JVM is alive — even a 500 proves that much.
    serverUp = true;
    if (!response.ok) { refreshTray(); return; }
    current = await response.json();
  } catch {
    serverUp = false; // connection refused: the tray says so in its labels
    refreshTray();
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
  refreshTray();
}

function jobsStatusText(): string {
  const entries = Object.entries(previousJobStates);
  if (entries.length === 0) return "No cron runs yet.";
  return entries.map(([id, status]) => `${id}: ${status}`).join("\n");
}

function trayStatus(): TrayStatus {
  return { port: serverPort, serverUp, jobs: previousJobStates };
}

/**
 * Rebuild the tray, but only when a reader would see the difference.
 *
 * Mutating a MenuItem's label after the fact shows nothing — the menu has to
 * be rebuilt and setContextMenu called again. At the poller's 30 s cadence
 * that is free, and traySummary keeps it to the ticks that changed something.
 */
function refreshTray(): void {
  if (!tray || tray.isDestroyed()) return;
  const status = trayStatus();
  const summary = traySummary(status);
  if (summary === lastTraySummary) return;
  lastTraySummary = summary;
  tray.setToolTip(trayTooltip(PRODUCT_NAME, status));
  tray.setContextMenu(
    Menu.buildFromTemplate(
      toTemplate(trayMenuModel({ productName: PRODUCT_NAME, status }), SHELL_MENU_HANDLERS),
    ),
  );
}

function createTray(): Tray {
  const icon = nativeImage.createFromDataURL(TRAY_ICON);
  // The bitmap is a 16x16 alpha mask already — exactly two colours, fully
  // transparent and solid Ebony #12120F — so on a dark menu bar it was drawing
  // near-black on near-black. As a template image macOS inverts it for the
  // appearance and for the highlighted state, which is what the mask was
  // always for. The *Template.png filename convention does not apply: there is
  // no file, so the flag IS the whole mechanism.
  icon.setTemplateImage(true);
  const t = new Tray(icon);
  t.setToolTip(trayTooltip(PRODUCT_NAME, trayStatus()));
  t.setContextMenu(
    Menu.buildFromTemplate(
      toTemplate(trayMenuModel({ productName: PRODUCT_NAME, status: trayStatus() }), SHELL_MENU_HANDLERS),
    ),
  );
  lastTraySummary = traySummary(trayStatus());
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
  runInPage(openAboutScript());
}

/**
 * Restart the JVM under the running shell.
 *
 * Every piece of this exists already; only the composition is new — until now
 * these four steps happened once, inside startup(). Three ways it can go
 * wrong, all of them guarded here:
 *
 * - The port is REUSED, never re-resolved. A new port is a new origin and a
 *   new origin has an empty localStorage: design, language, disclosure level,
 *   every spectroscope:* preference silently reset. That is the exact
 *   regression card 168 exists to prevent.
 * - shutdown() also clears jobsPoller, so the poller has to be recreated.
 * - A failed health wait does NOT quit the app the way startup() does. At
 *   startup there is nothing to keep; here there is a window, a tray and a
 *   user who asked for one thing.
 */
function awaitExit(jvm: ChildProcess, budgetMs: number): Promise<void> {
  if (jvm.exitCode !== null || jvm.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, budgetMs);
    jvm.once("exit", finish);
  });
}

async function restartServer(): Promise<void> {
  if (restarting) return; // a second click must not spawn a second JVM
  const answer = await dialog.showMessageBox({
    type: "question",
    title: "Restart spectro-server",
    message: "Restart the server?",
    detail: "Restarting stops any running agent and reconnects the window.",
    buttons: ["Restart", "Cancel"],
    defaultId: 1,
    cancelId: 1,
  });
  if (answer.response !== 0) return;
  restarting = true;
  try {
    // The old JVM must be GONE before the new one binds. shutdown() sends
    // SIGTERM and returns immediately — it has to, because before-quit cannot
    // await — so spawning straight after it hands the new server a port the
    // old one still holds, Spring Boot fails to bind, and the health wait
    // times out into an error dialog every single time. shutdown() has already
    // scheduled the SIGKILL escalation, so this only has to outlast it.
    const old = child;
    shutdown();
    if (old) await awaitExit(old, KILL_GRACE_MS + 1_000);
    child = spawnServer(serverPort);
    try {
      await waitForHealth(serverPort);
    } catch (err) {
      serverUp = false;
      refreshTray();
      dialog.showErrorBox("spectro-server did not restart", (err as Error).message);
      return;
    }
    serverUp = true;
    win?.webContents.reload(); // the socket died with the old JVM
    connectBrowserControl(serverPort); // and so did the browser control channel
    jobsPoller = setInterval(() => void pollJobs(serverPort), JOBS_POLL_MS);
    refreshTray();
  } finally {
    restarting = false;
  }
}

/**
 * Everything a menu item can ask the main process to do.
 *
 * Declared as a total Record so the compiler is the gate: a ShellAction added
 * to the model without a handler here fails `npm run build`, which the
 * linux-kit workflow runs. That is the mechanical form of "an item with no
 * real capability behind it does not ship".
 */
const SHELL_HANDLERS: Record<ShellAction, () => void> = {
  about: showAbout,
  cronStatus: () => {
    void dialog.showMessageBox({ title: "Cron status", message: jobsStatusText() });
  },
  restartServer: () => void restartServer(),
  // shell.openExternal, never win.loadURL — so will-navigate is never asked
  // and the deny-by-default guard stays exactly as it is.
  openInBrowser: () => void shell.openExternal(`http://127.0.0.1:${serverPort}`),
  // The port is OS-assigned and this window draws no address bar, so without
  // this a user cannot discover his own server address at all.
  copyServerAddress: () => clipboard.writeText(`http://127.0.0.1:${serverPort}`),
  // ~/.spectro is the data home the SERVER uses (SpectroConfig, CronScheduler,
  // ImageStore), and the shell spawns the JVM with this same user.home, so the
  // two cannot disagree.
  revealDataFolder: () => void shell.openPath(path.join(os.homedir(), ".spectro")),
  focusWindow: () => focusOrCreateWindow(),
  quit: () => app.quit(), // -> before-quit -> shutdown()
};

/** The four mechanisms, shared by the application menu and the tray. */
const SHELL_MENU_HANDLERS: Handlers = {
  onCommand: (id, arg) => sendCommand(id, arg),
  onHash: (hash) => gotoHash(hash),
  onUrl: (url) => void shell.openExternal(url),
  onShell: (action) => SHELL_HANDLERS[action](),
};

function createAppMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      appMenuTemplate({
        productName: PRODUCT_NAME,
        isMac: process.platform === "darwin",
        ...SHELL_MENU_HANDLERS,
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

  serverPort = await resolveServerPort();
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
  // Card 201: the visible browser. The pane lives in THIS window, and the main
  // process opens a control channel back to the JVM so the browser tools can
  // drive it — no preload script, which navigationGuard.ts treats as a security
  // property worth keeping.
  attachPaneTo(() => { focusOrCreateWindow(); return win; },
    () => sendCommand("nav.browser"));
  connectBrowserControl(serverPort);
  jobsPoller = setInterval(() => void pollJobs(serverPort), JOBS_POLL_MS);
  // The tray was built before the port was resolved, so its tooltip still
  // carries a zero. First poll is 30 s out; the address is worth having now.
  refreshTray();

  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) focusOrCreateWindow(); });
}

function shutdown(): void {
  disconnectBrowserControl();
  if (jobsPoller) { clearInterval(jobsPoller); jobsPoller = null; }
  const jvm = child;
  child = null;
  if (!jvm || jvm.exitCode !== null) return; // already gone
  jvm.kill("SIGTERM"); // graceful; Spring Boot catches it
  setTimeout(() => {
    if (jvm.exitCode === null) jvm.kill("SIGKILL"); // still alive after the grace period
  }, KILL_GRACE_MS).unref();
}
