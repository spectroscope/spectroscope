// Card 503, criterion 10: the agentMessaging switch in the composer's settings
// menu, on the model of the rtk section. Server renderer, no DOM.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentMessagingSection } from "./AgentMessagingSection";
import { agentMessagingNext, agentMessagingOf, type AgentMessagingState } from "../state/agentMessaging";
import { dict, t } from "../i18n/i18n";
import { OFF_PAGE_SETTING_KEYS } from "./settingsSearch";
import { SETTING_REACH } from "./settingsReach";
import { read } from "../testkit/source";

const noop = (): void => {};

function render(over: Partial<AgentMessagingState>, lang: "en" | "de" = "en"): string {
  const state: AgentMessagingState = { on: true, error: null, setOn: noop, setError: noop, ...over };
  return renderToStaticMarkup(<AgentMessagingSection lang={lang} messaging={state} />);
}

function escaped(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

describe("the agent messaging section", () => {
  it("draws the switch on, with what on does", () => {
    const html = render({ on: true });
    expect(html).toContain(escaped(t("en", "am.title")));
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain(escaped(t("en", "am.on.hint")));
  });

  it("draws the switch off, with what off does", () => {
    const html = render({ on: false });
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain(escaped(t("en", "am.off.hint")));
  });

  it("says in both languages that a helper writes only to the main agent, where the chat shows it", () => {
    // Hub and spoke (owner, 2026-10-12): helpers never message each other.
    expect(t("en", "am.on.hint")).toContain("A helper writes only to the main agent");
    expect(t("de", "am.on.hint")).toContain("Ein Helfer schreibt nur dem Hauptagenten");
    expect(t("en", "am.on.hint")).toContain("the chat shows every message");
    expect(t("de", "am.on.hint")).toContain("der Chat zeigt jede Nachricht");
  });

  it("says when a save was refused", () => {
    expect(render({ error: "disk full" })).toContain("disk full");
  });

  it("carries a reach block for agentMessaging, which acts from the next run", () => {
    expect(SETTING_REACH.agentMessaging).toBe("next-run");
    expect(OFF_PAGE_SETTING_KEYS.agentMessaging).toBe("AgentMessagingSection.tsx");
    expect(read("./AgentMessagingSection.tsx", import.meta.url)).toContain('fields={["agentMessaging"]}');
  });

  it("speaks German and English for every key it uses", () => {
    for (const key of ["am.title", "am.on", "am.off", "am.on.hint", "am.off.hint", "am.saveFailed"]) {
      expect(dict[key]?.de, key).toBeTruthy();
      expect(dict[key]?.en, key).toBeTruthy();
    }
    expect(render({ on: true }, "de")).toContain(escaped(t("de", "am.title")));
  });

  it("saves the opposite of what it shows, and reads anything but false as on", () => {
    expect(agentMessagingNext(true)).toBe(false);
    expect(agentMessagingNext(false)).toBe(true);
    expect(agentMessagingOf({ agentMessaging: false })).toBe(false);
    expect(agentMessagingOf({ agentMessaging: true })).toBe(true);
    expect(agentMessagingOf({})).toBe(true);
  });

  it("is mounted in the composer's settings menu", () => {
    const menu = read("./DisclosureMenu.tsx", import.meta.url);
    expect(menu).toContain("<AgentMessagingSection");
  });
});
