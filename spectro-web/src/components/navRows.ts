// The rail's nav list, as a model. No JSX, no React, no i18n lookup — the row
// says which key it wants and the renderer resolves it, so the decisions
// (which rows exist, which one is dimmed, which one owns which action) can be
// read off in a test instead of off a screenshot.
//
// One recipe serves seven rows: New chat, Scenarios and Starters at the top,
// then the three segments, then Settings at the foot. Only the first six live
// here; the settings row has no state to decide and is written where it sits.

/** Which glyph leads a row. Names, not paths — NavIcon owns the geometry. */
export type NavIconId = "plus" | "play" | "stack" | "sessions" | "fleets" | "stategraph" | "browser" | "gear";

/**
 * The row-level action a segment row carries on its right.
 *
 * <p>"count" is not an action: it is the fleet count, offered only while the
 * reader is looking at another segment. A row shows at most one of the three,
 * because two affordances in one slot is how the rail ended up with two "+
 * node" buttons at once.</p>
 */
export type NavTrailing = "import" | "spawn" | "count" | null;

export type NavActionId = "newChat" | "scenarios" | "starters";
export type NavSegmentId = "sessions" | "fleets" | "stategraph" | "browser";

export interface NavRowSpec {
  id: string;
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
 * The three things the rail opens with. Buttons until now; rows from here on,
 * because a rail of boxes competes with the list underneath it for attention
 * that the list should win.
 */
export function navActionRows(): NavRowSpec[] {
  return [
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
  ];
}

/**
 * The segments, as rows rather than as a segmented control.
 *
 * <p>Browser is the fourth (card 201). It is listed on every face, including the
 * one that cannot show a pane: the segment's own panel says why there is nothing
 * behind it, and a row that vanished on the web face would leave a reader
 * wondering whether the product has a browser at all.
 *
 * @param input.active       which segment is showing
 * @param input.fleetsLocked the ladder has not opened fleets yet
 * @param input.fleetCount   how many fleets the store holds
 */
export function navSegmentRows(input: {
  active: NavSegmentId;
  fleetsLocked: boolean;
  fleetCount: number;
}): NavRowSpec[] {
  return [
    {
      id: "sessions",
      labelKey: "nav.sessions",
      icon: "sessions",
      disabled: false,
      active: input.active === "sessions",
      // Import belongs to the list it imports into, so it is only offered
      // while that list is the one on screen.
      trailing: input.active === "sessions" ? "import" : null,
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
    {
      id: "browser",
      labelKey: "nav.browser",
      icon: "browser",
      // Not gated on the fleet lock either: the browser starts no fleet and
      // spawns no node. What bounds it is the net fence and the tier map.
      disabled: false,
      active: input.active === "browser",
      trailing: null,
    },
  ];
}
