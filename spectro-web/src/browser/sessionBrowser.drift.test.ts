// Two doors, one browser — and one wire word, spelled the same in three
// projects. Read off disk, because none of it is checked by a type.
//
// Card 218 settled that every session has its OWN browser, and card 228
// finished the thought: the rail's browser door opened a browser that belongs
// to NO session, so it left. What remains is the session tab (the door card
// 218's rule blesses) and the workspace's browser card (card 219) — and both
// must hand the surface the SAME session id, or the second door becomes a
// second browser showing a page the session on screen is not driving.
//
// The wire half is the same kind of coupling browserMarker.drift.test.ts pins:
// the Java server writes a field and a verb, the Electron shell reads them, and
// nothing between the two projects would notice a rename. What a drift costs is
// specific and silent — a `sessionId` the shell never finds makes every browser
// tool answer "this command named no session", and a `close_session` the shell
// never recognises leaves a closed session's page, cookies and logins alive for
// as long as the app runs.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_TABS } from "../state/route";

const app = readFileSync(path.join(__dirname, "..", "App.tsx"), "utf8");

const repo = path.join(__dirname, "..", "..", "..");
const controlSocket = readFileSync(
  path.join(
    repo,
    "spectro-server",
    "src",
    "main",
    "java",
    "dev",
    "spectroscope",
    "server",
    "browser",
    "BrowserControlSocket.java",
  ),
  "utf8",
);
const shellControl = readFileSync(path.join(repo, "spectro-desktop", "src", "browserControl.ts"), "utf8");
const shellPane = readFileSync(path.join(repo, "spectro-desktop", "src", "browserPane.ts"), "utf8");

/** @return how many times `<Name` is mounted as a JSX element in `src` */
function mounts(src: string, name: string): number {
  return src.split(`<${name}`).length - 1;
}

describe("two doors, one browser", () => {
  it("mounts the browser surface exactly once in the app: the session tab", () => {
    // The rail door left with card 228 — nothing outside a session may open a
    // browser. One App mount is the pin that keeps it from creeping back.
    expect(mounts(app, "BrowserSegment")).toBe(1);
  });

  it("mounts the SECOND door in the workspace (card 219), same session, exactly once", () => {
    // The workspace's browser card is the owner's own first-cut ask: the
    // browser beside files, terminal and context. It is a second HOLE, never
    // a second browser: the session id is threaded from the app
    // (`sessionId={shownSessionId}`, pinned in dockSeparation.drift.test.ts),
    // and it can never be on screen with the tab door — the dock lives inside
    // the chat arm, the session tab arm renders only on tab==="browser".
    const rightPanel = readFileSync(path.join(__dirname, "..", "components", "RightPanel.tsx"), "utf8");
    expect(mounts(rightPanel, "BrowserSegment")).toBe(1);
    const passed = rightPanel.match(/<BrowserSegment[\s\S]*?sessionId=\{([^}]+)\}/);
    expect(passed?.[1]).toBe("sessionId");
  });

  it("hands the tab door the shown session, so every door is a view", () => {
    // Anything else here — a literal, a different variable, a missing prop —
    // means two sessions' worth of browser behind two holes that look alike.
    const passed = app.match(/<BrowserSegment[^/]*?sessionId=\{([^}]+)\}/g) ?? [];
    expect(passed).toHaveLength(1);
    expect(passed[0]).toContain("sessionId={shownSessionId}");
  });

  it("gives the session's tab row a browser tab that the address grammar knows", () => {
    // This tab is also where a deep link lands: the rail segment never had an
    // address of its own (state/route.ts knows live/session/fleet/import/
    // settings and nothing else), so `#/browser` always meant THIS tab and
    // still does — removing the rail row 404s nothing.
    expect(VIEW_TABS).toContain("browser");
    expect(app).toContain('onClick={() => changeTab("browser")}');
  });
});

describe("the session travels the browser wire under one name", () => {
  it("is written by the server and read by the shell as sessionId", () => {
    // Every place the server writes it, counted rather than found once: the
    // send path has two branches (a browser command and the window-level
    // viewport) and the close path a third, and a rename in ONE of them is the
    // drift that would leave exactly one verb serving nobody.
    const writes = controlSocket.match(/frame\.put(Null)?\("sessionId"/g) ?? [];
    expect(writes).toHaveLength(3);
    // And the read that decides, not merely a mention: the shell turns a
    // missing or empty field into null, and null is what it refuses on.
    expect(shellControl).toMatch(/typeof command\.sessionId === "string"/);
  });

  it("closes a session's browser under one verb", () => {
    expect(controlSocket).toContain('frame.put("verb", "close_session")');
    expect(shellPane).toMatch(/(case|verb ===) "close_session"/);
  });

  it("keys the Chromium partition off the session, which IS the isolation", () => {
    // Not a convention in the shell's own code: two sessions get two Electron
    // sessions, and a cookie jar cannot be shared across them by accident. A
    // constant partition here would put every agent back in one login.
    expect(shellPane).toMatch(/function partitionFor\(sessionId: string, opening = 0\): string \{/);
    expect(shellPane).toContain("${PARTITION_PREFIX}${safe}-${fingerprint(sessionId)}-${opening}");
    // And it is in memory: `persist:` would leave a directory per session id
    // that nothing deletes, which is not what "until the session is closed" says.
    expect(shellPane).not.toContain('PARTITION_PREFIX = "persist:');
  });

  it("gives back what a closed session's browser held, which IS the lifetime", () => {
    // The half the review sent this card back for. "In memory" was a promise
    // about the DISK: Electron keeps an in-memory Chromium session alive by
    // partition name for the life of the app, so five closed sessions held five
    // cookie jars and a resumed id opened onto its old login. Both lines below
    // are load-bearing and neither is enough alone — the emptying takes the
    // credential out of the process, the per-opening name keeps the next life
    // off the hook that closes over the record the close threw away.
    expect(shellPane).toContain("clearStorageData()");
    expect(shellPane).toContain("clearCache()");
    expect(shellPane).toMatch(/openings\.set\(pane\.id/);
  });
});
