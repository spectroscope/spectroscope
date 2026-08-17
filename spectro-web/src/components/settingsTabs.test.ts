// Card 256: the settings stop being one scroll of nineteen blocks. The grouping
// that ends that is DATA — one table — so it is pinned as a fold: every section
// the page draws stands in exactly one room, no room is empty, and the two ids a
// room needs in the DOM are stable strings rather than whatever the panel
// happened to write.
//
// The consumer pins at the end are not decoration. A pure fold nobody consults
// ships dead (the fileTabs lesson, card 249), and this one has a second failure
// mode a screenshot review does not catch: the pages are HIDDEN, not unmounted,
// because unmounting them would re-run every sub-block's fetch on each tab
// click. That contract lives half in the panel's JSX and half in one CSS rule,
// and both halves are checked here.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_TAB,
  RELOCATED_SECTIONS,
  SETTINGS_TABS,
  SETTINGS_TAB_SECTIONS,
  sectionsOfTab,
  settingsTabButtonId,
  settingsTabFor,
  settingsTabLabelKey,
  settingsTabPanelId,
  stepSettingsTab,
  tabOfSection,
  type SettingsTab,
} from "./settingsTabs";
import { SETTINGS_SECTIONS, type SettingsSection } from "../state/route";
import { sectionAnchorId } from "./SettingsPanel";
import { dict } from "../i18n/i18n";
import { read, stripComments } from "../testkit/source";

const grouped: readonly SettingsSection[] = SETTINGS_TABS.flatMap(
  (tab) => sectionsOfTab(tab) as readonly SettingsSection[],
);

describe("the grouping is one total table", () => {
  it("gives every section the page draws exactly one room", () => {
    const counts = new Map<string, number>();
    for (const section of grouped) counts.set(section, (counts.get(section) ?? 0) + 1);
    for (const [section, n] of counts) {
      expect(n, `${section} stands in ${n} rooms`).toBe(1);
    }
    // The fence of this card: moving rooms may not lose furniture. Every
    // address the route vocabulary knows is either a room's section or one of
    // the deliberately relocated ones — nothing falls between the two.
    const relocated = new Set<string>(RELOCATED_SECTIONS);
    for (const section of SETTINGS_SECTIONS) {
      if (relocated.has(section)) continue;
      expect(counts.get(section), `${section} has no room on the settings page`).toBe(1);
    }
    expect(grouped).toHaveLength(SETTINGS_SECTIONS.length - RELOCATED_SECTIONS.length);
  });

  it("keeps the relocated sections roomless — they live on another surface", () => {
    // Card 228 moved the skills manager to the rail's Skills view and App.tsx
    // redirects the old hashes there. A room for them here would draw an empty
    // page under a label that promises a manager.
    for (const section of RELOCATED_SECTIONS) {
      expect(tabOfSection(section)).toBeNull();
      expect(grouped).not.toContain(section);
    }
  });

  it("has no empty room", () => {
    for (const tab of SETTINGS_TABS) {
      expect(sectionsOfTab(tab).length, `the ${tab} tab draws nothing`).toBeGreaterThan(0);
    }
    expect(Object.keys(SETTINGS_TAB_SECTIONS).sort()).toEqual([...SETTINGS_TABS].sort());
  });

  it("answers the section a deep link named with the room that holds it", () => {
    // Card 224's callers hand over a section, not a tab. The mapping is the
    // whole reason a deep link still lands after this move.
    expect(tabOfSection("session")).toBe("models");
    expect(tabOfSection("hooks")).toBe("permissions");
    expect(tabOfSection("mcp")).toBe("mcp");
    expect(tabOfSection("design")).toBe("general");
    for (const tab of SETTINGS_TABS) {
      for (const section of sectionsOfTab(tab)) {
        expect(tabOfSection(section)).toBe(tab);
      }
    }
  });

  it("opens the default room for a plain open, and never nowhere", () => {
    expect(settingsTabFor(null)).toBe(DEFAULT_SETTINGS_TAB);
    expect(settingsTabFor(undefined)).toBe(DEFAULT_SETTINGS_TAB);
    // A relocated hash that reaches this panel anyway lands on a real page
    // rather than on a blank one — the card-81 direction: forgiving in, strict
    // out.
    for (const section of RELOCATED_SECTIONS) {
      expect(settingsTabFor(section)).toBe(DEFAULT_SETTINGS_TAB);
    }
    for (const section of SETTINGS_SECTIONS) {
      expect(SETTINGS_TABS).toContain(settingsTabFor(section));
    }
  });
});

describe("the ids a room needs in the DOM", () => {
  it("are stable strings, one per room, and per role", () => {
    expect(settingsTabButtonId("models")).toBe("settings-tab-models");
    expect(settingsTabPanelId("models")).toBe("settings-page-models");
    const ids = SETTINGS_TABS.flatMap((tab) => [settingsTabButtonId(tab), settingsTabPanelId(tab)]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never collides with a section anchor", () => {
    // Both live inside the same panel, and a duplicate id would send
    // scrollIntoView at a tab button.
    const anchors = new Set(SETTINGS_SECTIONS.map((s) => sectionAnchorId(s)));
    for (const tab of SETTINGS_TABS) {
      expect(anchors.has(settingsTabButtonId(tab))).toBe(false);
      expect(anchors.has(settingsTabPanelId(tab))).toBe(false);
    }
  });
});

describe("arrow keys move along the row", () => {
  it("steps right and left", () => {
    expect(stepSettingsTab("general", 1)).toBe(SETTINGS_TABS[1]);
    expect(stepSettingsTab(SETTINGS_TABS[1], -1)).toBe("general");
  });

  it("wraps at both ends, so the row has no dead end", () => {
    const last = SETTINGS_TABS[SETTINGS_TABS.length - 1] as SettingsTab;
    expect(stepSettingsTab(last, 1)).toBe(SETTINGS_TABS[0]);
    expect(stepSettingsTab(SETTINGS_TABS[0], -1)).toBe(last);
  });

  it("stands still for a delta of nothing", () => {
    for (const tab of SETTINGS_TABS) {
      expect(stepSettingsTab(tab, 0)).toBe(tab);
    }
  });
});

describe("the labels come from the dictionary", () => {
  it("has a German and an English word for every room", () => {
    for (const tab of SETTINGS_TABS) {
      const entry = dict[settingsTabLabelKey(tab)];
      expect(entry, `${settingsTabLabelKey(tab)} is missing from the dictionary`).toBeDefined();
      expect(entry?.de).toBeTruthy();
      expect(entry?.en).toBeTruthy();
    }
  });

  it("labels the rooms distinctly in both languages", () => {
    for (const lang of ["de", "en"] as const) {
      const labels = SETTINGS_TABS.map((tab) => dict[settingsTabLabelKey(tab)]?.[lang]);
      expect(new Set(labels).size, `two rooms share a ${lang} label`).toBe(labels.length);
    }
  });

  it("keeps the labels short enough that six of them cannot need a second line", () => {
    // The row must not wrap at the app's minimum width (AC 2). The row scrolls
    // rather than wraps by construction (the CSS pin below), and the labels stay
    // room-sized so the scroll is never needed on the panel's own 680px.
    for (const lang of ["de", "en"] as const) {
      for (const tab of SETTINGS_TABS) {
        const label = dict[settingsTabLabelKey(tab)]?.[lang] ?? "";
        expect(label.length, `the ${lang} label of ${tab} is a sentence, not a room name`).toBeLessThan(16);
      }
    }
  });
});

describe("the consumer — the panel is a tablist over this table", () => {
  const panel = stripComments(read("./SettingsPanel.tsx", import.meta.url));
  const css = stripComments(read("../styles/settings-trace.css", import.meta.url));

  it("draws the row from the table, with real tablist semantics", () => {
    expect(panel).toContain('role="tablist"');
    expect(panel).toContain('role="tab"');
    expect(panel).toContain('role="tabpanel"');
    expect(panel).toContain("SETTINGS_TABS.map(");
    expect(panel).toContain("settingsTabLabelKey(");
    expect(panel).toContain("aria-selected={");
    expect(panel).toContain("aria-controls={settingsTabPanelId(");
    expect(panel).toContain("aria-labelledby={settingsTabButtonId(");
  });

  it("moves with the arrow keys and leaves with Escape", () => {
    expect(panel).toContain("stepSettingsTab(");
    expect(panel).toContain('"ArrowRight"');
    expect(panel).toContain('"ArrowLeft"');
    expect(panel).toContain('e.key === "Escape"');
  });

  it("selects the tab a deep-linked section stands in, then scrolls to it", () => {
    // Card 224's rows and every #/settings/{section} bookmark. Selecting the
    // room has to happen for the anchor to be visible at all: scrollIntoView on
    // a hidden page is a silent no-op that marks itself done.
    //
    // The panel used to read `settingsTabFor(section)` here itself, and that is
    // exactly where the repeat-deep-link regression sat: the answer was correct
    // and a remembered room outranked it. Both halves — which room, and whether
    // the scroll may fire from the room on screen — now come from the position
    // fold in settingsRoom.ts, whose own guard walks a full visit.
    expect(panel).toContain("settingsRoomShown(");
    expect(panel).toContain("settingsScrollTarget(");
    expect(panel).toContain("scrollIntoView(");
    expect(panel).toContain("sectionAnchorId(scrollTo)");
  });

  it("hides the inactive pages instead of unmounting them", () => {
    // The non-functional criterion of the card: switching tabs makes no new
    // network request and remounts no store. Every sub-block here fetches on
    // mount (fleet env, stt status, allowlist, hooks, mcp), so a page rendered
    // behind `activeTab === "x" && …` would re-ask on every click.
    expect(panel).toContain('className="settings-tabpanel"');
    expect(panel).toContain("hidden={");
    for (const tab of SETTINGS_TABS) {
      expect(
        panel.includes(`activeTab === "${tab}" &&`),
        `the ${tab} page is mounted conditionally — its stores would remount on every tab switch`,
      ).toBe(false);
    }
  });

  it("keeps every section it had, each drawn exactly once", () => {
    // The hard fence: this card moves rooms, not furniture. Each section still
    // names its anchor in this file (its own heading, or the anchorId prop of
    // the component that draws it).
    for (const tab of SETTINGS_TABS) {
      for (const section of sectionsOfTab(tab)) {
        const call = `sectionAnchorId("${section}")`;
        expect(panel.includes(call), `${section} lost its anchor in the panel`).toBe(true);
      }
    }
    // The panel names no anchor the table does not hold — a section drawn under
    // no tab would be furniture in a room that was demolished.
    const named = [...panel.matchAll(/sectionAnchorId\("([^"]+)"\)/g)].map((m) => m[1] as string);
    for (const section of new Set(named)) {
      expect(tabOfSection(section as SettingsSection), `${section} is drawn under no tab`).not.toBeNull();
    }
  });

  it("takes its labels from the dictionary, through the fold", () => {
    expect(panel).toContain("{t(lang, settingsTabLabelKey(tab))}");
    // Not a hand-written key either: `t(lang, "set.tab.models")` in the row
    // would drift from the table the day a room is renamed, and an inline
    // German/English ternary would leave one of the two languages untranslated.
    expect(panel).not.toContain('"set.tab.');
    for (const tab of SETTINGS_TABS) {
      for (const lang of ["de", "en"] as const) {
        const label = dict[settingsTabLabelKey(tab)]?.[lang] ?? "";
        expect(panel, `the ${lang} label of ${tab} is written into the panel`).not.toContain(`>${label}<`);
      }
    }
  });

  it("pins the one CSS rule that decides whether hiding works at all", () => {
    // `.settings-tabpanel { display: flex }` beats the UA's `[hidden]` rule on
    // specificity, so without this line every page renders at once and the tabs
    // do nothing — visibly wrong, silently valid CSS.
    expect(css).toMatch(/\.settings-tabpanel\[hidden\]\s*\{[^}]*display:\s*none/);
    // The row scrolls rather than wraps; a second line is what AC 2 forbids.
    expect(css).toMatch(/\.settings-tabs\b[^{]*\{[^}]*flex-wrap:\s*nowrap/);
    expect(css).toMatch(/\.settings-tabs\b[^{]*\{[^}]*overflow-x:\s*auto/);
  });
});
