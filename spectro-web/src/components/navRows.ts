// The rail's nav list, as a model. No JSX, no React, no i18n lookup — the row
// says which key it wants and the renderer resolves it, so the decisions
// (which rows exist, which one is dimmed, which one owns which action) can be
// read off in a test instead of off a screenshot.
//
// One recipe serves eight rows: New chat, Scenarios, Starters and Skills at
// the top, then the three segments, then Settings at the foot. Only the first
// seven live here; the settings row has no state to decide and is written
// where it sits.

import { isOpen } from "../state/surfaces";
import type { ViewMode } from "../state/viewMode";

/** Which glyph leads a row. Names, not paths — NavIcon owns the geometry. */
export type NavIconId =
  "plus" | "play" | "stack" | "sessions" | "fleets" | "stategraph" | "browser" | "skills" | "gear";

/**
 * The row-level action a segment row carries on its right.
 *
 * <p>"count" is not an action: it is the fleet count, offered only while the
 * reader is looking at another segment. A row shows at most one of the three,
 * because two affordances in one slot is how the rail ended up with two "+
 * node" buttons at once.</p>
 */
export type NavTrailing = "import" | "spawn" | "count" | null;

export type NavActionId = "newChat" | "scenarios" | "starters" | "skills";
export type NavSegmentId = "sessions" | "fleets" | "stategraph";

export interface NavRowSpec {
  /** The row's entry in the surface table (state/surfaces.ts, card 430). */
  id: NavActionId | NavSegmentId;
  /** i18n key for the visible label. */
  labelKey: string;
  /** i18n key for the hover text, when the row has more to say than its label. */
  titleKey?: string;
  icon: NavIconId;
  /** Dimmed and unpressable, but still listed. */
  disabled: boolean;
  active: boolean;
  trailing: NavTrailing;
}

/**
 * The things the rail opens with. Buttons until now; rows from here on,
 * because a rail of boxes competes with the list underneath it for attention
 * that the list should win.
 *
 * <p>Skills joined this group with card 409 (owner, 2026-09-24): a catalogue
 * you open beside your work, the way Scenarios and Starters open, rather than
 * a segment that takes the session list down with it. It is the one row here
 * that can be active, because the view it opens stays on screen until the
 * reader opens a place.
 *
 * @param input.skillsOpen the skills view is on screen
 * @param input.mode       the window's mode; a row the surface table closes in it
 *                          is left out (card 430). Learn when absent.
 */
export function navActionRows(input: { skillsOpen: boolean; mode?: ViewMode }): NavRowSpec[] {
  const rows: NavRowSpec[] = [
    { id: "newChat", labelKey: "nav.newChat", icon: "plus", disabled: false, active: false, trailing: null },
    {
      id: "scenarios",
      labelKey: "nav.scenarios",
      titleKey: "nav.scenariosTitle",
      icon: "play",
      disabled: false,
      active: false,
      trailing: null,
    },
    {
      id: "starters",
      labelKey: "nav.starters",
      titleKey: "nav.startersTitle",
      icon: "stack",
      disabled: false,
      active: false,
      trailing: null,
    },
    {
      id: "skills",
      labelKey: "nav.skills",
      icon: "skills",
      // Not gated on the fleet lock: the view reads one endpoint and starts no
      // process, the same reasoning that leaves the state graph open.
      disabled: false,
      active: input.skillsOpen,
      trailing: null,
    },
  ];
  return rows.filter((row) => isOpen(row.id, input.mode ?? "learn"));
}

/**
 * The segments, as rows rather than as a segmented control. Each one decides
 * the list under the rail's head.
 *
 * <p>The browser row LEFT with card 228: the rail lists places you go, and the
 * browser is a thing a session has (card 218's own rule, applied to the last
 * surface that contradicted it). Its two doors are the session tab and the
 * workspace's browser card.
 *
 * <p>Skills left with card 409: as a segment it swapped the session list for
 * a note, so the reader's last session was two clicks away. It is an upper
 * row now, in {@link navActionRows}.
 *
 * @param input.active       which segment is showing
 * @param input.fleetsLocked the ladder has not opened fleets yet
 * @param input.fleetCount   how many fleets the store holds
 * @param input.mode         the window's mode; a segment the surface table
 *                           closes in it is left out (card 430). Learn when absent.
 */
export function navSegmentRows(input: {
  active: NavSegmentId;
  fleetsLocked: boolean;
  fleetCount: number;
  mode?: ViewMode;
}): NavRowSpec[] {
  const rows: NavRowSpec[] = [
    {
      id: "sessions",
      labelKey: "nav.sessions",
      icon: "sessions",
      disabled: false,
      active: input.active === "sessions",
      // Card 464: Import sits in the list's own head row now, beside the
      // list it imports into, not on this row.
      trailing: null,
    },
    {
      id: "fleets",
      labelKey: "nav.fleets",
      icon: "fleets",
      // Dimmed, never dropped: a feature nobody can see is a feature nobody
      // adopts.
      disabled: input.fleetsLocked,
      active: input.active === "fleets",
      // Spawn only where a fleet list already exists — with none, the empty
      // state below carries its own button and two would show at once.
      trailing:
        input.active === "fleets"
          ? input.fleetCount > 0
            ? "spawn"
            : null
          : input.fleetCount > 0
            ? "count"
            : null,
    },
    {
      id: "stategraph",
      labelKey: "nav.stategraph",
      icon: "stategraph",
      // Not gated on the fleet lock: the state graph reads two files off the
      // disk and starts no process, so a level has nothing to protect here.
      disabled: false,
      active: input.active === "stategraph",
      trailing: null,
    },
  ];
  return rows.filter((row) => isOpen(row.id, input.mode ?? "learn"));
}
