// Card 430, criterion 4: in light a fleet scenario is refused, so the picker
// does not offer the fleet tab, and its hint says where a chat run opens.

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dict } from "../i18n/i18n";
import { __resetViewModeForTests, __setViewModeStorage, setViewMode } from "../state/viewMode";
import { ScenarioDialog } from "./ScenarioDialog";

beforeEach(() => {
  const store = new Map<string, string>();
  __setViewModeStorage({ get: (k) => store.get(k) ?? null, set: (k, v) => void store.set(k, v) });
  __resetViewModeForTests();
});
afterEach(() => setViewMode("learn"));

const tabs = (html: string): string[] => [...html.matchAll(/role="tab"[^>]*>([^<]+)</g)].map((m) => m[1]);

describe("the scenario picker in light", () => {
  it("offers the chats alone and says the run opens in the chat", () => {
    setViewMode("light");
    const html = renderToStaticMarkup(<ScenarioDialog onPick={() => {}} onClose={() => {}} />);
    expect(tabs(html)).toEqual([dict["scn.tab.chats"].en]);
    expect(html).toContain(dict["scn.hintLight"].en);
    expect(html).not.toContain(dict["scn.hint"].en);
  });

  it("offers both tabs and the lab hint in learn (twin)", () => {
    const html = renderToStaticMarkup(<ScenarioDialog onPick={() => {}} onClose={() => {}} />);
    expect(tabs(html)).toEqual([dict["scn.tab.chats"].en, dict["scn.tab.fleet"].en]);
    expect(html).toContain(dict["scn.hint"].en);
  });
});
