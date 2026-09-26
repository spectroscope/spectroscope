// Card 381: what the one box at the top of the settings page searches.
//
// THE MANIFEST IS DERIVED. Three sources feed it and none of them is written
// here: the grouping table next door (which section stands in which room), the
// reach table (every saveable key, less the ones another surface draws), and
// the generated registry that arrives over /api/governing-numbers. A fourth
// source typed in this file would be the hand-list this house has paid for
// repeatedly, and the guard beside it demands coverage of all three rather
// than checking a copy against itself.
//
// FOUR TABLES ARE AUTHORED HERE, and it is worth saying exactly why that is
// not the same thing. None invents an entry; each answers a question no
// existing data answers, and each is checked against a different source:
//
//  - SETTINGS_SECTION_LABEL_KEY: the heading a section draws. The seventeen
//    headings use six different key shapes (`set.secDesign`,
//    `leveling.settings.title`, `mcpset.title`, `set.machine` and so on), so
//    there is no rule to compute. The guard demands one entry per section of
//    SETTINGS_TAB_SECTIONS and demands the dictionary really carry each key.
//  - SECTION_SETTING_KEYS: which section a saveable key is drawn in. The reach
//    table says WHEN a key lands and never WHERE, and the five components that
//    draw fields receive their anchor as a prop, so the section cannot be read
//    off a field's surroundings. The guard demands that the flattened table
//    plus OFF_PAGE_SETTING_KEYS equal the reach table exactly, so a new key
//    that nobody placed turns red before the search can quietly drop it, and
//    that a reach block on the settings page draws every key filed here.
//  - OFF_PAGE_SETTING_KEYS: the saveable keys whose control stands outside
//    the settings page, with the component that draws it. Card 379 put the
//    first one in the reach table: the rtk switch, which the owner placed at
//    the bottom of the composer's settings menu. A hit opens a room and
//    scrolls to a section, and no room draws that switch, so the search finds
//    none of these keys. The guard demands that each named component draws
//    the key and stands outside the page's imports, and that the page does
//    not draw the key too.
//  - SETTING_FIELD_LABEL_EXCEPTIONS (card 394, wave H3d): the name a field
//    draws beside its control, for the fields where that name is not the dict
//    key `set.<key>`, or where the field draws none. The name is drawn in JSX
//    and no data carries it. settingsSearchNames.test.ts demands that every
//    field of the placement table resolves through the rule or this table,
//    that this table holds no entry the rule gives anyway, and that each name
//    is drawn inside the reach block that names the field, read off the page
//    source.
//
// A cross-room hit POINTS at a section, it does not narrow the page. The
// limits room's old box removed rows from the DOM, which is a sensible thing
// to do to a list on screen and the wrong thing to do to five rooms that are
// not.

import { dict, t, type Lang } from "../i18n/i18n";
import {
  SETTINGS_TABS,
  SETTINGS_TAB_SECTIONS,
  sectionAnchorId,
  sectionsOfTab,
  type PanelSection,
  type SettingsTab,
} from "./settingsTabs";
import type { SettingKey } from "./settingsReach";
import { ownerSimpleName, type GoverningNumber } from "../state/governingNumbers";

/** What a result row IS: a section heading, a saveable field, or a row of the
 *  governing-numbers reference list. A value and not just a type, so the guard
 *  can walk it: a fourth origin added without its word would otherwise ship as
 *  a result row labelled with a raw dict key. */
export const SETTINGS_HIT_ORIGINS = ["section", "field", "number"] as const;
export type SettingsHitOrigin = (typeof SETTINGS_HIT_ORIGINS)[number];

/** The dict key of an origin's word. Spelled here rather than at the call
 *  site, so the guard and the component read the same rule. */
export function settingsHitKindKey(origin: SettingsHitOrigin): string {
  return `set.search${origin.charAt(0).toUpperCase()}${origin.slice(1)}`;
}

/** One searchable thing on the settings page, and where it stands. */
export interface SettingsHit {
  /** Stable across renders, and unique: the result list keys on it. */
  readonly id: string;
  readonly origin: SettingsHitOrigin;
  /** The room to open. */
  readonly tab: SettingsTab;
  /** The section to scroll to. */
  readonly section: PanelSection;
  /** The dict key of that section's heading. */
  readonly labelKey: string;
  /** That heading, as the reader sees it. */
  readonly label: string;
  /** What the result row names. */
  readonly title: string;
  /** The settings key, empty when the entry has none. */
  readonly key: string;
  /** Prose that matches too: the code's own words about a number. */
  readonly note: string;
  /** The registry row, when this entry is one. */
  readonly number: GoverningNumber | null;
}

/** The heading each section draws. */
export const SETTINGS_SECTION_LABEL_KEY = {
  design: "set.secDesign",
  language: "set.secLanguage",
  leveling: "leveling.settings.title",
  session: "set.secSession",
  stt: "set.secStt",
  websearch: "set.secWebSearch",
  machine: "set.machine",
  mcp: "mcpset.title",
  allowlist: "set.secAllowlist",
  netfence: "set.secNetFence",
  hooks: "set.secHooks",
  progress: "set.secProgress",
  fleet: "set.secFleet",
  observability: "set.secObservability",
  workspace: "set.secWorkspace",
  logging: "set.secLogging",
  limits: "set.secLimits",
} as const satisfies Record<PanelSection, string>;

/** Which section draws each saveable key. */
export const SECTION_SETTING_KEYS = {
  // The dock's two widths stand beside Design and share its heading.
  design: ["chatReserveWidth", "dockMaxWidth"],
  session: [
    "provider",
    "model",
    "ollamaBaseUrl",
    "lmstudioBaseUrl",
    "llamacppBaseUrl",
    "thinking",
    "imageProvider",
    "imageModel",
  ],
  stt: ["sttProvider", "sttLanguage"],
  websearch: ["searxngUrl"],
  machine: ["chromeBinary", "sttModel"],
  mcp: ["skills", "mcpServers", "headlessMcp"],
  allowlist: ["autoApprove"],
  netfence: ["allowLocalhost"],
  hooks: ["hooks"],
  progress: [
    "progressGuardWrites",
    "progressGuardFailures",
    "progressGuardPlanTurns",
    "maxTurns",
    "subagentBudgetSeconds",
    "subagentBudgetTokens",
    "maxTokens",
    "commandTimeoutSeconds",
    "continuationBudget",
    "questionsPerRun",
    "maxQuestionOptions",
    "maxQuestionChars",
  ],
  observability: ["otlpEndpoint", "otlpBasicAuth"],
  workspace: ["workspace"],
  logging: ["logLevel"],
} as const satisfies Partial<Record<PanelSection, readonly SettingKey[]>>;

/** A settings key the page draws a field for. */
type PageSettingKey = (typeof SECTION_SETTING_KEYS)[keyof typeof SECTION_SETTING_KEYS][number];

/** Card 394, wave H3d: the fields whose name on the page is not `set.<key>`,
 *  with the dict key of the name they draw. null: the field draws no name of
 *  its own, and the section heading on its row is what the reader sees. */
export const SETTING_FIELD_LABEL_EXCEPTIONS = {
  // One address field stands under the provider, for the provider picked.
  ollamaBaseUrl: "set.address",
  lmstudioBaseUrl: "set.address",
  llamacppBaseUrl: "set.address",
  imageProvider: "set.imageBackend",
  chromeBinary: "set.chrome",
  otlpBasicAuth: "set.otlpAuth",
  progressGuardWrites: "set.progress.progressGuardWrites",
  progressGuardFailures: "set.progress.progressGuardFailures",
  progressGuardPlanTurns: "set.progress.progressGuardPlanTurns",
  headlessMcp: "mcpset.headlessLabel",
  workspace: null,
  autoApprove: null,
  hooks: null,
  skills: null,
  mcpServers: null,
} as const satisfies Partial<Record<PageSettingKey, string | null>>;

/**
 * The dict key of the name the page draws beside a field.
 *
 * @param key a settings key
 * @return the listed name when the key is listed, else `set.<key>` when the
 *         dictionary carries it; null when the field draws no name of its own;
 *         undefined when neither answers, which settingsSearchNames.test.ts
 *         refuses for every field of the page
 */
export function settingFieldLabelKey(key: string): string | null | undefined {
  if (Object.hasOwn(SETTING_FIELD_LABEL_EXCEPTIONS, key)) {
    return (SETTING_FIELD_LABEL_EXCEPTIONS as Record<string, string | null>)[key];
  }
  const rule = `set.${key}`;
  return Object.hasOwn(dict, rule) ? rule : undefined;
}

/** Which component outside the settings page draws each saveable key the page
 *  does not. The manifest carries no field for these. */
export const OFF_PAGE_SETTING_KEYS = {
  // Card 379: the last section of the composer's settings menu.
  rtkFilter: "RtkFilterSection.tsx",
} as const satisfies Partial<Record<SettingKey, string>>;

/** The room a section stands in, read off the grouping table. */
function tabOf(section: string): SettingsTab {
  const tab = SETTINGS_TABS.find((one) => (sectionsOfTab(one) as readonly string[]).includes(section));
  if (tab === undefined) {
    throw new Error(`${section} stands in no room: SETTINGS_TAB_SECTIONS and this module disagree`);
  }
  return tab;
}

/**
 * Everything the box can find, in the order the page draws it: the rooms and
 * their sections first, then the saveable keys of each section, then the
 * reference rows.
 *
 * @param lang    the reader's language, for the headings
 * @param numbers the registry, empty while it is still on its way
 * @return the manifest
 */
export function buildSettingsManifest(lang: Lang, numbers: readonly GoverningNumber[]): SettingsHit[] {
  const out: SettingsHit[] = [];
  const keysOf = SECTION_SETTING_KEYS as Record<string, readonly string[] | undefined>;
  for (const tab of SETTINGS_TABS) {
    for (const section of sectionsOfTab(tab)) {
      const labelKey = SETTINGS_SECTION_LABEL_KEY[section];
      const label = t(lang, labelKey);
      out.push({
        id: `section:${section}`,
        origin: "section",
        tab,
        section,
        labelKey,
        label,
        title: label,
        key: "",
        note: "",
        number: null,
      });
      for (const key of keysOf[section] ?? []) {
        const nameKey = settingFieldLabelKey(key);
        out.push({
          id: `field:${key}`,
          origin: "field",
          tab,
          section,
          labelKey,
          label,
          // Card 394, wave H3d: the name the page draws beside the field, in
          // the reader's language, so the box finds what the reader sees.
          title: typeof nameKey === "string" ? `${t(lang, nameKey)} · ${key}` : key,
          key,
          note: "",
          number: null,
        });
      }
    }
  }
  const limitsTab = tabOf("limits");
  const limitsLabel = t(lang, SETTINGS_SECTION_LABEL_KEY.limits);
  for (const number of numbers) {
    out.push({
      id: `number:${number.owner}#${number.field}`,
      origin: "number",
      tab: limitsTab,
      section: "limits",
      labelKey: SETTINGS_SECTION_LABEL_KEY.limits,
      label: limitsLabel,
      title: `${ownerSimpleName(number.owner)}.${number.field}`,
      key: number.key,
      // The same five parts the limits box already matched on, so a reader who
      // learned that box finds the same behaviour at the top of the page.
      note: `${number.owner} ${number.value} ${number.explanation}`,
      number,
    });
  }
  return out;
}

/** Everything about one entry a query is held against, lowercased once. */
export function settingsSearchHaystack(hit: SettingsHit): string {
  return `${hit.title} ${hit.label} ${hit.key} ${hit.note}`.toLowerCase();
}

/**
 * The entries a query leaves standing, in manifest order.
 *
 * Two registry rows carry the same settings key (`maxTurns`, on `Agent` and on
 * `SpectroConfig`), and both are returned: the registry is the source, the room
 * draws both, and the search does not invent a merge the data does not have.
 *
 * @param manifest what the page can find
 * @param query    what was typed; blank shows everything
 * @return the matches
 */
export function matchSettings(manifest: readonly SettingsHit[], query: string): SettingsHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...manifest];
  return manifest.filter((hit) => settingsSearchHaystack(hit).includes(needle));
}

/** The anchor a result scrolls to: the SAME id a deep link already uses, so
 *  the page keeps one id scheme and not two. */
export function settingsHitAnchorId(hit: SettingsHit): string {
  return sectionAnchorId(hit.section);
}

/**
 * What a click on a result does: open the hit's room, then scroll to its
 * section's anchor. The panel hands in its own room picker and scroller, so a
 * test can watch both effects without a DOM.
 *
 * @param hit            the result that was clicked
 * @param pickTab        opens a room
 * @param scrollToAnchor brings the element with this id into view
 */
export function openSettingsHit(
  hit: SettingsHit,
  pickTab: (tab: SettingsTab) => void,
  scrollToAnchor: (anchor: string) => void,
): void {
  pickTab(hit.tab);
  scrollToAnchor(settingsHitAnchorId(hit));
}

/**
 * The scroller the panel hands to {@link openSettingsHit}. It waits a frame
 * because the room it points into is hidden until the room switch renders,
 * and scrollIntoView on a hidden element moves nothing and reports nothing.
 *
 * @param anchor the id of the section to bring into view
 */
export function scrollToSettingsAnchor(anchor: string): void {
  window.requestAnimationFrame(() => {
    document.getElementById(anchor)?.scrollIntoView({ block: "start" });
  });
}

/** Every section of the page, in draw order. Exported for the guard, which
 *  would otherwise flatten the grouping table a second time. */
export const SETTINGS_SECTIONS_IN_ORDER: readonly PanelSection[] = SETTINGS_TABS.flatMap(
  (tab) => SETTINGS_TAB_SECTIONS[tab] as readonly PanelSection[],
);
