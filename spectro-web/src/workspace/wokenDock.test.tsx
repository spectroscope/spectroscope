// Card 520: the dock reads the woken workspace.
//
// Card 498 fed the wake's answer only to the header chip. The dock got the
// replay's own state, where workspace_info never appears, so Files showed the
// stored note and Terminal stayed shut after a wake. One rule now decides for
// both: the wake's answer counts once it names the session on screen and its
// folder is on disk, or is reported gone. The suite runs in plain Node, so the
// panels are rendered to markup (no effect runs) and the request the Files
// pane makes is read from the same function its load uses.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { RunEvent } from "../events";
import { initialState, reduceAll, type WorkspaceInfo } from "../state/reducer";
import { dockWorkspace, headerWorkspace, wokenWorkspace } from "./wakeChip";
import { WorkspaceTab } from "./WorkspaceTab";
import { TerminalPanel } from "../panels/TerminalPanel";
import { filesQuery } from "./paneState";
import { t } from "../i18n/i18n";

const ID = "20261011-100000-w520";
const OTHER = "20261011-100100-w520";
const STORED_CWD = "/Users/someone/ForgeDemo";

const WOKEN: WorkspaceInfo = {
  sessionId: ID,
  path: STORED_CWD,
  configured: false,
  resolved: true,
  mode: "recorded",
  exists: true,
};
const GONE: WorkspaceInfo = {
  sessionId: ID,
  path: "/Users/someone/deleted-project",
  configured: false,
  resolved: false,
  mode: "recorded",
  exists: false,
  unavailable: "/Users/someone/deleted-project",
};

/** What the wake's own socket says first: the app's folder, no session. */
const prospectiveFrame = {
  type: "workspace_info",
  resolved: false,
  mode: "default",
  configured: true,
  exists: true,
  path: "/Users/someone/app-folder",
} as unknown as RunEvent;

const stored = (woken: WorkspaceInfo | null, over: Partial<Parameters<typeof dockWorkspace>[0]> = {}) =>
  dockWorkspace({
    viewingLive: false,
    viewWorkspace: null,
    continuable: true,
    replayId: ID,
    woken,
    ...over,
  });

/** Markup with the entities React writes for quotes and ampersands read back as text. */
const decoded = (html: string): string =>
  html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const filesPane = (workspace: WorkspaceInfo | null): string =>
  decoded(renderToStaticMarkup(<WorkspaceTab workspace={workspace} storedCwd={STORED_CWD} />));

const terminal = (workspace: WorkspaceInfo | null): string =>
  decoded(renderToStaticMarkup(<TerminalPanel workspace={workspace} />));

const APP = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");
const RIGHT_PANEL = readFileSync(path.join(__dirname, "..", "components", "RightPanel.tsx"), "utf8");

describe("one rule for the chip and the dock", () => {
  it("counts the wake's answer for the session on screen", () => {
    expect(wokenWorkspace(ID, WOKEN)).toBe(WOKEN);
    expect(wokenWorkspace(ID, GONE)).toBe(GONE);
    expect(stored(WOKEN)).toBe(WOKEN);
    expect(stored(GONE)).toBe(GONE);
  });

  it("does not count an answer for another session, or no session", () => {
    expect(wokenWorkspace(OTHER, WOKEN)).toBeNull();
    expect(wokenWorkspace(null, WOKEN)).toBeNull();
    expect(stored(WOKEN, { replayId: OTHER })).toBeNull();
  });

  it("does not count the wake socket's prospective frame without a session id", () => {
    // Fed through the real reducer into the woken record's state, as it lands.
    const woken = reduceAll(initialState, [prospectiveFrame]).workspace;
    expect(woken?.sessionId).toBeUndefined();
    expect(wokenWorkspace(ID, woken)).toBeNull();
    expect(stored(woken)).toBeNull();
    expect(headerWorkspace({ ...chipBase, woken })).toEqual(headerWorkspace({ ...chipBase, woken: null }));
  });

  it("the prospective frame drives no tree and no request", () => {
    const woken = reduceAll(initialState, [prospectiveFrame]).workspace;
    const dock = stored(woken);
    expect(filesQuery(dock)).toBeNull();
    const html = filesPane(dock);
    expect(html).toContain(t("en", "ws.stored"));
    expect(html).not.toContain("app-folder");
  });

  it("leaves the live view and a read only archive as they were", () => {
    const live: WorkspaceInfo = { ...WOKEN, sessionId: "live-1" };
    expect(stored(WOKEN, { viewingLive: true, viewWorkspace: live })).toBe(live);
    expect(stored(WOKEN, { continuable: false })).toBeNull();
  });

  it("feeds the header chip the same answer", () => {
    expect(headerWorkspace({ ...chipBase, woken: WOKEN })).toBe(WOKEN);
    expect(headerWorkspace({ ...chipBase, woken: GONE })).toBe(GONE);
  });
});

const chipBase = {
  viewingLive: false,
  liveWorkspace: null,
  continuable: true,
  replayId: ID,
  storedCwd: STORED_CWD,
};

describe("the Files panel of a woken session", () => {
  it("asks for the woken session's tree at once", () => {
    const dock = stored(WOKEN);
    expect(filesQuery(dock)).toBe(`session=${ID}`);
    const html = filesPane(dock);
    // Resolved and asked: the pane waits for the tree, it does not repeat the stored note.
    expect(html).toContain("loading");
    expect(html).not.toContain(t("en", "ws.stored"));
  });

  it("is wired from the dock helper in App, never from the replay's own state", () => {
    expect(APP).toMatch(
      /<RightPanel\b[\s\S]*?workspace=\{dockWorkspace\(\{[\s\S]*?woken: wokenSlot\?\.state\.workspace \?\? null,[\s\S]*?\}\)\}/,
    );
    const panel = APP.slice(
      APP.indexOf("<RightPanel"),
      APP.indexOf("recordedCwd=", APP.indexOf("<RightPanel")),
    );
    expect(panel).toContain("workspace={dockWorkspace(");
    expect(panel).not.toContain("workspace={view.workspace}");
  });

  it("follows the refresh signal while a wake feeds it, as a live session does", () => {
    expect(APP).toContain("fsRefreshSignal={viewingLive || dockWoken ? fsTick : undefined}");
  });

  it("before the wake shows the stored note and asks nothing", () => {
    expect(filesQuery(stored(null))).toBeNull();
    expect(filesPane(stored(null))).toContain(t("en", "ws.stored"));
  });

  it("for a folder that is gone says so and asks nothing", () => {
    const dock = stored(GONE);
    expect(filesQuery(dock)).toBeNull();
    const html = filesPane(dock);
    expect(html).toContain("this folder is gone");
    expect(html).toContain("deleted-project");
    expect(html).not.toContain("created when the first run starts");
  });
});

describe("the Terminal panel of a woken session", () => {
  it("opens in the woken session: past the session gate, on to the shell check", () => {
    const html = terminal(stored(WOKEN));
    expect(html).toContain(t("en", "dock.termChecking"));
    expect(html).not.toContain(t("en", "dock.termNoSession"));
  });

  it("stays shut for a folder that is gone, in the gone words, and starts no shell", () => {
    const html = terminal(stored(GONE));
    expect(html).toContain(t("en", "dock.termGone"));
    expect(html).toContain("deleted-project");
    expect(html).not.toContain(t("en", "dock.termChecking"));
    expect(html).not.toContain("dock-term");
  });

  it("stays shut before the wake", () => {
    expect(terminal(stored(null))).toContain(t("en", "dock.termNoSession"));
  });

  it("gets the dock's workspace from the right panel", () => {
    expect(RIGHT_PANEL).toContain("<TerminalPanel workspace={workspace} />");
  });
});

describe("a resumed session that ran on in a fallback folder", () => {
  // Its frame names the gone folder as unavailable too, but it is resolved and
  // the run works in the fallback. The dock's gone gate must not shut it.
  const FALLBACK: WorkspaceInfo = {
    sessionId: "live-2",
    path: "/tmp/spectroscope-ws/live-2",
    configured: false,
    resolved: true,
    mode: "recorded",
    exists: true,
    unavailable: "/Users/someone/deleted-project",
  };

  it("still lists its folder and opens its terminal", () => {
    expect(filesQuery(FALLBACK)).toBe("session=live-2");
    expect(filesPane(FALLBACK)).not.toContain("this folder is gone");
    expect(terminal(FALLBACK)).toContain(t("en", "dock.termChecking"));
  });
});

describe("a session live in another window (card 520, criterion 6)", () => {
  it("the refused wake leaves chip, Files and Terminal read only", () => {
    // session_busy closed the record, so there is no woken workspace; the
    // live set marks the session as held elsewhere, so it is not continuable.
    const dock = stored(null, { continuable: false });
    expect(headerWorkspace({ ...chipBase, continuable: false, woken: null })).toBeNull();
    expect(filesQuery(dock)).toBeNull();
    expect(filesPane(dock)).toContain(t("en", "ws.stored"));
    expect(terminal(dock)).toContain(t("en", "dock.termNoSession"));
  });

  it("App keeps the replay on screen when a wake is refused, and wakes it no more", () => {
    expect(APP).toMatch(
      /busySink\.current = \(sessionId: string, woken: boolean\): void => \{\s*setSessionBusy\(sessionId\);[\s\S]*?if \(!woken\) void openSessionRef\.current\(sessionId\);/,
    );
    expect(APP).toContain(
      "const refusedOnScreen = replayOnScreen !== null && sessionBusy === replayOnScreen;",
    );
  });
});
