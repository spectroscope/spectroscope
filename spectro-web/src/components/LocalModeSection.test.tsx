// Card 493, criteria 1, 4, 7 and 10: what the Local mode row at the top of the
// composer gear draws. Rendered with react-dom/server like the other view
// suites, no DOM.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalModeSection } from "./LocalModeSection";
import type { LocalModeInfo, ToolUseAnswer } from "../state/localMode";
import { dict, t } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";
import {
  saveToolResultCache,
  toolResultCacheOf,
  toolResultCacheValue,
  type ToolResultCacheState,
} from "../state/toolResultCache";
import { drive, type El } from "../testkit/driveComponent";
import { ReachBlock } from "./settingsReach";
import { OFF_PAGE_SETTING_KEYS } from "./settingsSearch";
import { SETTING_REACH } from "./settingsReach";

// Card 600, fix round 1: the save path of the cache switch, without a server.
const putSettings = vi.fn((..._args: unknown[]): Promise<unknown> => Promise.resolve({}));
vi.mock("../state/serverSettings", async (original) => ({
  ...(await original<typeof import("../state/serverSettings")>()),
  putSettings: (...args: unknown[]) => putSettings(...args),
  fetchSettings: () => new Promise(() => {}),
}));

const PRESET_GROUPS = ["browser", "launch", "images", "roles"];

const onInfo: LocalModeInfo = {
  on: true,
  rows: [
    { key: "sessionsPerChat", value: 3, preset: 3, changed: false, floor: 2 },
    { key: "toolGroupsOff", value: PRESET_GROUPS, preset: PRESET_GROUPS, changed: false, floor: null },
    { key: "readSharePercent", value: 10, preset: 10, changed: false, floor: 1 },
    { key: "careParagraph", value: "on", preset: "on", changed: false, floor: null },
  ],
};

function render(
  info: LocalModeInfo | null,
  lang: "en" | "de" = "en",
  toolUse: ToolUseAnswer | null = null,
): string {
  return renderToStaticMarkup(
    <LocalModeSection
      lang={lang}
      info={info}
      toolUse={toolUse}
      model="some-model"
      onSwitch={() => {}}
      onEdit={() => {}}
      onReset={() => {}}
    />,
  );
}

const rowOf = (html: string, key: string): string => {
  const match = html.match(new RegExp(`<li[^>]*data-local-key="${key}"[^>]*>[\\s\\S]*?</li>`));
  if (match === null) throw new Error(`no row ${key} in ${html}`);
  return match[0];
};

describe("the Local mode switch", () => {
  it("is one switch, off by default, with no rows below it", () => {
    const html = render({ ...onInfo, on: false });
    expect(html).toContain(t("en", "wsg.lm.title"));
    expect(html).toMatch(/<input type="checkbox" role="switch"[^>]*>/);
    expect(html).not.toMatch(/role="switch"[^>]*checked/);
    expect(html).not.toContain("data-local-key=");
  });

  it("opens the four rows of the concept when it is on, in the card's order", () => {
    const html = render(onInfo);
    expect(html).toMatch(/role="switch"[^>]*checked=""/);
    const order = ["sessionsPerChat", "toolGroupsOff", "readSharePercent", "careParagraph"].map((key) =>
      html.indexOf(`data-local-key="${key}"`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(rowOf(html, "sessionsPerChat")).toContain('value="3"');
    expect(rowOf(html, "sessionsPerChat")).toContain('min="2"');
    expect(rowOf(html, "toolGroupsOff")).toContain("browser, launch, images, roles");
    expect(rowOf(html, "readSharePercent")).toContain('value="10"');
    expect(rowOf(html, "readSharePercent")).toContain('min="1"');
    expect(rowOf(html, "careParagraph")).toMatch(/type="checkbox"[^>]*checked=""/);
  });

  it("says the read share is a proposal nobody has measured", () => {
    expect(rowOf(render(onInfo), "readSharePercent")).toContain(t("en", "wsg.lm.readShareProposal"));
    expect(rowOf(render(onInfo, "de"), "readSharePercent")).toContain(t("de", "wsg.lm.readShareProposal"));
  });

  it("marks an edited row changed, with a reset to the preset value", () => {
    const edited: LocalModeInfo = {
      ...onInfo,
      rows: onInfo.rows.map((row) =>
        row.key === "sessionsPerChat" ? { ...row, value: 2, changed: true } : row,
      ),
    };
    const html = render(edited);
    expect(rowOf(html, "sessionsPerChat")).toContain(t("en", "wsg.lm.changed"));
    expect(rowOf(html, "sessionsPerChat")).toContain(t("en", "wsg.lm.reset", { value: "3" }));
    expect(rowOf(html, "readSharePercent")).not.toContain(t("en", "wsg.lm.changed"));
    expect(rowOf(html, "readSharePercent")).not.toContain("wsg-lm-reset");
  });

  it("says the tool groups changed from Local mode when the chat's own list replaces the preset", () => {
    const own: LocalModeInfo = {
      ...onInfo,
      rows: onInfo.rows.map((row) =>
        row.key === "toolGroupsOff" ? { ...row, value: ["browser"], changed: true } : row,
      ),
    };
    const row = rowOf(render(own), "toolGroupsOff");
    expect(row).toContain(t("en", "wsg.lm.changedFromLocal"));
    expect(row).toContain(">browser<");
  });

  it("warns when the model cannot call tools, and only then", () => {
    const no = render(onInfo, "en", { toolUse: "no", source: "lmstudio" });
    expect(no).toContain(t("en", "wsg.lm.noTools", { model: "some-model" }));
    expect(render(onInfo, "en", { toolUse: "yes", source: "ollama" })).not.toContain("wsg-lm-warning");
    expect(render(onInfo, "en", { toolUse: "unknown", source: "none" })).not.toContain("wsg-lm-warning");
    expect(render({ ...onInfo, on: false }, "en", { toolUse: "no", source: "lmstudio" })).not.toContain(
      "wsg-lm-warning",
    );
    expect(render(onInfo, "de", { toolUse: "no", source: "lmstudio" })).toContain(
      t("de", "wsg.lm.noTools", { model: "some-model" }),
    );
  });

  it("speaks both languages", () => {
    for (const key of [
      "wsg.lm.title",
      "wsg.lm.hint",
      "wsg.lm.sessions",
      "wsg.lm.toolGroups",
      "wsg.lm.readShare",
      "wsg.lm.care",
    ]) {
      expect(t("de", key)).not.toBe(t("en", key));
      expect(render(onInfo, "de")).toContain(t("de", key));
    }
  });

  it("draws nothing before the server has said what the switch holds", () => {
    expect(render(null)).toBe("");
  });

  it("is the first section of the gear", () => {
    const gear = stripComments(read("./ComposerGear.tsx", import.meta.url));
    expect(gear).toContain("<LocalModeSection");
    expect(gear.indexOf("<LocalModeSection")).toBeLessThan(gear.indexOf('t(lang, "wsg.modeTitle")'));
  });
});

// ---- card 600: the tool results cache switch under Local mode ---------------

const noop = (): void => {};

function renderCache(
  info: LocalModeInfo,
  over: Partial<ToolResultCacheState>,
  lang: "en" | "de" = "en",
): string {
  const cache: ToolResultCacheState = {
    on: false,
    known: true,
    readError: null,
    error: null,
    setOn: noop,
    setError: noop,
    ...over,
  };
  return renderToStaticMarkup(
    <LocalModeSection
      lang={lang}
      info={info}
      toolUse={null}
      model="some-model"
      onSwitch={() => {}}
      onEdit={() => {}}
      onReset={() => {}}
      cache={cache}
    />,
  );
}

/** The cache block, cut out of the section by its own marker. */
const cacheOf = (html: string): string => {
  const match = html.match(/<div class="wsg-lm-cache"[\s\S]*$/);
  if (match === null) throw new Error(`no cache switch in ${html}`);
  return match[0];
};

describe("the tool results cache switch", () => {
  it("carries the label the owner asked for, and a German twin", () => {
    expect(t("en", "wsg.lm.cacheTitle")).toBe("Optimize tool results cache (use with cloud models only)");
    expect(t("de", "wsg.lm.cacheTitle")).toBe(
      "Cache für Werkzeugergebnisse optimieren (nur mit Cloud-Modellen nutzen)",
    );
    for (const key of ["wsg.lm.cacheTitle", "wsg.lm.cacheNote"]) {
      expect(dict[key]?.de, key).toBeTruthy();
      expect(dict[key]?.en, key).toBeTruthy();
      expect(t("de", key)).not.toBe(t("en", key));
    }
  });

  it("stands in the Local mode section under its switch, whether Local mode is on or off", () => {
    for (const info of [onInfo, { ...onInfo, on: false }]) {
      const html = renderCache(info, {});
      expect(html.indexOf('class="wsg-lm-cache"')).toBeGreaterThan(html.indexOf(t("en", "wsg.lm.title")));
      expect(html.indexOf("wsg-local-mode")).toBeLessThan(html.indexOf('class="wsg-lm-cache"'));
    }
  });

  it("explains that on shortens old results in every request, saves tokens with cloud models and breaks a local model's cache", () => {
    expect(t("en", "wsg.lm.cacheNote")).toContain("shortens old, large tool results in every request");
    expect(t("en", "wsg.lm.cacheNote")).toContain("saves tokens with cloud models");
    expect(t("en", "wsg.lm.cacheNote")).toContain("breaks the prompt cache of local models");
    expect(t("de", "wsg.lm.cacheNote")).toContain("alte, große Werkzeugergebnisse in jeder Anfrage");
    expect(t("de", "wsg.lm.cacheNote")).toContain("spart Tokens bei Cloud-Modellen");
    expect(t("de", "wsg.lm.cacheNote")).toContain("bricht den Prompt-Cache lokaler Modelle");
  });

  it("shows its label and its note in English and in German", () => {
    for (const lang of ["en", "de"] as const) {
      const block = cacheOf(renderCache(onInfo, {}, lang));
      expect(block).toContain(t(lang, "wsg.lm.cacheTitle"));
      expect(block).toContain(t(lang, "wsg.lm.cacheNote"));
    }
  });

  it("draws the switch off when the setting is off and on when it is on", () => {
    const off = cacheOf(renderCache(onInfo, { on: false }));
    expect(off).toMatch(/<input type="checkbox" role="switch"[^>]*>/);
    expect(off).not.toMatch(/role="switch"[^>]*checked/);
    const on = cacheOf(renderCache(onInfo, { on: true }));
    expect(on).toMatch(/role="switch"[^>]*checked=""/);
  });

  it("says when a save was refused", () => {
    expect(cacheOf(renderCache(onInfo, { error: "disk full" }))).toContain("disk full");
  });

  it("carries a reach block for toolResultElision, which acts from the next session", () => {
    expect(SETTING_REACH.toolResultElision).toBe("next-session");
    expect(OFF_PAGE_SETTING_KEYS.toolResultElision).toBe("LocalModeSection.tsx");
    expect(cacheOf(renderCache(onInfo, {}))).toContain('data-reach-fields="toolResultElision"');
  });

  it("reads only on as on, and saves on or off", () => {
    expect(toolResultCacheOf({ toolResultElision: "on" })).toBe(true);
    expect(toolResultCacheOf({ toolResultElision: "off" })).toBe(false);
    expect(toolResultCacheOf({})).toBe(false);
    expect(toolResultCacheValue(true)).toBe("on");
    expect(toolResultCacheValue(false)).toBe("off");
  });

  it("is read by the gear when it opens and handed to the section", () => {
    const gear = stripComments(read("./ComposerGear.tsx", import.meta.url));
    expect(gear).toContain("useToolResultCache(open)");
    expect(gear).toMatch(/<LocalModeSection[\s\S]*?cache=\{toolResultCache\}/);
  });
});

describe("the tool results cache switch, fix round 1", () => {
  beforeEach(() => {
    putSettings.mockReset();
    putSettings.mockImplementation(() => Promise.resolve({}));
  });

  const settle = () => new Promise((r) => setTimeout(r, 0));

  function recorder(): ToolResultCacheState & { ons: boolean[]; errors: (string | null)[] } {
    const ons: boolean[] = [];
    const errors: (string | null)[] = [];
    return {
      on: false,
      known: true,
      readError: null,
      error: null,
      setOn: (next) => ons.push(next),
      setError: (message) => errors.push(message),
      ons,
      errors,
    };
  }

  it("saves on and off to the user settings under toolResultElision", async () => {
    const state = recorder();
    saveToolResultCache(true, state);
    saveToolResultCache(false, state);
    await settle();

    expect(putSettings.mock.calls).toEqual([
      ["user", { toolResultElision: "on" }],
      ["user", { toolResultElision: "off" }],
    ]);
    expect(state.ons).toEqual([true, false]);
    expect(state.errors).toEqual([null, null]);
  });

  it("puts the box back and keeps the reason when the save is refused", async () => {
    putSettings.mockImplementation(() => Promise.reject(new Error("disk full")));
    const state = recorder();
    saveToolResultCache(true, state);
    await settle();

    expect(state.ons).toEqual([true, false]);
    expect(state.errors).toEqual([null, "disk full"]);
  });

  it("saves through the box's onChange", async () => {
    const cache = recorder();
    const box = (tree: El[]): El => {
      const found = tree.filter(
        (el) => el.type === "input" && el.props["aria-label"] === t("en", "wsg.lm.cacheTitle"),
      );
      if (found.length !== 1) throw new Error(`expected one cache box, found ${found.length}`);
      return found[0];
    };
    drive(
      <LocalModeSection
        lang="en"
        info={onInfo}
        toolUse={null}
        model="some-model"
        onSwitch={() => {}}
        onEdit={() => {}}
        onReset={() => {}}
        cache={cache}
      />,
      [LocalModeSection, ReachBlock],
      [
        (tree) =>
          (box(tree).props.onChange as unknown as (e: { target: { checked: boolean } }) => void)({
            target: { checked: true },
          }),
      ],
    );
    await settle();

    expect(putSettings.mock.calls).toEqual([["user", { toolResultElision: "on" }]]);
    expect(cache.ons).toEqual([true]);
  });

  it("is disabled, not unchecked, while the setting is unknown, and says why when the read failed", () => {
    const failed = cacheOf(renderCache(onInfo, { known: false, readError: "HTTP 500" }));
    expect(failed).toMatch(/role="switch"[^>]*disabled=""/);
    expect(failed).toContain(t("en", "wsg.lm.cacheReadFailed", { reason: "HTTP 500" }));
    expect(cacheOf(renderCache(onInfo, { known: false, readError: "HTTP 500" }, "de"))).toContain(
      t("de", "wsg.lm.cacheReadFailed", { reason: "HTTP 500" }),
    );
    expect(cacheOf(renderCache(onInfo, { known: false }))).toMatch(/role="switch"[^>]*disabled=""/);
    const known = cacheOf(renderCache(onInfo, { known: true }));
    expect(known).toMatch(/<input type="checkbox" role="switch"[^>]*>/);
    expect(known).not.toMatch(/role="switch"[^>]*disabled/);
  });

  it("follows the gear's error wording in both languages", () => {
    expect(t("en", "wsg.lm.cacheReadFailed", { reason: "x" })).toBe("Not read: x");
    expect(t("de", "wsg.lm.cacheReadFailed", { reason: "x" })).toBe("Nicht gelesen: x");
    expect(t("en", "wsg.tools.saveFailed", { reason: "x" })).toBe("Not saved: x");
  });

  it("is quoted in the guide's config reference exactly as the English label reads", () => {
    const part = read("../../../docs/guide-assets/parts/18-ref-config-build.html", import.meta.url);
    const row = part.match(/<tr><td><code>toolResultElision<\/code>[\s\S]*?<\/tr>/);
    expect(row, "the guide has no toolResultElision row").not.toBeNull();
    expect((row as RegExpMatchArray)[0]).toContain(`<b>${t("en", "wsg.lm.cacheTitle")}</b>`);
  });
});
