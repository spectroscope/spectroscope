// The progress section as it actually renders (cards 281/282).
//
// The pure module beside this file decides what "armed" means; this checks the
// section says it where a test — and a stylesheet — can read it, and that the
// negative assertions have something to stand on that is not a sentence.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProgressGuardSettings } from "./ProgressGuardSettings";
import type { SettingsView } from "../state/serverSettings";
import type { Lang } from "../i18n/i18n";

function view(overrides: Record<string, unknown>): SettingsView {
  return {
    effective: {
      progressGuardWrites: 3,
      progressGuardFailures: 3,
      progressGuardPlanTurns: 0,
      maxTurns: 15,
      continuationBudget: 3,
      ...overrides,
    },
    origins: {},
    layers: {},
    files: {},
    workspace: null,
  } as unknown as SettingsView;
}

const render = (v: SettingsView, lang: Lang = "en"): string =>
  renderToStaticMarkup(
    <ProgressGuardSettings anchorId="settings-sec-progress" view={v} lang={lang} onSave={() => {}} />,
  );

describe("the progress section on screen", () => {
  /** The state this field's control declares. Read per FIELD rather than by
   *  counting attribute occurrences: a count is right for the wrong reasons the
   *  moment a control gains a second element carrying the same attribute, which
   *  is exactly what happened to this test's own first draft. */
  const stateOf = (html: string, field: string): string => {
    const at = html.indexOf(`data-progress-field="${field}"`);
    expect(at, `${field} has no control on this page`).toBeGreaterThan(-1);
    const around = html.slice(Math.max(0, at - 160), at + 160);
    const found = /data-progress-state="(armed|off)"/.exec(around);
    expect(found, `${field} declares no state`).not.toBeNull();
    return found![1];
  };

  it("states each control's state on the attribute, in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const html = render(view({}), lang);
      // The shipped defaults, per control: both cheap nets watching, the plan
      // net off because it needs a plan the weak models never write.
      expect(stateOf(html, "progressGuardWrites")).toBe("armed");
      expect(stateOf(html, "progressGuardFailures")).toBe("armed");
      expect(stateOf(html, "progressGuardPlanTurns")).toBe("off");
      expect(stateOf(html, "continuationBudget")).toBe("armed");
    }
  });

  it("draws the leash as off when its budget is zero", () => {
    expect(stateOf(render(view({ continuationBudget: 0 })), "continuationBudget")).toBe("off");
  });

  it("marks a negative as off, which a !== 0 reading would draw as armed", () => {
    const html = render(view({ progressGuardWrites: -1 }));
    expect(html).toContain('data-progress-field="progressGuardWrites"');
    expect(stateOf(html, "progressGuardWrites")).toBe("off");
  });

  it("carries one next-session block for the three counts and one for the ceiling", () => {
    const html = render(view({}));
    const blocks = [...html.matchAll(/data-reach-fields="([^"]+)"/g)].map((m) => m[1]);
    expect(blocks).toContain("progressGuardWrites progressGuardFailures progressGuardPlanTurns");
    expect(blocks).toContain("maxTurns");
    expect(blocks).toContain("continuationBudget");
    // The two ceilings never merge: their reaches differ and one sentence
    // covering both would be false for one of them.
    expect(blocks).not.toContain("maxTurns continuationBudget");
  });

  it("says nothing is watching rather than zero of three", () => {
    const off = render(view({ progressGuardWrites: 0, progressGuardFailures: 0, progressGuardPlanTurns: 0 }));
    expect(off).toContain('data-progress-summary="0"');
    // The negative goes on the attribute, never on the sentence: in German
    // "aus" is a substring of "ausgeschaltet" and "scharf" of "unscharf".
    expect(off).not.toContain('data-progress-summary="1"');
    expect(render(view({}))).toContain('data-progress-summary="2"');
  });
});
