// Pins for the built-in model's first-use notice (card 91) — and, since card
// 144, for the four ways out of it. The owner measured the sheet returning on
// every boot: only the "got it" button wrote the flag, while ×, the backdrop
// and Escape closed without remembering. The decision on the card: every exit
// means "understood, go away", so every exit persists — and the deliberate way
// back lives in Settings, not in an exit that forgets.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import {
  __setLocalNoticeTestHooks,
  markLocalNoticeSeen,
  readLocalNoticeSeen,
  shouldShowLocalNotice,
} from "./localNoticeFlag";

describe("shouldShowLocalNotice", () => {
  it("shows on the first spectro-local activation", () => {
    expect(shouldShowLocalNotice(null, "spectro-local")).toBe(true);
  });

  it("never again after a dismissal", () => {
    expect(shouldShowLocalNotice("1", "spectro-local")).toBe(false);
  });

  it("stays quiet for every other provider — and while none is known", () => {
    expect(shouldShowLocalNotice(null, "anthropic")).toBe(false);
    expect(shouldShowLocalNotice(null, null)).toBe(false);
  });
});

describe("one dismissal, whatever the exit (card 144)", () => {
  // The suite runs in plain Node (no jsdom), so we inject an in-memory store —
  // the designPrefs seam pattern.
  let stored: string | null;
  beforeEach(() => {
    stored = null;
    __setLocalNoticeTestHooks({
      get: () => stored,
      set: () => {
        stored = "1";
      },
    });
  });

  it("marking the notice seen is what silences the next boot", () => {
    expect(shouldShowLocalNotice(readLocalNoticeSeen(), "spectro-local")).toBe(true);
    markLocalNoticeSeen();
    expect(readLocalNoticeSeen()).toBe("1");
    expect(shouldShowLocalNotice(readLocalNoticeSeen(), "spectro-local")).toBe(false);
  });
});

// What no unit test in a suite without a DOM can see is the .tsx wiring, and
// the defect lived exactly there: the flag logic was sound, but three of the
// four exits were routed past the write. Read the sources off disk and pin the
// routing itself.
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

describe("the four exits, read off disk (card 144)", () => {
  const notice = read("./LocalModelNotice.tsx");
  const app = read("../App.tsx");
  const settings = read("./SettingsPanel.tsx");

  it("the sheet knows exactly one exit prop — the distinction that forgot is gone", () => {
    expect(notice).toContain("onDismiss");
    expect(notice).not.toContain("onGotIt");
    expect(notice).not.toContain("onClose");
  });

  it("escape, the backdrop, the × and the button all route into it", () => {
    // Escape goes through the destructured handler; the three click sites take
    // the prop directly. Four sites, none of them special.
    expect(notice.split("onDismiss()").length - 1).toBe(1);
    expect(notice.split("{props.onDismiss}").length - 1).toBe(3);
    const backdrop = notice.split("\n").find((l) => l.includes("km-backdrop"));
    expect(backdrop).toContain("onClick={props.onDismiss}");
  });

  it("the app hands every exit the one persisting dismissal", () => {
    expect(app).toContain("onDismiss={dismissLocalNotice}");
    expect(app).toContain("markLocalNoticeSeen()");
    // The parameter that let an exit forget is gone.
    expect(app).not.toContain("dismissLocalNotice(false)");
    expect(app).not.toContain("dismissLocalNotice(true)");
  });

  it("settings keeps the deliberate way back", () => {
    expect(settings).toContain("onShowLocalNotice");
    expect(settings).toContain("set.localNoticeShow");
    // Two openers in the app, no more: the automatic one on the first
    // spectro-local activation, and the deliberate one from Settings.
    expect(app.split("setLocalNoticeOpen(true)").length - 1).toBe(2);
  });

  it("speaks both languages", () => {
    for (const key of ["set.secLocalNotice", "set.localNoticeHint", "set.localNoticeShow"]) {
      expect(dict[key]?.de, key).toBeTruthy();
      expect(dict[key]?.en, key).toBeTruthy();
    }
  });
});
