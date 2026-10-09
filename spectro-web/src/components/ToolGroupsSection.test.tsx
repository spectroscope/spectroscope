// Card 466, criterion 3: what the tool-group section of the composer gear
// draws. Rendered with react-dom/server like the other view suites, no DOM.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ToolGroupsSection } from "./ToolGroupsSection";
import type { ToolGroupsInfo } from "../state/toolGroups";
import { dict, t } from "../i18n/i18n";
import { blockOf, stripComments, read } from "../testkit/source";
import { SETTING_REACH } from "./settingsReach";
import { SURFACES } from "../state/surfaces";

const info: ToolGroupsInfo = {
  off: ["launch"],
  groups: [
    { name: "browser", tools: ["browser_click", "browser_read_page"] },
    { name: "launch", tools: ["launch_list", "launch_start"] },
    { name: "images", tools: ["generate_image", "view_image"] },
    { name: "web", tools: ["web_fetch"] },
    { name: "agents", tools: ["spawn_agent"] },
    { name: "roles", tools: ["develop"] },
    { name: "mcp", tools: [] },
  ],
};

function render(over: Partial<ToolGroupsInfo> | null, lang: "en" | "de" = "en", saved = true): string {
  return renderToStaticMarkup(
    <ToolGroupsSection
      lang={lang}
      info={over === null ? null : { ...info, ...over }}
      saved={saved}
      onChange={() => {}}
    />,
  );
}

describe("the tool groups section", () => {
  it("draws one checkbox per group the server named, in its order", () => {
    const html = render({});
    const boxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)];
    expect(boxes).toHaveLength(7);
    const order = ["browser", "launch", "images", "web", "agents", "roles", "mcp"].map((name) =>
      html.indexOf(`>${name}<`),
    );
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("checks the groups that are sent and leaves the switched-off one unchecked", () => {
    const html = render({});
    const box = (name: string): string => {
      const match = html.match(new RegExp(`<input type="checkbox"[^>]*data-group="${name}"[^>]*>`));
      if (match === null) throw new Error(`no checkbox for ${name}`);
      return match[0];
    };
    expect(box("browser")).toContain('checked=""');
    expect(box("launch")).not.toContain("checked");
  });

  it("names the tools of each group as its hint", () => {
    const html = render({});
    expect(html).toContain("browser_click, browser_read_page");
    expect(html).toContain("generate_image, view_image");
    expect(html).toContain(t("en", "wsg.tools.none"));
  });

  it("says what unchecking a group does, in both languages", () => {
    expect(render({})).toContain(t("en", "wsg.tools.note"));
    expect(render({}, "de")).toContain(t("de", "wsg.tools.note"));
    expect(t("de", "wsg.tools.note")).not.toBe(t("en", "wsg.tools.note"));
  });

  it("tags the section local only where a change is saved there", () => {
    expect(render({}, "en", true)).toContain(t("en", "wsg.local.scope"));
    expect(render({}, "en", false)).not.toContain(t("en", "wsg.local.scope"));
    expect(render({}, "en", false)).toContain('data-group="browser"');
  });

  it("says the choice is not saved when there is no folder to save it in", () => {
    expect(render({}, "en", false)).toContain(t("en", "wsg.tools.unsaved"));
    expect(render({}, "de", false)).toContain(t("de", "wsg.tools.unsaved"));
    expect(t("de", "wsg.tools.unsaved")).not.toBe(t("en", "wsg.tools.unsaved"));
    expect(render({}, "en", true)).not.toContain(t("en", "wsg.tools.unsaved"));
  });

  it("draws nothing before the server has said what the groups are", () => {
    expect(render(null)).toBe("");
  });
});

describe("when a change in the gear acts", () => {
  // Card 491, criterion 4. The sentence comes from the reach table, not from a
  // string of this section, so the gear and the reference chapter cannot say
  // two different things about the same key.
  it("shows the reach of the tool groups in words, in both languages", () => {
    expect(SETTING_REACH.toolGroupsOff).toBe("next-run");
    for (const lang of ["en", "de"] as const) {
      const html = render({}, lang);
      expect(html).toContain('data-reach="next-run"');
      expect(html).toContain('data-reach-fields="toolGroupsOff"');
      expect(html).toContain(t(lang, "set.reachNextRun"));
    }
    expect(render({})).toContain("Applies from the next run");
  });

  it("shows it with and without a pinned folder", () => {
    expect(render({}, "en", false)).toContain(t("en", "set.reachNextRun"));
    expect(render({}, "en", true)).toContain(t("en", "set.reachNextRun"));
  });

  it("is in the gear in learn and in light", () => {
    // The gear sits in the chat's composer row, and the chat is open in both
    // modes. Neither the chat's mount of the gear nor the gear's mount of this
    // section asks the mode, so the sentence is drawn in both.
    expect(SURFACES.chat.modes).toEqual({ learn: "open", light: "open" });
    const chat = stripComments(read("./Chat.tsx", import.meta.url));
    const gear = stripComments(read("./ComposerGear.tsx", import.meta.url));
    expect(chat).toContain("<ComposerGear");
    expect(gear).toContain("<ToolGroupsSection");
    for (const [name, source] of [
      ["Chat.tsx", chat],
      ["ComposerGear.tsx", gear],
      ["ToolGroupsSection.tsx", stripComments(read("./ToolGroupsSection.tsx", import.meta.url))],
    ] as const) {
      expect(source, `${name} reads the view mode`).not.toMatch(/viewMode|ViewMode/);
    }
  });
});

describe("the tool group rows", () => {
  // Measured live on 2026-10-09: with the hint wrapping, the seven rows took
  // 497 px in a popover capped at 480 px, so no reader ever saw all seven at
  // once. One line per hint, cut with an ellipsis; the full list stays in the
  // hint's title.
  it("keep each hint on one line so the seven groups fit the popover", () => {
    const css = read("../styles/workspace-gear.css", import.meta.url);
    const hint = blockOf(css, ".wsg-tool-group-label .wsg-mode-hint");
    expect(hint).toMatch(/white-space:\s*nowrap/);
    expect(hint).toMatch(/overflow:\s*hidden/);
    expect(hint).toMatch(/text-overflow:\s*ellipsis/);
    // The ellipsis needs the flex item around the hint to be allowed to shrink.
    const body = blockOf(css, ".wsg-mode-body");
    expect(body).toMatch(/min-width:\s*0/);
  });

  it("keeps the full tool list in the hint's title", () => {
    const html = renderToStaticMarkup(<ToolGroupsSection lang="en" info={info} saved onChange={() => {}} />);
    expect(html).toContain('title="browser_click, browser_read_page"');
  });
});

describe("a save that did not happen", () => {
  it("shows the server's reason in the gear's error line, in both languages", () => {
    const en = render({ saveError: "the folder does not exist yet" });
    expect(en).toContain('class="settings-error wsg-inline-error"');
    expect(en).toContain(t("en", "wsg.tools.saveFailed", { reason: "the folder does not exist yet" }));
    const de = render({ saveError: "the folder does not exist yet" }, "de");
    expect(de).toContain(t("de", "wsg.tools.saveFailed", { reason: "the folder does not exist yet" }));
  });

  it("shows no error line when the last save worked", () => {
    expect(render({})).not.toContain("wsg-inline-error");
  });
});

describe("every string the section shows", () => {
  // Read from the section's own source, so a string added tomorrow is checked
  // without an edit here.
  const keys = [...read("./ToolGroupsSection.tsx", import.meta.url).matchAll(/t\(lang, "([^"]+)"/g)].map(
    (match) => match[1],
  );

  it("is found in the section's source", () => {
    expect(keys.length).toBeGreaterThanOrEqual(6);
  });

  it("has a German and an English entry", () => {
    for (const key of keys) {
      expect(dict[key], key).toBeDefined();
      expect(dict[key].de.trim(), `${key} de`).not.toBe("");
      expect(dict[key].en.trim(), `${key} en`).not.toBe("");
    }
  });
});
