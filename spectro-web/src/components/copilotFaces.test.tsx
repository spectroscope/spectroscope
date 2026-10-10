// Card 496: Copilot shows up wherever a provider shows up. A sign-in stands
// where other providers show a key, the first-run sheet has an option for it
// with the status line that opens the sign-in sheet, the settings page says
// in plain words what Copilot needs and what it costs, and the context ring
// shows what the session cost in GitHub AI credits when the runtime reports
// them. A request count is never shown.
//
// renderToStaticMarkup, the house idiom: the suite runs in plain Node.

import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Onboarding } from "./Onboarding";
import { CopilotSettingsNote } from "./CopilotSettingsNote";
import { ContextPopover } from "./ContextRing";
import { contextGauge } from "./contextRingMath";
import { listIsAuthoritative } from "./providerPickerMode";
import { shouldShowOnboarding } from "./onboardingFlag";
import { formatCredits } from "../format";
import { setLang } from "../state/lang";
import { dict, type Lang } from "../i18n/i18n";
import { initialState, reduce } from "../state/reducer";
import type { RunEvent } from "../events";

afterEach(() => setLang("en"));

/** Words of the house's own concept papers; a reader of the settings page has never seen them. */
const HOUSE_WORDS = /\b(harness|orchestrator|fleet|spectrum|lane|leveling|reach|floor|wire|card|karte)\b/i;

describe("the model list of a signed-in provider", () => {
  it("is authoritative like a ready key or a local backend", () => {
    expect(listIsAuthoritative("signed-in")).toBe(true);
    expect(listIsAuthoritative("ready")).toBe(true);
    expect(listIsAuthoritative("local")).toBe(true);
  });
  it("is not when a sign-in or a key is missing", () => {
    expect(listIsAuthoritative("needs-signin")).toBe(false);
    expect(listIsAuthoritative("needs-key")).toBe(false);
    expect(listIsAuthoritative(undefined)).toBe(false);
  });
});

describe("the first-run sheet for a provider that signs in", () => {
  it("opens when the configured provider has no sign-in, as it does for a missing key", () => {
    expect(shouldShowOnboarding(false, "copilot", { copilot: "needs-signin" })).toBe(true);
    expect(shouldShowOnboarding(false, "copilot", { copilot: "signed-in" })).toBe(false);
    expect(shouldShowOnboarding(true, "copilot", { copilot: "needs-signin" })).toBe(false);
  });

  for (const [lang, tag] of [
    ["en", "signs in with GitHub"],
    ["de", "Anmeldung bei GitHub"],
  ] as const) {
    it(`has a copilot option tagged as a sign-in, with the status line and its sheet, in ${lang}`, () => {
      setLang(lang);
      const html = renderToStaticMarkup(<Onboarding open onClose={() => {}} />);
      const at = html.indexOf(">copilot<");
      expect(at, "no copilot option").toBeGreaterThan(0);
      const option = html.slice(at, html.indexOf("</li>", at));
      expect(option).toContain(tag);
      expect(option).not.toContain("needs a key");
      expect(option, "the status line with the button that opens the sign-in sheet").toContain("ob-opt-cta");
    });
  }
});

describe("the settings note under the provider", () => {
  for (const lang of ["en", "de"] as Lang[]) {
    it(`says what Copilot needs and how it is billed, in plain words, in ${lang}`, () => {
      const html = renderToStaticMarkup(<CopilotSettingsNote lang={lang} />);
      const text = html.replace(/<[^>]+>/g, " ");
      expect(text).toMatch(lang === "en" ? /GitHub/ : /GitHub/);
      expect(text).toMatch(lang === "en" ? /AI credits/ : /AI-Credits/);
      expect(text).toContain("brew install --cask copilot-cli");
      expect(text).not.toMatch(HOUSE_WORDS);
      expect(text, "a request count is never the unit").not.toMatch(/request|Anfrage/i);
    });
  }
  it("has both languages for every entry it uses", () => {
    for (const key of ["set.copilotNote", "set.copilotInstall"] as const) {
      expect(dict[key].en.length).toBeGreaterThan(20);
      expect(dict[key].de.length).toBeGreaterThan(20);
      expect(dict[key].de).not.toBe(dict[key].en);
    }
  });
});

describe("AI credits in the session state", () => {
  const usage = (aiCredits?: number, agentId = "main"): RunEvent => ({
    type: "usage",
    agentId,
    inputTokens: 10,
    outputTokens: 2,
    ...(aiCredits !== undefined ? { aiCredits } : {}),
    ts: 1,
  });

  it("stays null while no usage event reported any", () => {
    const state = reduce(reduce(initialState, usage()), usage());
    expect(state.aiCredits).toBeNull();
  });
  it("adds up what the session's calls cost, children included", () => {
    const state = reduce(reduce(reduce(initialState, usage(1.03609)), usage()), usage(0.5, "worker-1"));
    expect(state.aiCredits).toBeCloseTo(1.53609, 9);
  });
});

describe("the context ring's AI credit line", () => {
  const popover = (aiCredits: number | null): string => {
    const gauge = contextGauge(100_000, undefined, undefined);
    return renderToStaticMarkup(
      <ContextPopover
        lastInputTokens={5000}
        context={null}
        gauge={gauge}
        shownPct={5}
        onWindowOverride={undefined}
        aiCredits={aiCredits}
      />,
    );
  };

  it("names the credits the session cost when the runtime reported them", () => {
    const html = popover(1.03609);
    expect(html).toContain("AI credits this session");
    expect(html).toContain("1.04");
  });
  it("draws no credit line when none were reported", () => {
    expect(popover(null)).not.toContain("AI credits");
  });
  it("never shows a request count", () => {
    expect(popover(1.03609)).not.toMatch(/request/i);
  });
  it("formats credits to two places and says when a cost is below that", () => {
    expect(formatCredits(1.03609, "en")).toBe("1.04");
    expect(formatCredits(1.03609, "de")).toBe("1,04");
    expect(formatCredits(0.001, "en")).toBe("< 0.01");
    expect(formatCredits(0, "en")).toBe("0.00");
  });
});
