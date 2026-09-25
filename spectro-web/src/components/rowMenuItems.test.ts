// Card 445: what the menu at the right end of a session row offers, and how the
// keyboard moves through it. Pure, so it runs without a DOM (house rule).

import { describe, expect, it } from "vitest";
import { t } from "../i18n/i18n";
import type { SessionMeta } from "../events";
import { sessionDisplayTitle } from "./sessionRows";
import { menuKeyStep, renameIntent, renameOpening, renameRequest, rowMenuItems } from "./rowMenuItems";

describe("the items", () => {
  it("offers pin, rename, suggest a title and delete for a stored row without a title", () => {
    const items = rowMenuItems({ pinned: false, hasTitle: false, deletable: true });
    expect(items.map((item) => item.id)).toEqual(["pin", "rename", "suggest", "delete"]);
  });

  it("offers unpin for a pinned row", () => {
    const items = rowMenuItems({ pinned: true, hasTitle: true, deletable: true });
    expect(items.map((item) => item.id)).toEqual(["unpin", "rename", "delete"]);
  });

  it("offers no suggestion for a row that has a title, suggested or typed", () => {
    expect(
      rowMenuItems({ pinned: false, hasTitle: true, deletable: true }).map((item) => item.id),
    ).not.toContain("suggest");
  });

  it("draws delete in the danger colour and nothing else", () => {
    const items = rowMenuItems({ pinned: false, hasTitle: false, deletable: true });
    expect(items.filter((item) => item.danger).map((item) => item.id)).toEqual(["delete"]);
  });

  it("disables delete while a socket holds the session, and says why", () => {
    const items = rowMenuItems({ pinned: false, hasTitle: false, deletable: false });
    const del = items.find((item) => item.id === "delete");
    expect(del?.disabled).toBe(true);
    expect(del?.hintKey).toBe("sess.menu.deleteLive");
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["delete"]);
  });

  it("names every item in English and German", () => {
    const all = [
      ...rowMenuItems({ pinned: false, hasTitle: false, deletable: false }),
      ...rowMenuItems({ pinned: true, hasTitle: false, deletable: true }),
    ];
    const seen = new Map<string, [string, string]>();
    for (const item of all) {
      seen.set(item.id, [t("en", item.labelKey), t("de", item.labelKey)]);
      if (item.hintKey !== undefined) {
        expect(t("en", item.hintKey)).not.toBe(item.hintKey);
        expect(t("de", item.hintKey)).not.toBe(t("en", item.hintKey));
      }
    }
    expect(Object.fromEntries(seen)).toEqual({
      pin: ["Pin", "Anheften"],
      unpin: ["Unpin", "Nicht mehr anheften"],
      rename: ["Rename", "Umbenennen"],
      suggest: ["Suggest a title", "Titel vorschlagen"],
      delete: ["Delete", "Löschen"],
    });
  });
});

describe("the keyboard in the open menu", () => {
  it("moves down and up and wraps at both ends", () => {
    expect(menuKeyStep("ArrowDown", 0, 4)).toBe(1);
    expect(menuKeyStep("ArrowDown", 3, 4)).toBe(0);
    expect(menuKeyStep("ArrowUp", 0, 4)).toBe(3);
    expect(menuKeyStep("ArrowUp", 2, 4)).toBe(1);
  });

  it("jumps to the ends with Home and End", () => {
    expect(menuKeyStep("Home", 2, 4)).toBe(0);
    expect(menuKeyStep("End", 1, 4)).toBe(3);
  });

  it("closes with Escape and returns focus, and closes on Tab without taking it back", () => {
    expect(menuKeyStep("Escape", 1, 4)).toBe("close");
    expect(menuKeyStep("Tab", 1, 4)).toBe("leave");
  });

  it("leaves every other key to the item under focus", () => {
    expect(menuKeyStep("Enter", 1, 4)).toBeNull();
    expect(menuKeyStep(" ", 1, 4)).toBeNull();
    expect(menuKeyStep("a", 1, 4)).toBeNull();
  });
});

describe("the rename field", () => {
  it("saves on Enter and cancels on Escape", () => {
    expect(renameIntent("Enter")).toBe("save");
    expect(renameIntent("Escape")).toBe("cancel");
    expect(renameIntent("a")).toBeNull();
  });

  it("sends a changed title", () => {
    expect(renameRequest({ typed: "Release 0.14.0", shown: "hallo", hasTitle: false })).toBe(
      "Release 0.14.0",
    );
    expect(renameRequest({ typed: "  Release 0.14.0 ", shown: "Old", hasTitle: true })).toBe(
      "Release 0.14.0",
    );
  });

  it("sends nothing when the field still says what the row said", () => {
    expect(renameRequest({ typed: "hallo", shown: "hallo", hasTitle: false })).toBeNull();
    expect(renameRequest({ typed: " Release 0.14.0 ", shown: "Release 0.14.0", hasTitle: true })).toBeNull();
  });

  it("sends an empty title to restore the suggestion or the first prompt, only when there is a title to drop", () => {
    expect(renameRequest({ typed: "   ", shown: "Release 0.14.0", hasTitle: true })).toBe("");
    expect(renameRequest({ typed: "", shown: "hallo", hasTitle: false })).toBeNull();
  });
});

describe("what the rename field opened with", () => {
  const untitled: SessionMeta = {
    id: "20260925-101500-ab12cd34",
    startedAt: Date.UTC(2026, 8, 25, 10, 15, 0),
    firstPrompt: "hallo, kannst du mal die release notes gliedern",
    tokens: 10,
  };
  const landed: SessionMeta = { ...untitled, title: "Release Notes gliedern", titleSource: "suggested" };

  it("notes the text the row showed and whether that text was a title", () => {
    expect(renameOpening(untitled, "en")).toEqual({
      id: untitled.id,
      shown: "hallo, kannst du mal die release notes gliedern",
      hasTitle: false,
    });
    expect(renameOpening(landed, "en")).toEqual({
      id: untitled.id,
      shown: "Release Notes gliedern",
      hasTitle: true,
    });
    expect(renameOpening({ ...untitled, title: "  " }, "en").hasTitle).toBe(false);
  });

  it("sends nothing for an untouched field when a suggestion landed on the row while it was open", () => {
    const opened = renameOpening(untitled, "en");
    // The row moved on under the open field, which still holds the first prompt.
    expect(sessionDisplayTitle(landed, "en")).not.toBe(opened.shown);
    expect(renameRequest({ typed: opened.shown, shown: opened.shown, hasTitle: opened.hasTitle })).toBeNull();
    // Measured against the row as it is at close, the same field would send the
    // first prompt as a manual title: the defect this note prevents.
    expect(
      renameRequest({ typed: opened.shown, shown: sessionDisplayTitle(landed, "en"), hasTitle: true }),
    ).toBe("hallo, kannst du mal die release notes gliedern");
  });
});
