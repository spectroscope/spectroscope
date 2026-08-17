// Card 253: the focused row's whole description, in a popover beside the list.
//
// The row draws its description on one line and ellipsizes it, which is worst
// where it matters most: a catalogue skill puts its "use when" in the
// description, so four words and a guess were the whole basis for a pick. The
// popover is the rest of that sentence, and the row it explains is the row the
// reader is on — the picker keeps ONE focus index, and both the arrow keys and
// the mouse write it, so keyboard and hover cannot disagree.
//
// It is DECORATION, deliberately: aria-hidden and pointer-events: none. The
// listbox option already carries the same text as its own content (the truncation
// is CSS, not markup), so a reader on a screen reader hears the description from
// the row itself; a second copy beside it would be announced twice, and an
// aria-describedby on a role=option is read unevenly across screen readers. With
// nothing focusable in it and no pointer to catch, Escape and Enter stay the
// picker's own keys and hovering the list can never flicker between the row and
// the box explaining it.
//
// Where it hangs is MEASURED rather than written into a media query: the room to
// either side of the list depends on the window AND on the dock (the composer
// column is user-resizable), so the stylesheet cannot know it. See slashTipBox.

import type { CSSProperties } from "react";
import { t } from "../i18n/i18n";
import { useLang } from "../state/lang";
import type { SkillOption } from "../state/slashCommands";

/** The drawn width where there is room for it, in px. The stylesheet declares
 *  the same number as the default of --slash-tip-w, and a test pins the pair:
 *  a decision taken against a width the box is not drawn with decides nothing. */
export const SLASH_TIP_W = 320;

/** The gap between the list and the popover, in px — as the stylesheet draws it. */
export const SLASH_TIP_GAP = 8;

/** Breathing room kept against the window edge, in px. */
const SLASH_TIP_EDGE = 8;

/** Under this width the box stops being readable prose and becomes a column of
 *  syllables, so it is not drawn at all and the row's `title` is what is left.
 *  In px, and it only ever bites in a genuinely tiny window: the rail alone
 *  usually leaves more than this to the left of the list. */
export const SLASH_TIP_MIN = 200;

/** What the popover says: the focused skill and its description, unabridged. */
export interface SlashTipView {
  name: string;
  description: string;
}

/** Where the popover hangs and how wide it is drawn. */
export interface SlashTipBox {
  side: "left" | "right";
  width: number;
}

/**
 * The row the popover explains, or null when there is nothing to explain.
 *
 * @param options the matches the picker is showing
 * @param index   the focused row — the arrows move it and so does hover
 * @returns the skill's name and full description, or null
 */
export function slashTipView(options: readonly SkillOption[], index: number): SlashTipView | null {
  const skill = options[index];
  if (skill === undefined) return null;
  // A skill whose listing carries no description (an older server sends none,
  // and skillList reads that as "") would open a dark empty panel beside the
  // list, which reads as a broken popover rather than as silence.
  const description = skill.description.trim();
  if (description === "") return null;
  return { name: skill.name, description };
}

/**
 * Which side of the list has the room, and how much of it to take.
 *
 * Right is the documented side — the screenshot this card was cut from shows it
 * there, and the list reads left to right — and the flip is a last resort
 * rather than a preference. When neither side fits the box whole, it takes the
 * roomier one and shrinks to it: a flip that puts half the prose past the
 * window edge only moves the problem, and so does a box drawn 40px wide.
 *
 * Measured, because nothing in a stylesheet knows this: the list is anchored to
 * the composer column, whose width follows a user-dragged dock, and the room
 * beside it is the window minus that column's position — two numbers that move
 * independently (a wide window with a wide dock has plenty of room, a narrow
 * window with no dock has none).
 *
 * @param m the list's own left and right edge in viewport coordinates, and the
 *   window's inner width
 * @returns the side and width to draw, or null when neither side has the floor
 */
export function slashTipBox(m: {
  popLeft: number;
  popRight: number;
  viewportWidth: number;
}): SlashTipBox | null {
  const roomRight = m.viewportWidth - SLASH_TIP_EDGE - (m.popRight + SLASH_TIP_GAP);
  const roomLeft = m.popLeft - SLASH_TIP_GAP - SLASH_TIP_EDGE;
  if (roomRight >= SLASH_TIP_W) return { side: "right", width: SLASH_TIP_W };
  if (roomLeft >= SLASH_TIP_W) return { side: "left", width: SLASH_TIP_W };
  const side = roomLeft > roomRight ? "left" : "right";
  const room = Math.floor(Math.max(roomLeft, roomRight));
  if (room < SLASH_TIP_MIN) return null;
  return { side, width: room };
}

export function SlashTip(props: { view: SlashTipView; box: SlashTipBox }) {
  const lang = useLang();
  return (
    <div
      className={`wsg-pop slash-tip slash-tip--${props.box.side}`}
      style={{ "--slash-tip-w": `${props.box.width}px` } as CSSProperties}
      aria-hidden="true"
    >
      <div className="settings-label">{t(lang, "slash.about")}</div>
      <p className="slash-tip-name mono">{props.view.name}</p>
      <p className="slash-tip-text">{props.view.description}</p>
    </div>
  );
}
