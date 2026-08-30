// ONE door to the browser, not two.
//
// WHY, and NOT why. The owner asked for the session's `browser` tab on
// 2026-08-30 — "hier oben den browser wegnehmen, der ist eh nicht lebensfähig" —
// which reverses his own card 218 decision that the visible browser belongs in
// the session's tab row. Reversing it is his call. This file is the check that
// the removal is complete and that nothing left with it.
//
// ⚠️ IT IS NOT THE FIX FOR THE DISPLACEMENT HE REPORTED IN THE SAME BREATH, and
// the first draft of this file said it was. The theory was: two holes on screen
// at once post two rectangles for one native view, so the page lands under the
// door the reader is not looking at. It is a good theory and it is FALSE here —
// the two doors are branches of the SAME ternary on `tab` in App.tsx (the chat
// arm opens at :2411 and holds the dock at :2518; the browser arm opens at
// :2620), so `tab` would have to be "chat" and "browser" at once. The comment
// in sessionBrowser.drift.test.ts said exactly this and was right; measuring it
// is what killed the theory. The displacement has another cause and is still
// open.
//
// So what this file is actually worth:
//
// 1. ONE MOUNT SITE IS SIMPLER THAN TWO KEPT APART BY A TERNARY. The mutual
//    exclusion above is a property of one expression's shape, held by nothing —
//    move the dock out of the chat arm, or give another arm a browser hole, and
//    two rectangles become reachable with no test going red. After this card
//    there is one site, and one site cannot disagree with itself.
// 2. THE TAB HAD A SECOND PASSENGER. `BrowserReplay` — a stored session's
//    recorded browser (card 204) — was mounted only from the tab, and a stored
//    session has no live browser at all, because card 218 retires it when the
//    session's socket goes. Removing the tab without moving the replay would
//    have deleted a shipped feature nobody asked to remove. That is the half of
//    this change most likely to be lost by a later reader, so it is pinned
//    first.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VIEW_TABS } from "../state/route";

const src = (...p: string[]): string => readFileSync(path.join(__dirname, "..", ...p), "utf8");

const app = src("App.tsx");
const dock = src("components", "RightPanel.tsx");

/**
 * Every place in the shipped app that mounts a component, counted off disk.
 *
 * Read as text rather than by rendering, because the thing that matters is how
 * many mount SITES exist — a render can only show the ones a given state
 * reaches, and "unreachable together today" is exactly the property that has no
 * guard.
 */
function mountSites(name: string): { file: string; line: number }[] {
  const needle = "<" + name;
  const out: { file: string; line: number }[] = [];
  for (const [file, text] of [
    ["App.tsx", app],
    ["components/RightPanel.tsx", dock],
  ] as const) {
    text.split("\n").forEach((line, i) => {
      if (line.includes(needle)) out.push({ file, line: i + 1 });
    });
  }
  return out;
}

describe("the browser has one door", () => {
  it("mounts the live browser surface in exactly one place", () => {
    const sites = mountSites("BrowserSegment");
    expect(sites.map((s) => `${s.file}:${s.line}`)).toHaveLength(1);
    expect(sites[0].file).toBe("components/RightPanel.tsx");
  });

  it("mounts the recorded browser in exactly one place, and it is the same panel", () => {
    // The replay was the tab's second passenger. If it does not move to the
    // workspace card with the live surface, taking the tab out silently deletes
    // a stored session's browser recording.
    const sites = mountSites("BrowserReplay");
    expect(sites.map((s) => `${s.file}:${s.line}`)).toHaveLength(1);
    expect(sites[0].file).toBe("components/RightPanel.tsx");
  });

  it("shows the live face to a live session and the record to a stored one", () => {
    // Both halves in one panel, chosen by the SAME flag the rest of the dock
    // already uses (`liveView`, fed `viewingLive` from App.tsx). Asserting only
    // that both names appear would pass on a panel that rendered one of them
    // unconditionally, which is the shape that loses the replay again.
    const browserCase = dock.slice(dock.indexOf('case "browser":'), dock.indexOf('case "browser":') + 1400);
    expect(browserCase).toContain("liveView === true ?");
    expect(browserCase.indexOf("<BrowserSegment")).toBeGreaterThan(browserCase.indexOf("liveView === true ?"));
    expect(browserCase.indexOf("<BrowserReplay")).toBeGreaterThan(browserCase.indexOf("<BrowserSegment"));
  });

  it("offers no browser tab in the session tab row", () => {
    // Both halves, because either one alone leaves a half-removed feature: the
    // grammar must not name a tab the row does not offer, and the row must not
    // offer a tab the grammar cannot address.
    expect(VIEW_TABS).not.toContain("browser");
    expect(app).not.toContain('changeTab("browser")');
  });

  it("does not leave the two-door claim standing in App.tsx", () => {
    // The sentence that stood there said "only one door is ever on screen",
    // which was TRUE and unchecked — the kind that survives its own subject.
    // It described a ternary's shape as though it were a guarantee.
    expect(app).not.toContain("only one door is ever on screen");
  });
});

describe("the guard that was NOT the problem", () => {
  it("still exists and is still about modals only", () => {
    // A RECORD, not a repair. `dockCovered` suppresses the dock's holes while a
    // modal covers them, and that job is unchanged. It is pinned because the
    // refuted theory above pointed straight at it — the obvious "fix" would
    // have been to add a tab condition to a set that has nothing to do with
    // tabs, chasing a cause that was not there.
    const start = app.indexOf("const dockCovered");
    expect(start).toBeGreaterThan(-1);
    const decl = app.slice(start, app.indexOf(";", start));
    expect(decl).toContain("settingsOpen");
    expect(decl).toContain("spawnDialogOpen");
    expect(decl).not.toContain("tab ===");
  });
});
