// Card 256: which room each settings section stands in.
//
// The settings page was one scroll of nineteen blocks, and the owner's ask was
// rooms instead of a sausage. The grouping that does it is DATA — this one
// table — and not six copies of a layout: every section keeps its controls, its
// store and its wording, and the panel draws each one exactly once inside the
// page named here. Nothing in this module knows what a setting DOES; it only
// knows where it stands.
//
// The table is typed against the route vocabulary, so a room cannot name a
// section that is not an address. The other half — that every address has a
// room — is counted by the guard beside this file, because TypeScript has no
// way to demand that a record's values cover a union.

import { type SettingsSection } from "../state/route";

/**
 * The rooms, in the order the row draws them.
 *
 * Six, in the shape of the owner's reference (Goose: Models · Chat · Session ·
 * Prompts · Keyboard · App): a handful of short pages, each one a thing a
 * person came to change. `mcp` stands alone because the server list grows —
 * folded into `tools` it made the tallest page on the surface, which is the
 * defect this card removes.
 */
export const SETTINGS_TABS = ["general", "models", "tools", "mcp", "permissions", "system"] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** Where a plain open (no section named) lands. */
export const DEFAULT_SETTINGS_TAB: SettingsTab = "general";

/**
 * Sections that own an address but no longer stand on this page: card 228 moved
 * the skills manager to the rail's own Skills view, and App.tsx redirects both
 * old hashes there before this panel ever opens.
 *
 * Listed rather than dropped, so "every section has exactly one home" stays a
 * sentence a test can check — a room for them here would draw an empty page
 * under a label promising a manager.
 */
export const RELOCATED_SECTIONS = ["skills", "skills-catalogue"] as const;
export type RelocatedSection = (typeof RELOCATED_SECTIONS)[number];

/** A section this page draws. */
export type PanelSection = Exclude<SettingsSection, RelocatedSection>;

/**
 * The grouping. Order inside a room is the order the page draws it, which is
 * also the order it had before this card — the sections moved between rooms,
 * never past each other.
 */
export const SETTINGS_TAB_SECTIONS = {
  // What the app looks like and how much of the ladder it shows: the two
  // browser-local stores plus leveling's mode. Nothing here reaches a session.
  general: ["design", "language", "leveling"],
  // The session defaults, and with them the reasoning control and the image
  // pair — the whole answer to "which model answers me, and how".
  models: ["session"],
  // The tools that reach outside this process, and the two machine paths they
  // read: the local STT model beside the speech section that downloads it,
  // browse_page's browser binary beside the search it serves.
  tools: ["stt", "websearch", "machine"],
  // Its own room: the server list is unbounded, and it is the one page whose
  // height is the operator's own doing.
  mcp: ["mcp"],
  // The surfaces that decide what runs without being asked — and, since card
  // 281, the one that decides what must come BACK to a person. The room's
  // German label stays "Freigaben"; the section heading carries the difference,
  // so card 256's grouping stays a pure move.
  permissions: ["allowlist", "netfence", "hooks", "progress"],
  // Where this installation points: the fleet hub, the trace sink, the default
  // workspace, the log level.
  system: ["fleet", "observability", "workspace", "logging"],
} as const satisfies Record<SettingsTab, readonly PanelSection[]>;

/**
 * The sections of one room.
 *
 * @param tab the room
 * @return its sections, in draw order
 */
export function sectionsOfTab(tab: SettingsTab): readonly PanelSection[] {
  return SETTINGS_TAB_SECTIONS[tab];
}

/**
 * The room a section stands in.
 *
 * @param section a section from the route vocabulary, or nothing
 * @return the room, or null when this page does not draw that section (the
 *         relocated ones, and anything a future vocabulary adds without a room)
 */
export function tabOfSection(section: SettingsSection | null | undefined): SettingsTab | null {
  if (section == null) return null;
  return SETTINGS_TABS.find((tab) => (sectionsOfTab(tab) as readonly string[]).includes(section)) ?? null;
}

/**
 * The room to open for a deep link — card 224's callers hand over a section,
 * not a tab.
 *
 * Total on purpose, in the card-81 direction: an address this page cannot place
 * lands on a real page rather than on a blank one.
 *
 * @param section the section a hash or a menu row named, or nothing
 * @return the room to select
 */
export function settingsTabFor(section: SettingsSection | null | undefined): SettingsTab {
  return tabOfSection(section) ?? DEFAULT_SETTINGS_TAB;
}

/**
 * The neighbouring room, wrapping — the row has no dead end, which is what the
 * arrow keys of a tablist promise.
 *
 * @param tab   the room in view
 * @param delta how far to move, negative for left
 * @return the room to select
 */
export function stepSettingsTab(tab: SettingsTab, delta: number): SettingsTab {
  const at = SETTINGS_TABS.indexOf(tab);
  const n = SETTINGS_TABS.length;
  return SETTINGS_TABS[(((at + delta) % n) + n) % n] as SettingsTab;
}

/** The dict key of a room's label. The label is never written in the panel:
 *  a tab row with an inline language ternary is two labels nobody translated. */
export function settingsTabLabelKey(tab: SettingsTab): string {
  return `set.tab.${tab}`;
}

/** The id of a room's tab button — what its page points at with
 *  `aria-labelledby`. */
export function settingsTabButtonId(tab: SettingsTab): string {
  return `settings-tab-${tab}`;
}

/** The id of a room's page — what its tab points at with `aria-controls`.
 *  Deliberately distinct from the panel's `settings-sec-*` anchors: both
 *  live inside this one panel, and a duplicate id would send a deep link's
 *  scrollIntoView at a tab button. */
export function settingsTabPanelId(tab: SettingsTab): string {
  return `settings-page-${tab}`;
}
