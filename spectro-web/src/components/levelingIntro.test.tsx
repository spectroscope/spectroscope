// Card 387: the welcome screen offers one button per mode.
//
// The screen was built with two buttons while the model behind it has carried
// three values since the ladder shipped, so "open everything and keep the
// tutorial away" cost a second trip into the settings. No test file in the tree
// touched this component before this one.
//
// House style: renderToStaticMarkup, no DOM and no testing-library (the repo
// has neither). That buys the markup the component produces and nothing after
// it. A click is therefore NOT pinned here; the third choice reaching the
// server is pinned on the Java side in LevelingControllerTest, and the click
// itself is walked once in a browser under criterion 10.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LevelingIntro } from "./LevelingIntro";
import { LEVELING_MODES } from "../state/leveling";
import { dict } from "../i18n/i18n";

const markup = (): string => renderToStaticMarkup(<LevelingIntro onChoose={() => {}} />);

/** The mode each choice button carries, in the order the screen draws them. */
function pickedModes(html: string): string[] {
  return [...html.matchAll(/<button\b[^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => /class="[^"]*\blvl-intro__pick\b/.test(tag))
    .map((tag) => /data-mode="([a-z]+)"/.exec(tag)?.[1] ?? "");
}

describe("the welcome screen", () => {
  it("offers one button per mode, in the order of the list", () => {
    expect(pickedModes(markup())).toEqual([...LEVELING_MODES]);
  });

  it("carries the third answer itself, so no settings visit is needed", () => {
    expect(pickedModes(markup())).toContain("off");
  });

  it("names every mode and says what it costs, in the language on screen", () => {
    const html = markup();
    for (const mode of LEVELING_MODES) {
      const name = dict[`leveling.intro.${mode}`]?.en;
      const hint = dict[`leveling.intro.${mode}.hint`]?.en;
      expect(name, `leveling.intro.${mode}`).toBeTruthy();
      expect(hint, `leveling.intro.${mode}.hint`).toBeTruthy();
      expect(html, `the screen never shows ${mode}'s name`).toContain(name!);
      expect(html, `the screen never shows ${mode}'s hint`).toContain(hint!);
    }
  });

  it("gives each answer its own sentence, in both languages", () => {
    // Criterion 9 asks that the third option says it is final. The wording
    // itself is read by a human; what is pinned here is that the three hints
    // are three different sentences, so a copied line cannot leave two answers
    // describing themselves the same way.
    for (const lang of ["de", "en"] as const) {
      const hints = LEVELING_MODES.map((mode) => dict[`leveling.intro.${mode}.hint`]?.[lang]);
      expect(new Set(hints).size, `${lang}: two modes share a hint`).toBe(LEVELING_MODES.length);
    }
  });

  it("marks exactly one choice as the suggested one", () => {
    const primaries = [...markup().matchAll(/<button\b[^>]*>/g)]
      .map((match) => match[0])
      .filter((tag) => /class="[^"]*\blvl-intro__pick--primary\b/.test(tag));
    expect(primaries).toHaveLength(1);
    expect(primaries[0]).toContain(`data-mode="${LEVELING_MODES[0]}"`);
  });
});
