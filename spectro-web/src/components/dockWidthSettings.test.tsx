// The dock's two widths reach a person (card 361).
//
// The keys landed one card earlier, with a Java test that said out loud what it
// was NOT claiming: that anything read them. This file is the other half — the
// controls an operator touches, the sentence under them, and the classification
// that sentence is allowed to make.
//
// The control assertions RENDER, for the reason card 356's header records: a
// test that reads the source for the key's name stays green when the whole
// control row is deleted, because the name still stands in the block's
// `fields={[...]}` array. A string being present is not a control being present.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DockWidthSettings } from "./DockWidthSettings";
import { SETTING_REACH, noteKeyFor, reachOf } from "./settingsReach";
import { dict, t } from "../i18n/i18n";

const KEYS = ["chatReserveWidth", "dockMaxWidth"] as const;

/** The smallest view the block can draw: every key effective, none overridden. */
const view = (over: Record<string, unknown> = {}) =>
  ({
    effective: { ...Object.fromEntries(Object.keys(SETTING_REACH).map((k) => [k, 1])), ...over },
    origins: {},
    layers: {},
    files: {},
    workspace: null,
  }) as never;

const render = (lang: "en" | "de" = "en", over: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(<DockWidthSettings view={view(over)} lang={lang} onSave={() => {}} />);

describe("the two widths are classified before they are drawn", () => {
  it("both are live, which is what the panel's own save path makes true", () => {
    // MEASURED at the seam rather than hoped for: SettingsPanel routes every
    // fresh view through readDockWidths → setDockBounds, which writes the
    // --chat-reserve custom property and re-clamps a dock already wider than a
    // lowered ceiling. No agent reads either number, so nothing waits for a
    // session.
    for (const key of KEYS) expect(SETTING_REACH[key], key).toBe("live");
  });

  it("may not share a sentence with a session-fixed setting", () => {
    // The guard shown still guarding, not merely not complaining.
    expect(() => reachOf(["chatReserveWidth", "maxTurns"])).toThrow(/do not all reach/);
  });

  it("RENDERS its own sentence, because the generic live one names a tool call", () => {
    // "…from its next tool call" is true of the belt and false of a stylesheet.
    // Measured on the markup and not on noteKeyFor: the first draft of this
    // case called the helper itself, and deleting the block's `note` prop left
    // it green — a test of the helper wearing the name of a test of the block.
    expect(t("en", "set.reachLive")).toMatch(/tool call/);
    expect(noteKeyFor([...KEYS], "set.dockWidthApplies")).toBe("set.dockWidthApplies");
    const html = render();
    expect(html).toContain(t("en", "set.dockWidthApplies" as never));
    expect(html).not.toContain(t("en", "set.reachLive"));
  });
});

describe("each width has a control of its own", () => {
  it("draws a number input for each, measured on the rendered page", () => {
    const html = render();
    for (const key of KEYS) {
      expect(html, `${key} has no field on the page`).toContain(`data-dock-field="${key}"`);
      const at = html.indexOf(`data-dock-field="${key}"`);
      expect(html.slice(at, at + 400), `${key} renders no number input`).toMatch(/<input[^>]*type="number"/);
    }
  });

  it("shows the resolved value, so the field is not a blank the operator must guess", () => {
    const html = render("en", { chatReserveWidth: 420, dockMaxWidth: 2400 });
    expect(html).toMatch(/value="420"/);
    expect(html).toMatch(/value="2400"/);
  });

  it("stands in one block that names both, with the reach visible in the DOM", () => {
    const blocks = [...render().matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    // One block: they share a reach AND a subject — how wide the dock may get.
    expect(blocks).toEqual(["chatReserveWidth dockMaxWidth"]);
  });

  it("offers a reset for each width once the user layer has set it", () => {
    // The affordance, not its payload: this suite renders to static markup and
    // has no way to click. What it can prove is that BOTH fields carry an
    // OriginRow of their own — a settings page whose second field cannot be
    // un-set is a one-way door, and one shared badge would look identical here.
    const withUser = {
      effective: Object.fromEntries(Object.keys(SETTING_REACH).map((k) => [k, 1])),
      origins: {},
      layers: { user: { chatReserveWidth: 420, dockMaxWidth: 2400 } },
      files: {},
      workspace: null,
    } as never;
    const html = renderToStaticMarkup(<DockWidthSettings view={withUser} lang="en" onSave={() => {}} />);
    expect([...html.matchAll(/class="origin-row"/g)]).toHaveLength(2);
    expect([...html.matchAll(/class="origin-reset"/g)]).toHaveLength(2);
  });
});

describe("it says what it does, in both languages", () => {
  it("has no key falling through to its own name", () => {
    const keys = [
      "set.secDockWidth",
      "set.dockWidthHint",
      "set.dockWidthApplies",
      "set.chatReserveWidth",
      "set.chatReserveWidthNote",
      "set.dockMaxWidth",
      "set.dockMaxWidthNote",
    ];
    for (const key of keys) {
      expect(Object.prototype.hasOwnProperty.call(dict, key), `${key} is missing`).toBe(true);
      for (const lang of ["en", "de"] as const) {
        const text = t(lang, key as never);
        expect(text, `${key}/${lang}`).not.toBe(key);
        expect(text.length, `${key}/${lang}`).toBeGreaterThan(3);
      }
    }
  });

  it("tells the reader WHICH of the two stops them, because that depends on the window", () => {
    // The card's own refuted premise: "there is one clamp, relax it" would have
    // changed nothing on the owner's external monitor. A page that offers two
    // numbers without saying that has handed the reader the same trap.
    for (const lang of ["en", "de"] as const) {
      const hint = t(lang, "set.dockWidthHint" as never).toLowerCase();
      expect(hint, lang).toMatch(/window|fenster/);
    }
  });

  it("renders the German page in German", () => {
    expect(render("de")).toContain(t("de", "set.secDockWidth" as never));
    expect(render("de")).not.toContain(t("en", "set.chatReserveWidthNote" as never));
  });
});
