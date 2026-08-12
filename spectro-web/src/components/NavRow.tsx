// One row, used seven times: New chat, Scenarios, Starters, the three
// segments, and Settings at the foot.
//
// It is still a <button> — the rail's controls are pressed, and a div with an
// onClick is a control only a mouse can find. What it stops being is a BOX: no
// border, no fill, no chrome, the same rail-marker idiom as .session-row, so
// the list underneath wins the attention it should win.
//
// `role` exists for exactly one caller: the segment group keeps role="tablist"
// and its rows keep role="tab" with aria-selected. Losing the button box must
// not lose the semantics.

import type { ReactNode } from "react";
import type { NavIconId } from "./navRows";

export function NavRow(props: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  title?: string;
  /** Row-level action on the right — Import, "+ node", a count. */
  trailing?: ReactNode;
  /** Dimmed and unpressable, but still listed. */
  disabled?: boolean;
  role?: "tab";
  ariaSelected?: boolean;
}) {
  return (
    <button
      type="button"
      role={props.role}
      aria-selected={props.role === "tab" ? props.ariaSelected === true : undefined}
      aria-disabled={props.disabled === true ? true : undefined}
      className={`nav-row${props.active === true ? " active" : ""}${props.disabled === true ? " is-locked" : ""}`}
      title={props.title}
      onClick={() => {
        if (props.disabled !== true) props.onClick();
      }}
    >
      <span className="nav-row-icon">{props.icon}</span>
      <span className="nav-row-label">{props.label}</span>
      {props.trailing !== undefined && props.trailing !== null && (
        <span className="nav-row-trailing">{props.trailing}</span>
      )}
    </button>
  );
}

/**
 * The rail's glyphs. One geometry family: a 16px box, single-weight strokes,
 * currentColor, no fills and no per-row tint — colour lives on lines here, and
 * a tinted icon per segment would be six colours arguing in one column.
 */
export function NavIcon({ id }: { id: NavIconId }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[id]}
    </svg>
  );
}

/** Geometry per glyph, in the shared 16px box. */
const PATHS: Record<NavIconId, ReactNode> = {
  // The plus the New chat button already wore.
  plus: <path d="M8 2v12M2 8h12" />,
  // The play triangle the scenario rows already wear, stroked rather than filled.
  play: <path d="M5 3.2v9.6L12.6 8z" />,
  // A stack of ready-made things.
  stack: (
    <>
      <path d="M8 2.2 13.6 5 8 7.8 2.4 5z" />
      <path d="M2.4 8 8 10.8 13.6 8" />
      <path d="M2.4 11 8 13.8 13.6 11" />
    </>
  ),
  // A list of runs.
  sessions: <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />,
  // A hub with its nodes hanging off it.
  fleets: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v3.9M3.5 12.4l2.9-2.9M12.5 12.4l-2.9-2.9" />
    </>
  ),
  // Two nodes and the edge between them.
  stategraph: (
    <>
      <rect x="2" y="2.4" width="5.2" height="4" rx="1" />
      <rect x="8.8" y="9.6" width="5.2" height="4" rx="1" />
      <path d="M4.6 6.4v3.6a1.6 1.6 0 0 0 1.6 1.6h2.6" />
    </>
  ),
  // The same gear the header wears, redrawn in this box: one door's icon must
  // not be a different picture from the other's.
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8M3.3 3.3l1.3 1.3M11.4 11.4l1.3 1.3M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3" />
    </>
  ),
};
