import { describe, expect, it } from "vitest";
import {
  isDesktopShell,
  panelNoteKey,
  panelState,
  shouldReport,
  toPaneRect,
  type PaneRect,
} from "./viewport";

const rect = (over: Partial<PaneRect> = {}): PaneRect => ({
  x: 320,
  y: 56,
  width: 860,
  height: 700,
  visible: true,
  sessionId: "20260813-120000-aaaaaaaa",
  ...over,
});

describe("shouldReport", () => {
  it("reports the first rectangle it ever measures", () => {
    expect(shouldReport(rect(), null)).toBe(true);
  });

  it("stays quiet when the rectangle did not move", () => {
    expect(shouldReport(rect(), rect())).toBe(false);
  });

  it("reports a real move", () => {
    expect(shouldReport(rect({ x: 321 }), rect())).toBe(true);
    expect(shouldReport(rect({ height: 640 }), rect())).toBe(true);
  });

  it("always reports a change of visibility, however still the rectangle is", () => {
    // Leaving the segment is not a cosmetic change: it is the difference
    // between the operator seeing the page and seeing the app behind it.
    expect(shouldReport(rect({ visible: false }), rect({ visible: true }))).toBe(true);
    expect(shouldReport(rect({ visible: true }), rect({ visible: false }))).toBe(true);
  });
});

describe("toPaneRect", () => {
  it("rounds a measured box into the integer pixels the shell positions in", () => {
    expect(toPaneRect({ left: 319.6, top: 55.2, width: 860.4, height: 699.5 }, true, "s-1")).toEqual({
      x: 320,
      y: 55,
      width: 860,
      height: 700,
      visible: true,
      sessionId: "s-1",
    });
  });

  it("carries the session whose browser belongs in the hole (card 218)", () => {
    // Two doors, one browser: the rail segment and the session's own browser tab
    // post the SAME session id, so the shell shows one view for both. Without
    // the id the shell would show whichever agent ran last, which is the rail
    // showing somebody else's page.
    expect(toPaneRect({ left: 0, top: 0, width: 10, height: 10 }, true, null).sessionId).toBeNull();
  });
});

describe("shouldReport, once a rectangle names its session", () => {
  it("reports when the same rectangle now belongs to another session", () => {
    // The operator switched sessions without the layout moving a pixel. The
    // hole is identical and the browser behind it must not be.
    expect(shouldReport(rect({ sessionId: "b" }), rect({ sessionId: "a" }))).toBe(true);
  });

  it("still stays quiet when nothing at all changed", () => {
    expect(shouldReport(rect({ sessionId: "a" }), rect({ sessionId: "a" }))).toBe(false);
  });
});

describe("isDesktopShell", () => {
  it("recognises the desktop window by the marker the shell stamps on it", () => {
    expect(isDesktopShell("Mozilla/5.0 … Electron/43.3.0 spectroscope-desktop/0.8.0")).toBe(true);
  });

  it("does not mistake an ordinary browser for the shell", () => {
    expect(isDesktopShell("Mozilla/5.0 (Macintosh) Chrome/151 Safari/537.36")).toBe(false);
    expect(isDesktopShell("")).toBe(false);
  });

  it("does not mistake ANOTHER Electron app's browser for the shell", () => {
    // Measured, and the reason the marker exists at all: the browser this card
    // was verified in is itself an Electron app, so "Electron/" in the user
    // agent identified the wrong window. Only a string this shell writes can
    // identify this shell.
    expect(
      isDesktopShell("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/148 Electron/42.7.0 Safari/537.36"),
    ).toBe(false);
  });
});

describe("panelState", () => {
  it("says loading until the server answers", () => {
    expect(panelState(null, true, "s-1")).toBe("loading");
  });

  it("says no-shell on the web face, which is the ratified trade said out loud", () => {
    expect(panelState({ attached: false, url: null }, true, "s-1")).toBe("no-shell");
    expect(panelNoteKey("no-shell")).toBe("browser.noShellNote");
  });

  it("says no-session before the session it belongs to has one", () => {
    // A session mints its id on its first prompt. Until then it has no browser,
    // and the honest panel says that rather than showing an empty frame or —
    // worse — the address of a page a different session's agent is driving.
    expect(panelState({ attached: true, url: null }, true, null)).toBe("no-session");
    expect(panelNoteKey("no-session")).toBe("browser.noSessionNote");
    // And BEFORE any answer, which is the state a fresh session is actually in:
    // with no session id there is nothing to ask the server about, so `status`
    // never stops being null. Measured live — the panel said "Checking for a
    // browser pane …" under a frame that was never going to fill.
    expect(panelState(null, true, null)).toBe("no-session");
  });

  it("says attached only in the window the pane is actually laid over", () => {
    // The server's "attached" means A shell is connected, not that THIS page is
    // that shell. A reader with the desktop app open on the same machine, who
    // then points their own browser at the server, would otherwise be shown a
    // green dot over an empty rectangle — the pane is a native overlay in the
    // desktop window and cannot be anywhere else. Measured live, 2026-08-13.
    expect(panelState({ attached: true, url: "http://127.0.0.1:5173/" }, true, "s-1")).toBe("attached");
    expect(panelState({ attached: true, url: "http://127.0.0.1:5173/" }, false, "s-1")).toBe("no-shell");
    expect(panelNoteKey("attached")).toBe("browser.attachedNote");
  });
});
