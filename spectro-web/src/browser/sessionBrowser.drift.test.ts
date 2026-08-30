// ONE door to the browser — and one wire word, spelled the same in three
// projects. Read off disk, because none of it is checked by a type.
//
// The header below describes the TWO-door world, which is what this file was
// written for and what the code did until 2026-08-30. It is kept because the
// reasoning still explains the shape: the two doors had to hand the surface the
// same session id, and when the second door left, the one that remained had to
// take over both of its faces. The count itself moved to oneDoor.drift.test.ts.
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
  it("mounts the browser surface nowhere in App.tsx any more", () => {
    // This read `toBe(1)` and its name said "exactly once IN THE APP" while it
    // counted one FILE — the workspace door in RightPanel.tsx was a second
    // mount the whole time, and this assertion could not see it. The count that
    // spans both files now lives in oneDoor.drift.test.ts; what is left here is
    // the half this file can honestly check.
    expect(mounts(app, "BrowserSegment")).toBe(0);
    expect(mounts(app, "BrowserReplay")).toBe(0);
  });

  it("mounts the ONLY door in the workspace (card 219), same session, exactly once", () => {
    // The workspace's browser card is the owner's own first-cut ask: the
    // browser beside files, terminal and context. It was the second of two
    // holes until 2026-08-30 and is the only one now.
    //
    // The sentence that stood here — "it can never be on screen with the tab
    // door, the dock lives inside the chat arm, the session tab arm renders
    // only on tab===\"browser\"" — was TRUE, and it earned its keep: a session
    // reading these two files as the cause of a displaced page measured it and
    // it held (App.tsx, chat arm :2411 holding the dock at :2518, browser arm
    // :2620 — branches of one ternary on `tab`). It killed a wrong theory. It
    // is recorded here rather than deleted, because the property it described
    // was never guarded by anything, and that is why the mount COUNT is now a
    // test of its own.
    const rightPanel = readFileSync(path.join(__dirname, "..", "components", "RightPanel.tsx"), "utf8");
    expect(mounts(rightPanel, "BrowserSegment")).toBe(1);
    const passed = rightPanel.match(/<BrowserSegment[\s\S]*?sessionId=\{([^}]+)\}/);
    expect(passed?.[1]).toBe("sessionId");
  });

  it("hands the one door the shown session, threaded through the dock", () => {
    // Anything else — a literal, a different variable, a missing prop — means a
    // browser showing a page the session on screen is not driving. With the tab
    // gone the thread runs App.tsx -> RightPanel -> BrowserSegment, so both hops
    // are checked: App must hand the dock `shownSessionId`, and the dock must
    // pass its own `sessionId` straight through rather than reach for anything
    // of its own.
    expect(app).toMatch(/<RightPanel[\s\S]{0,200}?sessionId=\{shownSessionId\}/);
    const rightPanel = readFileSync(path.join(__dirname, "..", "components", "RightPanel.tsx"), "utf8");
    const passed = rightPanel.match(/<BrowserSegment[\s\S]*?sessionId=\{([^}]+)\}/);
    expect(passed?.[1]).toBe("sessionId");
    const replay = rightPanel.match(/<BrowserReplay[\s\S]{0,80}?sessionId=\{([^}]+)\}/);
    expect(replay?.[1]).toBe("sessionId");
  });

  it("no longer gives the session's tab row a browser tab", () => {
    // REPLACED on 2026-08-30, not loosened. Card 218 put this tab in the row and
    // this test held it there; the owner asked for it back out — "der ist eh
    // nicht lebensfähig". That is his call to reverse.
    //
    // What it is NOT: the fix for the displaced page he reported in the same
    // message. That looked like two holes posting two rectangles for one native
    // view, and the sentence a few lines up refuted it — the two doors are arms
    // of one ternary on `tab` and could never be on screen together. The
    // displacement has another cause and is still open.
    //
    // What is one door now is checked by browser/oneDoor.drift.test.ts, which
    // also holds the replay to the same panel so this removal does not quietly
    // take card 204's recording with it.
    expect(VIEW_TABS).not.toContain("browser");
    expect(app).not.toContain('changeTab("browser")');
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
