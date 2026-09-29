// Card 455: the first-start mode screen. One choice per view mode, drawn from
// VIEW_MODES; none marked as suggested; each with a picture drawn from the
// SURFACES table.
//
// House style: renderToStaticMarkup, no DOM. A click is not pinned here; the
// order of the dialogs is pinned in state/firstStart.test.ts and the click is
// walked in a browser under criterion 9.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModeIntro, PICTURE_SKIPS } from "./ModeIntro";
import { SURFACES, isOpen, type SurfaceId } from "../state/surfaces";
import { VIEW_MODES, type ViewMode } from "../state/viewMode";
import { dict } from "../i18n/i18n";

const markup = (): string => renderToStaticMarkup(<ModeIntro onChoose={() => {}} />);

/** Every choice button's opening tag, in screen order. */
function choiceTags(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /class="[^"]*\bmode-intro__pick\b/.test(tag));
}

/** The markup of one choice, from its button to the next closing button tag. */
function choiceMarkup(html: string, mode: string): string {
  const at = html.indexOf(`data-mode="${mode}"`);
  expect(at, `no choice for ${mode}`).toBeGreaterThan(-1);
  return html.slice(at, html.indexOf("</button>", at));
}

/** The picture of one choice, as surface id to drawn presence. */
function picture(html: string, mode: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of choiceMarkup(html, mode).matchAll(/data-surface="([^"]+)" data-present="(true|false)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

describe("the mode screen", () => {
  it("offers one choice per view mode, in the order of the list", () => {
    const modes = choiceTags(markup()).map((tag) => /data-mode="([a-z]+)"/.exec(tag)?.[1]);
    expect(modes).toEqual([...VIEW_MODES]);
  });

  it("weighs every choice the same: one class for all, no primary", () => {
    const tags = choiceTags(markup());
    expect(tags.length).toBe(VIEW_MODES.length);
    const classes = new Set(tags.map((tag) => /class="([^"]*)"/.exec(tag)?.[1]));
    expect(classes.size).toBe(1);
    expect(markup()).not.toContain("--primary");
  });

  it("is a dialog with an accessible name", () => {
    const html = markup();
    const dialog = /<div\b[^>]*role="dialog"[^>]*>/.exec(html)?.[0] ?? "";
    expect(dialog).toContain('aria-modal="true"');
    const name = dict["mode.intro.title"]?.en;
    expect(name).toBeTruthy();
    expect(dialog).toContain(`aria-label="${name}"`);
  });

  it("explains each mode in the language on screen, in both languages", () => {
    const html = markup();
    for (const mode of VIEW_MODES) {
      for (const part of ["name", "body", "switch"]) {
        const key = `mode.intro.${mode}.${part}`;
        expect(dict[key]?.en, key).toBeTruthy();
        expect(dict[key]?.de, key).toBeTruthy();
        expect(choiceMarkup(html, mode), key).toContain(dict[key]!.en.replace(/&/g, "&amp;"));
      }
    }
    for (const lang of ["de", "en"] as const) {
      const bodies = VIEW_MODES.map((mode) => dict[`mode.intro.${mode}.body`]?.[lang]);
      expect(new Set(bodies).size, lang).toBe(VIEW_MODES.length);
    }
  });

  it("draws each picture from the surface table", () => {
    const html = markup();
    const drawn = (Object.keys(SURFACES) as SurfaceId[]).filter((id) => !PICTURE_SKIPS.has(id));
    for (const mode of VIEW_MODES) {
      const expected = Object.fromEntries(drawn.map((id) => [id, String(isOpen(id, mode, false))]));
      expect(picture(html, mode), mode).toEqual(expected);
    }
    // The positive side: learn draws the lab, light draws the chat.
    expect(picture(html, "learn").lab).toBe("true");
    expect(picture(html, "light").chat).toBe("true");
    expect(picture(html, "light").lab).toBe("false");
  });

  it("skips only surfaces that are not a part of the window", () => {
    // The settings page's fleet block and a row in the chat's menu have no
    // place in a picture of the window. Everything else in the table is drawn.
    expect([...PICTURE_SKIPS].sort()).toEqual(["fleetSettings", "liveTraceSwitch"]);
  });

  it("colours the picture with design tokens only", () => {
    const svg = choiceMarkup(markup(), "learn");
    const fills = [...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]);
    expect(fills.length).toBeGreaterThan(0);
    for (const value of fills) expect(value, value).toMatch(/^(none|var\(--[a-z0-9-]+\))$/);
  });
});

describe("the picture follows the table (criterion 1b)", () => {
  const saved = { ...SURFACES.lab.modes };
  afterEach(() => {
    SURFACES.lab.modes = { ...saved };
  });

  it("a surface that moves into light moves into light's picture", () => {
    expect(picture(markup(), "light").lab).toBe("false");
    SURFACES.lab.modes = { ...saved, light: "open" };
    expect(picture(markup(), "light").lab).toBe("true");
  });

  it("a surface that leaves learn leaves learn's picture", () => {
    expect(picture(markup(), "learn").lab).toBe("true");
    SURFACES.lab.modes = { ...saved, learn: "gone" };
    expect(picture(markup(), "learn").lab).toBe("false");
  });
});

describe("a third mode in the list", () => {
  afterEach(() => {
    vi.doUnmock("../state/viewMode");
    vi.resetModules();
  });

  it("gets a third choice", async () => {
    vi.resetModules();
    vi.doMock("../state/viewMode", async (importOriginal) => {
      const real = await importOriginal<typeof import("../state/viewMode")>();
      return { ...real, VIEW_MODES: [...real.VIEW_MODES, "developer" as ViewMode] };
    });
    const { ModeIntro: Fresh } = await import("./ModeIntro");
    const html = renderToStaticMarkup(<Fresh onChoose={() => {}} />);
    const modes = choiceTags(html).map((tag) => /data-mode="([a-z]+)"/.exec(tag)?.[1]);
    expect(modes).toEqual([...VIEW_MODES, "developer"]);
  });
});
