// Card 256: where the READER stands in the settings — which room is on screen,
// and whether the deep link that opened the panel has been served yet.
//
// This is the position, not the furniture: the grouping table next door says
// which room a section stands in, and nothing here knows what a setting does.
// It lives apart from React so a whole visit can be folded in a test: a run of
// the panel is a sequence of ADDRESS events (what the panel is asked to show)
// and PICK events (what the reader clicked), and the room is a pure function of
// the two.
//
// THE DEFECT THIS EXISTS TO CLOSE (found by review after the build): the room a
// reader picked by hand was remembered against the address it was picked under,
// and that address REPEATS — `open:mcp` is the same string every time that one
// deep link opens the panel. So a pick from the previous visit matched again and
// outranked the very link that had just been followed: the reader landed in the
// wrong room, and the scroll went silent on top, because `scrollIntoView` on an
// anchor inside a `display:none` page does nothing and still marks itself done.

import { type SettingsSection } from "../state/route";
import { settingsTabFor, tabOfSection, type SettingsTab } from "./settingsTabs";

/**
 * What the panel remembers between renders: the room the reader picked by hand,
 * and the address it was picked under.
 */
export type SettingsRoomState = {
  /** The address this memory belongs to. */
  readonly address: string;
  /** The room the reader chose by hand under that address, or null. */
  readonly picked: SettingsTab | null;
};

/** Closed, with nothing remembered. */
export const SETTINGS_ROOM_START: SettingsRoomState = { address: "closed:", picked: null };

/**
 * What the panel is being asked to show, as one string — spelled here and
 * nowhere else, so the fold and the panel cannot drift apart.
 *
 * @param open    whether the surface is open
 * @param section the section a deep link named, or nothing
 * @return the address
 */
export function settingsAddress(open: boolean, section?: SettingsSection | null): string {
  return `${open ? "open" : "closed"}:${section ?? ""}`;
}

/**
 * The memory after the panel has been asked to show `address`.
 *
 * A moved address ENDS the visit: whatever room the reader had wandered into is
 * forgotten. That is the whole fix — closing walks the address through
 * `closed:`, so the pick is gone before the next open can be asked for, and the
 * repeat of a deep link meets an empty memory instead of a matching one.
 *
 * Returns the SAME object when the address has not moved: the panel steps this
 * from an effect that runs on every render, and a fresh object each time would
 * be a render loop.
 *
 * @param state   what was remembered
 * @param address what is asked for now
 * @return the memory to keep — the same object when nothing moved
 */
export function settingsRoomAt(state: SettingsRoomState, address: string): SettingsRoomState {
  if (state.address === address) return state;
  return { address, picked: null };
}

/**
 * The memory after the reader clicked a room. Stamped with the address he
 * clicked it under: a pick means "this room, on this visit", never "this room
 * from now on".
 *
 * @param address what the panel was showing when he clicked
 * @param tab     the room he clicked
 * @return the memory to keep
 */
export function settingsRoomPick(address: string, tab: SettingsTab): SettingsRoomState {
  return { address, picked: tab };
}

/**
 * The room to draw.
 *
 * @param state   what the panel remembers
 * @param address what it is being asked to show
 * @param section the section a deep link named, or nothing
 * @return the room
 */
export function settingsRoomShown(
  state: SettingsRoomState,
  address: string,
  section?: SettingsSection | null,
): SettingsTab {
  if (state.address === address && state.picked !== null) return state.picked;
  return settingsTabFor(section);
}

/**
 * The section whose anchor may be scrolled to right now — and therefore the only
 * section whose deep link may be marked served.
 *
 * Null while the section's room is not the one on screen. The anchor is IN the
 * document either way (inactive rooms are hidden, not unmounted, so their
 * fetches do not re-run on every tab click), and `scrollIntoView` on an element
 * inside a `display:none` page moves nothing while reporting nothing — a caller
 * that marked the link served on the strength of finding the anchor burned the
 * one chance it had.
 *
 * Null too for a section this page does not draw: card 228 moved the skills
 * manager to the rail, so `#/settings/skills` has no anchor to seek here.
 *
 * @param room    the room on screen
 * @param section the section a deep link named, or nothing
 * @return the section, or null when there is nothing to scroll to here
 */
export function settingsScrollTarget(
  room: SettingsTab,
  section?: SettingsSection | null,
): SettingsSection | null {
  if (section == null) return null;
  return tabOfSection(section) === room ? section : null;
}
