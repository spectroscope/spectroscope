// Card 455: the first-start mode screen. One choice per view mode, drawn from
// VIEW_MODES; none marked as suggested; each with a picture drawn from the
// SURFACES table.
//
// House style: renderToStaticMarkup, no DOM. A click is not pinned here; the
// order of the dialogs is pinned in state/firstStart.test.ts and the click is
// walked in a browser under criterion 9.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ModeIntro, PICTURE_SKIPS } from "./ModeIntro";
import { SURFACES, isOpen, type SurfaceId } from "../state/surfaces";
import { VIEW_MODES } from "../state/viewMode";
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

describe("the third mode", () => {
  it("is developer, offered as a third choice after learn and light", () => {
    const modes = choiceTags(markup()).map((tag) => /data-mode="([a-z]+)"/.exec(tag)?.[1]);
    expect(modes).toEqual(["learn", "light", "developer"]);
  });

  it("draws developer's picture with the playbook filled and the lab filled", () => {
    const html = markup();
    expect(picture(html, "developer").playbook).toBe("true");
    expect(picture(html, "developer").lab).toBe("true");
    expect(picture(html, "learn").playbook).toBe("false");
    expect(picture(html, "light").playbook).toBe("false");
  });

  it("draws developer's tab row the way light's is drawn, gone until the tutorial is on (card 513)", () => {
    const html = markup();
    expect(picture(html, "developer").tabRow).toBe("false");
    expect(picture(html, "light").tabRow).toBe("false");
    expect(picture(html, "learn").tabRow).toBe("true");
  });

  it("names the other two modes' switch without listing two words", () => {
    for (const mode of VIEW_MODES) {
      for (const lang of ["de", "en"] as const) {
        expect(dict[`mode.intro.${mode}.switch`][lang], `${mode} ${lang}`).not.toMatch(
          /learn und light|learn and light/,
        );
      }
    }
  });
});

// Card 518: the developer choice explains how the mode is built, for a reader
// who is not technical. The learn and light texts stay as they were.
describe("the developer explanation (card 518)", () => {
  /** The sentences of a text: a stop, a question or an exclamation mark ends one. */
  const sentences = (text: string): string[] =>
    text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

  const CONCEPTS: Record<"en" | "de", Record<string, RegExp>> = {
    en: {
      "project folder": /\bproject\b[^.]*\bfolder\b|\bfolder\b[^.]*\bproject\b/i,
      workspace: /\bworkspace\b/i,
      playbook: /\bplaybook\b/i,
      phases: /\bphases?\b/i,
      gates: /\bgates?\b/i,
      "model per phase": /\bmodel\b[^.]*\bphase\b|\bphase\b[^.]*\bmodel\b/i,
      Spectrolyzr: /\bSpectrolyzr\b/,
      "new project or playbook": /\bnew project\b[^.]*\bplaybook\b/i,
    },
    de: {
      "project folder": /\bProjekt\w*\b[^.]*\bOrdner\b|\bOrdner\b[^.]*\bProjekt/,
      workspace: /\bArbeitsbereich\b/,
      playbook: /\bPlaybook\b/,
      phases: /\bPhasen?\b/,
      gates: /\bGates?\b/,
      "model per phase": /\bModell\b[^.]*\bPhase\b|\bPhase\b[^.]*\bModell\b/,
      Spectrolyzr: /\bSpectrolyzr\b/,
      "new project or playbook": /\bneues Projekt\b[^.]*\bPlaybook\b/,
    },
  };

  it("names the project folder, the playbook with phases and gates, a model per phase and Spectrolyzr", () => {
    for (const lang of ["en", "de"] as const) {
      const body = dict["mode.intro.developer.body"][lang];
      for (const [concept, pattern] of Object.entries(CONCEPTS[lang])) {
        expect(body, `${lang}: ${concept}`).toMatch(pattern);
      }
    }
  });

  it("says it in at most five sentences, in plain words, with no dash", () => {
    for (const lang of ["en", "de"] as const) {
      const body = dict["mode.intro.developer.body"][lang];
      const count = sentences(body).length;
      expect(count, `${lang}: ${body}`).toBeLessThanOrEqual(5);
      expect(count, lang).toBeGreaterThanOrEqual(3);
      expect(body, lang).not.toMatch(/[\u2013\u2014]|--/);
    }
  });

  it("is on screen in the developer choice", () => {
    expect(choiceMarkup(markup(), "developer")).toContain(dict["mode.intro.developer.body"].en);
  });

  it("leaves the learn and light texts as they were", () => {
    expect(dict["mode.intro.learn.body"]).toEqual({
      de: "Alle Teile der App sind offen: Chat, Arbeitsbereich, Sessions und Skills, dazu die Tabs spectrum, trace, graph, text und lab, der State-Graph und die Flotten. Danach kannst du ein Tutorial wählen, das sie nach und nach öffnet.",
      en: "Every part of the app is open: the chat, the workspace, sessions and skills, and also the spectrum, trace, graph, text and lab tabs, the state graph and the fleets. After this you can choose a tutorial that opens them one at a time.",
    });
    expect(dict["mode.intro.light.body"]).toEqual({
      de: "Du bekommst Chat, Arbeitsbereich, Sessions und Skills. Die übrigen Tabs, den State-Graph und die Flotten lädt die App nicht, und sie arbeiten auch nicht im Hintergrund. Light hat kein Tutorial.",
      en: "You get the chat, the workspace, sessions and skills. The app does not load the other tabs, the state graph or the fleets, and they do no work in the background. Light has no tutorial.",
    });
  });
});

describe("the developer picture follows the table (card 518 criterion 4)", () => {
  const saved = { ...SURFACES.playbook.modes };
  afterEach(() => {
    SURFACES.playbook.modes = { ...saved };
  });

  it("a surface that leaves developer leaves developer's picture", () => {
    expect(picture(markup(), "developer").playbook).toBe("true");
    SURFACES.playbook.modes = { ...saved, developer: "gone" };
    expect(picture(markup(), "developer").playbook).toBe("false");
  });

  it("a surface that moves into developer's table row moves into developer's picture", () => {
    const savedRow = { ...SURFACES.tabRow.modes };
    try {
      expect(picture(markup(), "developer").tabRow).toBe("false");
      SURFACES.tabRow.modes = { ...savedRow, developer: "open" };
      expect(picture(markup(), "developer").tabRow).toBe("true");
    } finally {
      SURFACES.tabRow.modes = savedRow;
    }
  });
});
