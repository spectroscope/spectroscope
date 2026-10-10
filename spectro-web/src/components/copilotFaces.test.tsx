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
import { ComposerMeta } from "./ComposerMeta";
import { ContextPopover, ContextRing } from "./ContextRing";
import {
  COPILOT_INSTALL_LINE,
  notifyCopilotSignInChange,
  onCopilotSignInChange,
  signInChanged,
  type CopilotAccountStatus,
} from "./copilotAccount";
import { listIsAuthoritative, PROVIDERS } from "./providerPickerMode";
import { providerUnusable, shouldShowOnboarding } from "./onboardingFlag";
import { drive, type El } from "../testkit/driveComponent";
import { read, stripComments } from "../testkit/source";
import { srcFiles, srcText } from "../testkit/tree";
import { contextGauge } from "./contextRingMath";
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
      const html = renderToStaticMarkup(<CopilotSettingsNote provider="copilot" lang={lang} />);
      const text = html.replace(/<[^>]+>/g, " ");
      expect(text).toMatch(lang === "en" ? /GitHub/ : /GitHub/);
      expect(text).toMatch(lang === "en" ? /AI credits/ : /AI-Credits/);
      expect(text).toContain(COPILOT_INSTALL_LINE);
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

// ---- review of 2026-10-10 ---------------------------------------------------

describe("the settings note is mounted for copilot and only for copilot", () => {
  it("draws for copilot and for no other provider the picker lists", () => {
    expect(PROVIDERS).toContain("copilot");
    for (const provider of PROVIDERS) {
      const html = renderToStaticMarkup(<CopilotSettingsNote provider={provider} lang="en" />);
      expect(html.includes("copilot-settings-note"), provider).toBe(provider === "copilot");
    }
  });
  it("the settings page hands it the effective provider and puts no condition of its own around it", () => {
    // The note decides for itself; the page mounts it unconditionally. A
    // condition here once stood unpinned: replaced by false, the suite stayed green.
    const panel = stripComments(read("./SettingsPanel.tsx", import.meta.url));
    const mounts = panel.match(/<CopilotSettingsNote\b[^>]*\/>/g) ?? [];
    expect(mounts).toEqual([
      '<CopilotSettingsNote provider={String(view.effective.provider ?? "")} lang={lang} />',
    ]);
    const before = panel.slice(0, panel.indexOf("<CopilotSettingsNote")).trimEnd();
    expect(before.endsWith("&&") || before.endsWith("&& (") || before.endsWith("?")).toBe(false);
  });
});

describe("the credit line reaches the ring from the block under the composer", () => {
  const openRing = (tree: El[]): void => {
    const ring = tree.filter((el) => el.type === "button" && el.props.className === "context-ring");
    if (ring.length !== 1) throw new Error(`expected one ring button, found ${ring.length}`);
    (ring[0].props.onClick as () => void)();
  };
  const meta = (aiCredits: number | null) => (
    <ComposerMeta
      provider="copilot"
      model="claude-sonnet-5"
      status="open"
      onApplyProvider={() => {}}
      liveView
      lastInputTokens={8890}
      aiCredits={aiCredits}
      context={null}
      onWindowOverride={() => {}}
    />
  );
  const opened = (aiCredits: number | null): El => {
    const found = drive(meta(aiCredits), [ComposerMeta, ContextRing], [openRing]).filter(
      (el) => el.type === ContextPopover,
    );
    expect(found).toHaveLength(1);
    return found[0];
  };

  it("the popover the composer's ring opens names the session's credits", () => {
    const popover = opened(2.2344);
    expect(popover.props.aiCredits).toBe(2.2344);
    expect(renderToStaticMarkup(popover)).toContain("AI credits this session · 2.23");
  });
  it("and draws no credit line when the session reported none", () => {
    expect(renderToStaticMarkup(opened(null))).not.toContain("AI credits");
  });
});

describe("a sign-in made in a sheet reaches the app without a reload", () => {
  const status = (state: CopilotAccountStatus["state"]): CopilotAccountStatus => ({
    state,
    method: state === "SIGNED_IN" ? "cli" : null,
    login: state === "SIGNED_IN" ? "octo-fixture" : null,
    userCode: null,
    verificationUri: null,
    expiresAt: 0,
    message: null,
    github: false,
    cli: true,
  });

  it("a change is a flip of signed-in between two statuses that were read", () => {
    expect(signInChanged(status("NOT_SIGNED_IN"), status("SIGNED_IN"))).toBe(true);
    expect(signInChanged(status("WAITING"), status("SIGNED_IN"))).toBe(true);
    expect(signInChanged(status("SIGNED_IN"), status("NOT_SIGNED_IN"))).toBe(true);
    expect(signInChanged(status("NOT_SIGNED_IN"), status("WAITING"))).toBe(false);
    expect(signInChanged(status("SIGNED_IN"), status("SIGNED_IN"))).toBe(false);
    expect(signInChanged(undefined, status("SIGNED_IN")), "the first read is not a change").toBe(false);
    expect(signInChanged(status("NOT_SIGNED_IN"), null), "a failed read is not a change").toBe(false);
  });
  it("a listener hears a change until it unsubscribes", () => {
    let heard = 0;
    const stop = onCopilotSignInChange(() => heard++);
    notifyCopilotSignInChange();
    expect(heard).toBe(1);
    stop();
    notifyCopilotSignInChange();
    expect(heard).toBe(1);
  });
  it("the status line tells the app when its status flips", () => {
    const note = stripComments(read("./CopilotSignIn.tsx", import.meta.url));
    expect(note).toMatch(
      /if \(signInChanged\(seen\.current, note\.status\)\) notifyCopilotSignInChange\(\);/,
    );
  });
  it("the app re-reads the config when a Copilot sign-in changes", () => {
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toMatch(
      /useEffect\(\(\) => onCopilotSignInChange\(\(\) => setConfigNonce\(\(n\) => n \+ 1\)\), \[\]\);/,
    );
  });
});

describe("a provider without its sign-in is as unusable as one without its key", () => {
  it("for the explain button as for the first-run sheet", () => {
    expect(providerUnusable("needs-key")).toBe(true);
    expect(providerUnusable("needs-signin")).toBe(true);
    for (const ready of ["ready", "signed-in", "local", undefined])
      expect(providerUnusable(ready)).toBe(false);
    const app = stripComments(read("../App.tsx", import.meta.url));
    expect(app).toMatch(/!providerUnusable\(providerStatus\[serverCfg\.provider\]\)/);
  });
});

describe("the Copilot install line has one spelling", () => {
  it("the web's is the one the Java runtime lookup names", () => {
    const java = read(
      "../../../spectro-core/src/main/java/dev/spectroscope/core/copilot/CopilotRuntime.java",
      import.meta.url,
    );
    const declared = /String INSTALL_LINE = "([^"]+)";/.exec(java);
    expect(declared, "CopilotRuntime.java no longer declares INSTALL_LINE").not.toBeNull();
    expect(COPILOT_INSTALL_LINE).toBe(declared![1]);
  });
  it("no other source file under src/ spells it", () => {
    const spelled = srcFiles()
      .filter((f) => !/\.test\.tsx?$/.test(f) && !f.endsWith("copilotAccount.ts"))
      .filter((f) => srcText(f).includes("copilot-cli"));
    expect(spelled).toEqual([]);
  });
  it("the first-run option and the settings note show it", () => {
    for (const lang of ["en", "de"] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(<Onboarding open onClose={() => {}} />);
      const at = html.indexOf(">copilot<");
      expect(html.slice(at, html.indexOf("</li>", at))).toContain(COPILOT_INSTALL_LINE);
      expect(renderToStaticMarkup(<CopilotSettingsNote provider="copilot" lang={lang} />)).toContain(
        COPILOT_INSTALL_LINE,
      );
    }
  });
});

describe("the first-run sheet's words", () => {
  it("the intro and the copilot option carry no dash", () => {
    for (const lang of ["en", "de"] as const) {
      setLang(lang);
      const html = renderToStaticMarkup(<Onboarding open onClose={() => {}} />);
      const intro = html.slice(
        html.indexOf('class="ob-intro"'),
        html.indexOf("</p>", html.indexOf('class="ob-intro"')),
      );
      expect(intro.length).toBeGreaterThan(40);
      expect(intro).not.toMatch(/[\u2013\u2014]/);
      const at = html.indexOf(">copilot<");
      expect(html.slice(at, html.indexOf("</li>", at))).not.toMatch(/[\u2013\u2014]/);
    }
  });
});
