// Card 430, criterion 3 and card 481: the switch sits in the header, is announced as a
// choice of three with the current one marked, is chosen from the keyboard, and
// takes its words from the dictionary in English and German.
//
// No DOM here: the markup comes from React's server renderer, and a press is
// the handler the component built, run through testkit/driveComponent.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { setLang } from "../state/lang";
import {
  __resetViewModeForTests,
  __setViewModeStorage,
  currentViewMode,
  setViewMode,
  VIEW_MODES,
} from "../state/viewMode";
import { drive, type El } from "../testkit/driveComponent";
import { AppHeader } from "./AppHeader";
import { ModeSwitch, modeForKey } from "./ModeSwitch";

beforeEach(() => {
  const store = new Map<string, string>();
  __setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
  __resetViewModeForTests();
});
afterEach(() => {
  setLang("en");
  setViewMode("learn");
});

/** A radio's key handler, as the switch built it. */
function keyDownOf(el: El): (e: { key: string; preventDefault: () => void }) => void {
  return el.props.onKeyDown as (e: { key: string; preventDefault: () => void }) => void;
}

/** The radios as the switch renders them, in order. */
function radios(tree: El[]): El[] {
  return tree.filter((el) => el.props.role === "radio");
}

describe("the switch is a choice of three, announced as one", () => {
  it("renders a radio group with a label, three radios, and the current one checked", () => {
    const html = renderToStaticMarkup(<ModeSwitch />);
    expect(html).toMatch(/role="radiogroup"[^>]*aria-label="Mode"/);
    expect([...html.matchAll(/role="radio"/g)]).toHaveLength(3);
    expect(html).toMatch(/role="radio" aria-checked="true" tabindex="0"[^>]*>learn</);
    expect(html).toMatch(/role="radio" aria-checked="false" tabindex="-1"[^>]*>light</);
    expect(html).toMatch(/role="radio" aria-checked="false" tabindex="-1"[^>]*>developer</);
    setViewMode("light");
    const after = renderToStaticMarkup(<ModeSwitch />);
    expect(after).toMatch(/role="radio" aria-checked="false" tabindex="-1"[^>]*>learn</);
    expect(after).toMatch(/role="radio" aria-checked="true" tabindex="0"[^>]*>light</);
    setViewMode("developer");
    const third = renderToStaticMarkup(<ModeSwitch />);
    expect(third).toMatch(/role="radio" aria-checked="true" tabindex="0"[^>]*>developer</);
    expect(third).toMatch(/role="radio" aria-checked="false" tabindex="-1"[^>]*>learn</);
  });

  it("takes its label and tooltips from the dictionary, in German too", () => {
    for (const key of [
      "hdr.mode.label",
      "hdr.mode.learn",
      "hdr.mode.light",
      "hdr.mode.learnTitle",
      "hdr.mode.lightTitle",
      "hdr.mode.developer",
      "hdr.mode.developerTitle",
    ]) {
      expect(dict[key]?.en, `${key}.en`).toBeTruthy();
      expect(dict[key]?.de, `${key}.de`).toBeTruthy();
    }
    setLang("de");
    const html = renderToStaticMarkup(<ModeSwitch />);
    expect(html).toContain(`aria-label="${dict["hdr.mode.label"].de}"`);
    expect(html).toContain(`title="${dict["hdr.mode.lightTitle"].de}"`);
    expect(html).toContain(`title="${dict["hdr.mode.developerTitle"].de}"`);
    expect(html).toContain(`title="${dict["hdr.mode.learnTitle"].de}"`);
  });

  it("keeps the mode words lowercase in both languages (owner call 2)", () => {
    for (const mode of VIEW_MODES) {
      expect(dict[`hdr.mode.${mode}`]).toEqual({ de: mode, en: mode });
    }
  });

  it("says in the light tooltip which surfaces light turns off, in both languages", () => {
    for (const word of ["spectrum", "trace", "graph", "text", "lab"]) {
      expect(dict["hdr.mode.lightTitle"].en.toLowerCase()).toContain(word);
      expect(dict["hdr.mode.lightTitle"].de.toLowerCase()).toContain(word);
    }
  });
});

describe("the keyboard", () => {
  it("cycles learn, light, developer, learn with the forward arrows, wrapping at the end", () => {
    for (const key of ["ArrowRight", "ArrowDown"]) {
      expect(modeForKey(key, "learn"), key).toBe("light");
      expect(modeForKey(key, "light"), key).toBe("developer");
      expect(modeForKey(key, "developer"), key).toBe("learn");
    }
  });

  it("cycles back with the backward arrows, wrapping at the start", () => {
    for (const key of ["ArrowLeft", "ArrowUp"]) {
      expect(modeForKey(key, "learn"), key).toBe("developer");
      expect(modeForKey(key, "developer"), key).toBe("light");
      expect(modeForKey(key, "light"), key).toBe("learn");
    }
  });

  it("chooses the focused mode with Enter or Space, and ignores other keys", () => {
    expect(modeForKey("Enter", "light")).toBe("light");
    expect(modeForKey(" ", "learn")).toBe("learn");
    expect(modeForKey("Enter", "developer")).toBe("developer");
    expect(modeForKey("Tab", "learn")).toBe(null);
    expect(modeForKey("a", "learn")).toBe(null);
  });

  it("switches the store when an arrow is pressed on the checked radio", () => {
    let prevented = 0;
    drive(
      <ModeSwitch />,
      [ModeSwitch],
      [(tree) => keyDownOf(radios(tree)[0])({ key: "ArrowRight", preventDefault: () => prevented++ })],
    );
    expect(currentViewMode()).toBe("light");
    expect(prevented).toBe(1);
  });

  it("switches the store when a radio is clicked", () => {
    drive(<ModeSwitch />, [ModeSwitch], [(tree) => radios(tree)[2].props.onClick?.()]);
    expect(currentViewMode()).toBe("developer");
    drive(<ModeSwitch />, [ModeSwitch], [(tree) => radios(tree)[1].props.onClick?.()]);
    expect(currentViewMode()).toBe("light");
    drive(<ModeSwitch />, [ModeSwitch], [(tree) => radios(tree)[0].props.onClick?.()]);
    expect(currentViewMode()).toBe("learn");
  });
});

describe("the switch sits in the header", () => {
  it("is drawn by AppHeader, whatever the view", () => {
    for (const viewingLive of [true, false]) {
      const html = renderToStaticMarkup(
        <AppHeader
          sidebarOpen={false}
          onToggleSidebar={() => {}}
          replayId={viewingLive ? null : "a-recorded-session"}
          title="a session"
          imageCount={0}
          showPanelToggle={false}
          panelOpen={false}
          onTogglePanel={() => {}}
          doctorOpen={false}
          onToggleDoctor={() => {}}
          onOpenKeymap={() => {}}
          canGoBack={false}
          canGoForward={false}
        />,
      );
      expect(html, String(viewingLive)).toMatch(/role="radiogroup"/);
    }
  });
});
