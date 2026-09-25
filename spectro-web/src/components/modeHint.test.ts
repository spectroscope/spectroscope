// Card 427, loop wave H3b: the composer's hint for auto mode.
//
// Since card 427 a question the agent asks reaches the operator in every
// permission mode, auto and readonly included. The hint for auto still said
// "no questions asked" ("ohne nachzufragen"), and after that change it read as
// a promise that the agent's own questions are held back. Auto skips the
// permission request for a tool call and nothing else.
//
// ComposerGear draws one hint per entry of MODES, under the key
// `wsg.mode.<id>.hint`, so these checks walk MODES instead of a list of their own.

import { describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { MODES } from "./workspaceGear";

const LANGS = ["en", "de"] as const;

const hintKey = (id: string): string => `wsg.mode.${id}.hint`;

/** The two phrasings the old auto hint used for "the agent asks nothing". */
const NOBODY_IS_ASKED = /no questions asked|ohne nachzufragen/i;

describe("the permission mode hints in the composer gear", () => {
  it("every mode the gear lists has a hint in both languages", () => {
    for (const { id } of MODES) {
      for (const lang of LANGS) {
        expect(dict[hintKey(id)]?.[lang], `${hintKey(id)}.${lang}`).toBeTruthy();
      }
    }
  });

  it("auto says a tool call runs without a permission request", () => {
    expect(dict[hintKey("auto")].en).toMatch(/every tool call automatically, without a permission request/);
    expect(dict[hintKey("auto")].de).toMatch(/jeden Tool-Aufruf automatisch, ohne Berechtigungsanfrage/);
  });

  it("auto says the agent's own questions still reach the operator", () => {
    expect(dict[hintKey("auto")].en).toMatch(/The agent's own questions still reach you\./);
    expect(dict[hintKey("auto")].de).toMatch(/Eigene Fragen des Agenten erreichen dich weiterhin\./);
  });

  it("no mode's hint says the agent asks nothing", () => {
    for (const { id } of MODES) {
      for (const lang of LANGS) {
        expect(dict[hintKey(id)][lang], `${hintKey(id)}.${lang}`).not.toMatch(NOBODY_IS_ASKED);
      }
    }
  });
});
