// Card 493, criteria 1, 4, 7 and 10: what the Local mode row at the top of the
// composer gear draws. Rendered with react-dom/server like the other view
// suites, no DOM.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalModeSection } from "./LocalModeSection";
import type { LocalModeInfo, ToolUseAnswer } from "../state/localMode";
import { t } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

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
